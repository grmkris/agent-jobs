// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {FactoryToken} from "../src/FactoryToken.sol";
import {MockPaymentToken} from "../src/MockPaymentToken.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev Drives random lifecycles in both modes, including the adversarial calls straight at the core, and
///      records the facts the contracts cannot tell us afterwards: rulings and which side was slashed.
contract Handler is Test {
    FactoryToken internal factory;
    MockPaymentToken internal pay;
    ERC8183 internal core;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;
    address internal creator;
    address internal worker;
    address internal arbitrator;

    uint256[] public jobs;
    mapping(uint256 jobId => bool) public ruledForWorker;
    mapping(uint256 jobId => bool) public creatorSlashed;
    mapping(uint256 jobId => bool) public workerSlashed;
    uint256 public payMinted;
    uint256 public factoryMintedCreator;
    uint256 public factoryMintedWorker;

    constructor(
        FactoryToken factory_,
        MockPaymentToken pay_,
        ERC8183 core_,
        JobHolding holding_,
        JobsEvaluator evaluator_,
        address creator_,
        address worker_,
        address arbitrator_
    ) {
        factory = factory_;
        pay = pay_;
        core = core_;
        holding = holding_;
        evaluator = evaluator_;
        creator = creator_;
        worker = worker_;
        arbitrator = arbitrator_;
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return jobs[seed % jobs.length];
    }

    modifier withJobs() {
        if (jobs.length == 0) return;
        _;
    }

    function publish(uint96 reward, uint96 creatorBond, uint96 workerBond, bool contest) external {
        reward = uint96(bound(reward, 1, 1_000e6));
        creatorBond = uint96(bound(creatorBond, 0, 100e18));
        workerBond = uint96(bound(workerBond, 0, 100e18));
        pay.mint(creator, reward);
        payMinted += reward;
        factory.mint(creator, creatorBond);
        factoryMintedCreator += creatorBond;
        factory.mint(worker, workerBond);
        factoryMintedWorker += workerBond;

        uint48 dd = uint48(block.timestamp + 7 days);
        JobHolding.PublishParams memory p = JobHolding.PublishParams({
            manifestHash: keccak256(abi.encode(reward, jobs.length)),
            token: IERC20(address(pay)),
            reward: reward,
            creatorBond: creatorBond,
            workerBond: workerBond,
            deliveryDeadline: dd,
            expiredAt: dd + evaluator.settlementWindow(),
            mode: contest ? JobHolding.Mode.Contest : JobHolding.Mode.HireFirst,
            selectionDeadline: contest ? uint48(block.timestamp + 2 days) : 0
        });
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        jobs.push(jobId);
    }

    function assignOrSelect(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        (,,, JobHolding.Mode mode,,,,,,,,,,,) = holding.listings(jobId);
        vm.prank(creator);
        if (mode == JobHolding.Mode.Contest) {
            try holding.select(jobId, worker, 1) {} catch {}
        } else {
            try holding.assign(jobId, worker, 1) {} catch {}
        }
    }

    function postBond(uint256 seed) external withJobs {
        vm.prank(worker);
        try holding.postWorkerBond(_pick(seed)) {} catch {}
    }

    function setBudget(uint256 seed, bool exactAmount) external withJobs {
        uint256 jobId = _pick(seed);
        (,,,,,,,,,,, uint256 reward,,,) = holding.listings(jobId);
        vm.prank(worker);
        try core.setBudget(jobId, address(pay), exactAmount ? reward : reward + 1, "") {} catch {}
    }

    function fund(uint256 seed) external withJobs {
        try holding.fundAfterAccept(_pick(seed)) {} catch {}
    }

    function submit(uint256 seed) external withJobs {
        vm.prank(worker);
        try core.submit(_pick(seed), keccak256("d"), "") {} catch {}
    }

    function creatorAccept(uint256 seed) external withJobs {
        vm.prank(creator);
        try evaluator.accept(_pick(seed)) {} catch {}
    }

    function creatorReject(uint256 seed) external withJobs {
        vm.prank(creator);
        try evaluator.creatorReject(_pick(seed)) {} catch {}
    }

    function dispute(uint256 seed) external withJobs {
        vm.prank(worker);
        try evaluator.dispute(_pick(seed)) {} catch {}
    }

    function rule(uint256 seed, bool forWorker, bool slash) external withJobs {
        uint256 jobId = _pick(seed);
        vm.prank(arbitrator);
        try evaluator.rule(jobId, forWorker, slash) {
            if (forWorker) ruledForWorker[jobId] = true;
            if (slash && forWorker) creatorSlashed[jobId] = true;
            if (slash && !forWorker) workerSlashed[jobId] = true;
        } catch {}
    }

    function cancel(uint256 seed) external withJobs {
        vm.prank(creator);
        try holding.cancel(_pick(seed)) {} catch {}
    }

    function withdraw(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        vm.prank(creator);
        try holding.withdraw(jobId) {} catch {}
        vm.prank(worker);
        try holding.withdrawWorkerBond(jobId) {} catch {}
    }

    /// @dev Time passes, then every permissionless path is tried by a stranger, plus the two adversarial calls
    ///      a provider could make straight at the core.
    function timeouts(uint256 seed, uint32 secondsForward) external withJobs {
        vm.warp(block.timestamp + bound(secondsForward, 0, 20 days));
        uint256 jobId = _pick(seed);
        try evaluator.completeAfterSilence(jobId) {} catch {}
        try evaluator.rejectAfterWindow(jobId) {} catch {}
        try evaluator.refundAfterArbitrationTimeout(jobId) {} catch {}
        try evaluator.rejectAfterDeliveryDeadline(jobId) {} catch {}
        try holding.expireContest(jobId) {} catch {}
        try core.claimRefund(jobId) {} catch {}
        vm.prank(worker);
        try core.submitClaim(jobId, 1, keccak256("claim"), "") {} catch {}
    }
}

/// @dev Balance equations over both assets. Together they state: every unit of payment token deposited is in
///      exactly one of the creator's wallet, the worker's wallet, Holding or the core; every unit of FACTORY
///      bonded is in its owner's wallet, in Holding, or burned; the reward reaches the worker only through
///      `complete`; a bond is burned only by a ruling that found a violation; nothing pays twice.
contract InvariantsTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(factory, pay, core, holding, evaluator, creator, worker, arbitrator);
        // The handler mints per publish; drain the setUp balances so the equations are exact. Both wallets
        // keep exactly MIN_HOLD of FACTORY, which the hold gate reads and the equations exclude.
        uint256 c = pay.balanceOf(creator);
        vm.prank(creator);
        pay.transfer(address(0xdead), c);
        uint256 cf = factory.balanceOf(creator) - MIN_HOLD;
        vm.prank(creator);
        factory.transfer(address(0xdead), cf);
        uint256 wf = factory.balanceOf(worker) - MIN_HOLD;
        vm.prank(worker);
        factory.transfer(address(0xdead), wf);
        targetContract(address(handler));
    }

    function invariant_balancesPartitionEveryDeposit() public view {
        uint256 expectCreatorPay;
        uint256 expectWorkerPay;
        uint256 expectHoldingPay;
        uint256 expectCorePay;
        uint256 expectCreatorFactory = MIN_HOLD;
        uint256 expectWorkerFactory = MIN_HOLD;
        uint256 expectHoldingFactory;
        uint256 expectBurned;
        uint256 payDeposits;
        uint256 creatorBondDeposits;
        uint256 workerBondDeposits;

        uint256 n = handler.jobCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 jobId = handler.jobs(i);
            JobHolding.Listing memory l = listing(jobId);
            ERC8183.JobStatus s = status(jobId);
            payDeposits += l.reward;
            creatorBondDeposits += l.creatorBond;
            if (l.workerBondPosted) workerBondDeposits += l.workerBond;

            bool refunded = s == ERC8183.JobStatus.Rejected || s == ERC8183.JobStatus.Expired;
            bool rewardInHolding = !l.rewardWithdrawn && (!l.funded || refunded);
            bool rewardInCore = l.funded && (s == ERC8183.JobStatus.Funded || s == ERC8183.JobStatus.Submitted);
            bool rewardToWorker = s == ERC8183.JobStatus.Completed;
            assertTrue(!rewardToWorker || l.funded, "completed without funding");
            assertFalse(rewardToWorker && l.rewardWithdrawn, "reward paid twice");

            if (rewardInHolding) expectHoldingPay += l.reward;
            if (rewardInCore) expectCorePay += l.reward;
            if (rewardToWorker) expectWorkerPay += l.reward;
            if (l.rewardWithdrawn) expectCreatorPay += l.reward;

            // Creator bond: in Holding until settled; then burned iff the creator was slashed, else returned.
            if (!l.creatorBondSettled) expectHoldingFactory += l.creatorBond;
            else if (handler.creatorSlashed(jobId)) expectBurned += l.creatorBond;
            else expectCreatorFactory += l.creatorBond;
            // Worker bond: minted to the worker at publish; still in its wallet until posted.
            if (!l.workerBondPosted) expectWorkerFactory += l.workerBond;
            else {
                if (!l.workerBondSettled) expectHoldingFactory += l.workerBond;
                else if (handler.workerSlashed(jobId)) expectBurned += l.workerBond;
                else expectWorkerFactory += l.workerBond;
            }
            // A slash implies a ruling on that job, and a ruling implies a terminal job.
            if (handler.creatorSlashed(jobId)) assertTrue(handler.ruledForWorker(jobId), "creator slashed without a ruling for the worker");
            if (handler.creatorSlashed(jobId) || handler.workerSlashed(jobId)) {
                assertTrue(s == ERC8183.JobStatus.Completed || s == ERC8183.JobStatus.Rejected, "slash without settlement");
            }
        }

        assertEq(payDeposits, handler.payMinted(), "every payment mint was deposited");
        assertEq(pay.balanceOf(creator), expectCreatorPay, "creator pay");
        assertEq(pay.balanceOf(worker), expectWorkerPay, "worker pay");
        assertEq(pay.balanceOf(address(holding)), expectHoldingPay, "holding pay");
        assertEq(pay.balanceOf(address(core)), expectCorePay, "core pay");

        assertEq(factory.balanceOf(creator), expectCreatorFactory, "creator factory");
        assertEq(factory.balanceOf(worker), expectWorkerFactory, "worker factory");
        assertEq(factory.balanceOf(address(holding)), expectHoldingFactory, "holding factory");
        assertEq(factory.balanceOf(address(core)), 0, "factory never enters the core");
        // Minted to both wallets, minus what still sits in wallets/Holding, minus what was burned = 0.
        uint256 mintedTotal = handler.factoryMintedCreator() + handler.factoryMintedWorker() + 2 * MIN_HOLD;
        assertEq(
            mintedTotal - expectBurned,
            factory.balanceOf(creator) + factory.balanceOf(worker) + factory.balanceOf(address(holding)),
            "factory conservation incl. burns"
        );
    }
}

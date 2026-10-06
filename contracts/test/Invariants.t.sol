// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {FactoryToken} from "../src/FactoryToken.sol";
import {MockPaymentToken} from "../src/MockPaymentToken.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev Drives random lifecycles in both modes, including the adversarial calls straight at the core, and
///      records the facts the contracts cannot tell us afterwards: rulings and which side was slashed.
contract Handler is Test {
    FactoryToken internal factory;
    MockPaymentToken internal pay;
    ERC8183WithAuthorization internal core;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;
    address internal creator;
    address internal worker;
    address internal arbitrator;
    uint256 internal creatorPk;
    uint256 internal workerPk;

    uint256[] public jobs;
    mapping(uint256 jobId => bool) public ruledForWorker;
    mapping(uint256 jobId => bool) public creatorSlashed;
    mapping(uint256 jobId => bool) public workerSlashed;
    /// @dev Which party `settle` paid a reward in Holding to; read back by the balance equations.
    mapping(uint256 jobId => bool) public settledToWorker;
    uint256 public payMinted;
    uint256 public factoryMintedCreator;
    uint256 public factoryMintedWorker;

    constructor(
        FactoryToken factory_,
        MockPaymentToken pay_,
        ERC8183WithAuthorization core_,
        JobHolding holding_,
        JobsEvaluator evaluator_,
        address creator_,
        address worker_,
        address arbitrator_,
        uint256 creatorPk_,
        uint256 workerPk_
    ) {
        creatorPk = creatorPk_;
        workerPk = workerPk_;
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
        // Contests carry no worker bond (R20).
        workerBond = contest ? 0 : uint96(bound(workerBond, 0, 100e18));
        pay.mint(creator, reward);
        payMinted += reward;
        factory.mint(creator, creatorBond);
        factoryMintedCreator += creatorBond;
        factory.mint(worker, workerBond);
        factoryMintedWorker += workerBond;

        uint48 dd = uint48(block.timestamp + 7 days);
        JobHolding.PublishParams memory p = JobHolding.PublishParams({
            approver: address(0),
            manifestHash: keccak256(abi.encode(reward, jobs.length)),
            policyHash: keccak256(abi.encode("policy", jobs.length)),
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

    function _coreSig(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s_, v);
    }

    /// @dev Contest: the approver (the creator here) awards the worker's finished entry in one transaction.
    function award(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        JobHolding.Listing memory l = holding.getListing(jobId);
        if (l.mode != JobHolding.Mode.Contest) return;
        uint256 deadline = l.selectionDeadline;
        bytes32 deliverable = keccak256("entry");
        // Apart from the hire activations' budget nonces (= jobId): two per contest, above 2^40.
        uint72 nonce = uint72(2 ** 40 + 2 * jobId);
        JobHolding.Candidate memory c;
        c.worker = worker;
        c.agentId = 1;
        c.deliverable = deliverable;
        c.budgetAuth = ERC8183WithAuthorization.Authorization(
            worker,
            nonce,
            deadline,
            _coreSig(
                workerPk,
                keccak256(
                    abi.encode(
                        core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                        worker,
                        jobId,
                        address(pay),
                        l.reward,
                        keccak256(""),
                        nonce,
                        deadline
                    )
                )
            )
        );
        c.submitAuth = ERC8183WithAuthorization.Authorization(
            worker,
            nonce + 1,
            deadline,
            _coreSig(
                workerPk,
                keccak256(
                    abi.encode(
                        core.SUBMIT_AUTHORIZATION_TYPEHASH(), worker, jobId, deliverable, keccak256(""), nonce + 1, deadline
                    )
                )
            )
        );
        vm.prank(creator);
        try holding.award(jobId, c) {} catch {}
    }

    /// @dev Hire: the creator's signed selection and the worker's own activation.
    function activate(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        JobHolding.Listing memory l = holding.getListing(jobId);
        if (l.mode != JobHolding.Mode.HireFirst) return;
        JobHolding.Selection memory sel = JobHolding.Selection({
            jobId: jobId,
            worker: worker,
            agentId: 1,
            termsHash: l.policyHash,
            activateBy: l.deliveryDeadline - 1,
            nonce: jobId
        });
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(creatorPk, holding.selectionDigest(sel));
        bytes memory selSig = abi.encodePacked(r, s_, v);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 budgetHash = keccak256(
            abi.encode(
                core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                worker,
                jobId,
                address(pay),
                l.reward,
                keccak256(""),
                uint72(jobId),
                deadline
            )
        );
        (v, r, s_) = vm.sign(workerPk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), budgetHash)));
        ERC8183WithAuthorization.Authorization memory auth =
            ERC8183WithAuthorization.Authorization(worker, uint72(jobId), deadline, abi.encodePacked(r, s_, v));
        vm.prank(worker);
        try holding.activate(sel, selSig, auth) {} catch {}
    }

    function setBudget(uint256 seed, bool exactAmount) external withJobs {
        uint256 jobId = _pick(seed);
        uint256 reward = holding.getListing(jobId).reward;
        vm.prank(worker);
        try core.setBudget(jobId, address(pay), exactAmount ? reward : reward + 1, "") {} catch {}
    }

    function submit(uint256 seed) external withJobs {
        vm.prank(worker);
        try core.submit(_pick(seed), keccak256("d"), "") {} catch {}
    }

    function creatorAccept(uint256 seed) external withJobs {
        vm.prank(creator);
        try evaluator.accept(_pick(seed)) {} catch {}
    }

    function reject(uint256 seed, uint8 violation) external withJobs {
        vm.prank(creator);
        try evaluator.reject(_pick(seed), JobsEvaluator.Violation(violation % 3), keccak256("reason")) {} catch {}
    }

    function dispute(uint256 seed) external withJobs {
        vm.prank(worker);
        try evaluator.dispute(_pick(seed)) {} catch {}
    }

    function rule(uint256 seed, bool forWorker, bool slash) external withJobs {
        uint256 jobId = _pick(seed);
        vm.prank(arbitrator);
        try evaluator.rule(jobId, forWorker, slash, keccak256("ruling")) {
            if (forWorker) ruledForWorker[jobId] = true;
            if (slash && forWorker) creatorSlashed[jobId] = true;
            if (slash && !forWorker) workerSlashed[jobId] = true;
        } catch {}
    }

    function cancel(uint256 seed) external withJobs {
        vm.prank(creator);
        try holding.cancel(_pick(seed)) {} catch {}
    }

    function settle(uint256 seed) external withJobs {
        uint256 jobId = _pick(seed);
        uint256 before = pay.balanceOf(worker);
        try holding.settle(jobId) {} catch {}
        if (pay.balanceOf(worker) > before) settledToWorker[jobId] = true;
    }

    /// @dev The late actions R16-01 closes: they must never land after their cutoff, whoever calls first.
    function lateActions(uint256 seed, bool forWorker) external withJobs {
        uint256 jobId = _pick(seed);
        vm.prank(creator);
        try evaluator.reject(jobId, JobsEvaluator.Violation.None, keccak256("reason")) {} catch {}
        vm.prank(arbitrator);
        try evaluator.rule(jobId, forWorker, false, keccak256("ruling")) {
            if (forWorker) ruledForWorker[jobId] = true;
        } catch {}
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
///      exactly one of the creator's wallet, the worker's wallet, Holding or the core; every unit of SIDE
///      bonded is in its owner's wallet, in Holding, or burned; the reward reaches the worker only through
///      `complete`; a bond is burned only by a ruling that found a violation; nothing pays twice.
contract InvariantsTest is Base {
    Handler internal handler;

    /// @dev SIDE the setUp drained to the burn address before any job; slashes add to it.
    uint256 internal drainedFactory;

    function setUp() public override {
        super.setUp();
        handler = new Handler(factory, pay, core, holding, evaluator, creator, worker, arbitrator, creatorPk, workerPk);
        identity.setAgentWallet(1, worker);
        // The handler mints per publish; drain the setUp balances so the equations are exact. Both wallets
        // keep exactly MIN_HOLD of SIDE, which the hold gate reads and the equations exclude.
        uint256 c = pay.balanceOf(creator);
        vm.prank(creator);
        pay.transfer(address(0xdead), c);
        uint256 cf = factory.balanceOf(creator) - MIN_HOLD;
        vm.prank(creator);
        factory.transfer(address(0xdead), cf);
        uint256 wf = factory.balanceOf(worker) - MIN_HOLD;
        vm.prank(worker);
        factory.transfer(address(0xdead), wf);
        drainedFactory = cf + wf;
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
            bool rewardInHolding = !l.rewardSettled && (!l.funded || refunded);
            bool rewardInCore = l.funded && (s == ERC8183.JobStatus.Funded || s == ERC8183.JobStatus.Submitted);
            bool rewardToWorker = s == ERC8183.JobStatus.Completed;
            assertTrue(!rewardToWorker || l.funded, "completed without funding");
            assertFalse(rewardToWorker && l.rewardSettled, "reward paid twice");
            // Holding pays a refunded reward to the worker only after the core's own expiry (R114-03).
            if (handler.settledToWorker(jobId)) assertEq(uint256(s), uint256(ERC8183.JobStatus.Expired));

            if (rewardInHolding) expectHoldingPay += l.reward;
            if (rewardInCore) expectCorePay += l.reward;
            if (rewardToWorker) expectWorkerPay += l.reward;
            if (l.rewardSettled) {
                if (handler.settledToWorker(jobId)) expectWorkerPay += l.reward;
                else expectCreatorPay += l.reward;
            }

            // Creator bond: in Holding until settled; then burned or returned, as Holding recorded.
            if (!l.creatorBondSettled) expectHoldingFactory += l.creatorBond;
            else if (l.creatorBondBurned) expectBurned += l.creatorBond;
            else expectCreatorFactory += l.creatorBond;
            // Worker bond: minted to the worker at publish; still in its wallet until posted.
            if (!l.workerBondPosted) expectWorkerFactory += l.workerBond;
            else {
                if (!l.workerBondSettled) expectHoldingFactory += l.workerBond;
                else if (l.workerBondBurned) expectBurned += l.workerBond;
                else expectWorkerFactory += l.workerBond;
            }
            // The creator's bond burns exactly when a ruling found the rejection in bad faith.
            assertEq(l.creatorBondBurned, handler.creatorSlashed(jobId), "creator bond burned iff found in bad faith");
            // The worker's bond burns only on a slashable finding: an upheld violation, an undisputed rejection
            // that named one, or a missed delivery. Approver silence and arbitrator inactivity never burn.
            if (handler.workerSlashed(jobId)) assertTrue(l.workerBondBurned, "an upheld violation burns");
            if (l.workerBondBurned) {
                uint48 submittedAt = core.getJob(jobId).submittedAt;
                bool missed = submittedAt == 0 || submittedAt > l.deliveryDeadline;
                bool undisputedViolation = evaluator.violationOf(jobId) != JobsEvaluator.Violation.None
                    && evaluator.disputedAt(jobId) == 0;
                assertTrue(handler.workerSlashed(jobId) || undisputedViolation || missed, "burn without a finding");
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
        _assertBurned(expectBurned);
        assertEq(
            mintedTotal - expectBurned,
            factory.balanceOf(creator) + factory.balanceOf(worker) + factory.balanceOf(address(holding)),
            "factory conservation incl. burns"
        );
    }

    function _assertBurned(uint256 expectBurned) internal view {
        assertEq(factory.balanceOf(holding.BURN_ADDRESS()) - drainedFactory, expectBurned, "burned bonds sit at the burn address");
    }
}

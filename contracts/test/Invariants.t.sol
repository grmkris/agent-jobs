// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {RewardToken} from "../src/RewardToken.sol";

/// @dev Drives random lifecycles (including the adversarial calls straight at the core) and records the
///      one fact the contracts cannot tell us afterwards: whether a ruling for the worker happened.
contract Handler is Test {
    RewardToken internal token;
    ERC8183 internal core;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;
    address internal creator;
    address internal worker;
    address internal arbitrator;

    uint256[] public jobs;
    mapping(uint256 jobId => bool) public ruledForWorker;
    uint256 public minted;

    constructor(
        RewardToken token_,
        ERC8183 core_,
        JobHolding holding_,
        JobsEvaluator evaluator_,
        address creator_,
        address worker_,
        address arbitrator_
    ) {
        token = token_;
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

    function publish(uint96 reward, uint96 bond) external {
        reward = uint96(bound(reward, 1, 1_000e18));
        bond = uint96(bound(bond, 0, 1_000e18));
        token.mint(creator, uint256(reward) + bond);
        minted += uint256(reward) + bond;
        uint48 dd = uint48(block.timestamp + 7 days);
        uint48 exp = dd + evaluator.settlementWindow();
        vm.prank(creator);
        uint256 jobId = holding.publish(keccak256(abi.encode(reward, bond, jobs.length)), reward, bond, dd, exp);
        jobs.push(jobId);
    }

    function assign(uint256 seed) external withJobs {
        vm.prank(creator);
        try holding.assign(_pick(seed), worker, 1) {} catch {}
    }

    function accept(uint256 seed, bool exactAmount) external withJobs {
        uint256 jobId = _pick(seed);
        (,,,,, uint256 reward,,) = holding.listings(jobId);
        vm.prank(worker);
        try core.setBudget(jobId, address(token), exactAmount ? reward : reward + 1, "") {} catch {}
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

    function rule(uint256 seed, bool forWorker) external withJobs {
        uint256 jobId = _pick(seed);
        vm.prank(arbitrator);
        try evaluator.rule(jobId, forWorker) {
            if (forWorker) ruledForWorker[jobId] = true;
        } catch {}
    }

    function cancel(uint256 seed) external withJobs {
        vm.prank(creator);
        try holding.cancel(_pick(seed)) {} catch {}
    }

    function withdraw(uint256 seed) external withJobs {
        vm.prank(creator);
        try holding.withdraw(_pick(seed)) {} catch {}
    }

    /// @dev Time passes, then every permissionless path is tried by a stranger, plus the two adversarial
    ///      calls a provider could make straight at the core.
    function timeouts(uint256 seed, uint32 secondsForward) external withJobs {
        vm.warp(block.timestamp + bound(secondsForward, 0, 20 days));
        uint256 jobId = _pick(seed);
        try evaluator.completeAfterSilence(jobId) {} catch {}
        try evaluator.rejectAfterWindow(jobId) {} catch {}
        try evaluator.refundAfterArbitrationTimeout(jobId) {} catch {}
        try evaluator.rejectAfterDeliveryDeadline(jobId) {} catch {}
        try core.claimRefund(jobId) {} catch {}
        vm.prank(worker);
        try core.submitClaim(jobId, 1, keccak256("claim"), "") {} catch {}
    }
}

/// @dev The four balance equations. Together they state: every unit deposited is in exactly one of the
///      creator's wallet, the worker's wallet, Holding or the core; the reward reaches the worker only through
///      `complete`; the bond reaches the worker only through a ruling for the worker; nothing pays twice.
contract InvariantsTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(token, core, holding, evaluator, creator, worker, arbitrator);
        // The handler mints per publish; start the creator from zero so the equations are exact.
        uint256 seeded = token.balanceOf(creator);
        vm.prank(creator);
        token.transfer(address(0xdead), seeded);
        targetContract(address(handler));
    }

    function invariant_balancesPartitionEveryDeposit() public view {
        uint256 expectCreator;
        uint256 expectWorker;
        uint256 expectHolding;
        uint256 expectCore;
        uint256 deposits;

        uint256 n = handler.jobCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 jobId = handler.jobs(i);
            JobHolding.Listing memory l = listing(jobId);
            ERC8183.JobStatus s = status(jobId);
            deposits += l.reward + l.bond;

            bool refunded = s == ERC8183.JobStatus.Rejected || s == ERC8183.JobStatus.Expired;
            bool rewardInHolding = !l.rewardWithdrawn && (!l.funded || refunded);
            bool rewardInCore = l.funded && (s == ERC8183.JobStatus.Funded || s == ERC8183.JobStatus.Submitted);
            bool rewardToWorker = s == ERC8183.JobStatus.Completed;
            // The evaluator never completes a job Holding did not fund (submit-before-accept).
            assertTrue(!rewardToWorker || l.funded, "completed without funding");
            bool bondToWorker = handler.ruledForWorker(jobId);

            if (rewardInHolding) expectHolding += l.reward;
            if (rewardInCore) expectCore += l.reward;
            if (rewardToWorker) expectWorker += l.reward;
            if (l.rewardWithdrawn) expectCreator += l.reward;

            if (!l.bondSettled) expectHolding += l.bond;
            else if (bondToWorker) expectWorker += l.bond;
            else expectCreator += l.bond;

            // A completed job's reward went to the worker, so it can never be withdrawn as well.
            assertFalse(rewardToWorker && l.rewardWithdrawn, "reward paid twice");
            // A bond only reaches the worker on a ruling for the worker, and such a job is Completed.
            if (bondToWorker) assertEq(uint256(s), uint256(ERC8183.JobStatus.Completed), "bond without payout");
        }

        assertEq(deposits, handler.minted(), "every mint was deposited");
        assertEq(token.balanceOf(creator), expectCreator, "creator balance");
        assertEq(token.balanceOf(worker), expectWorker, "worker balance");
        assertEq(token.balanceOf(address(holding)), expectHolding, "holding balance");
        assertEq(token.balanceOf(address(core)), expectCore, "core balance");
    }
}

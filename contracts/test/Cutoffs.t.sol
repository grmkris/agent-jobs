// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev R16-01: a timeout becoming callable must also close the opposing action, whether or not anyone has
///      called the timeout yet, and whichever transaction lands first.
contract CutoffsTest is Base {
    // ---- review window: creatorReject vs completeAfterSilence ----

    function _reviewDeadline(uint256 jobId) internal view returns (uint256) {
        return uint256(core.getJob(jobId).submittedAt) + REVIEW;
    }

    function test_review_rejectAtDeadlineMinusOne() public {
        uint256 jobId = submittedJob();
        vm.warp(_reviewDeadline(jobId) - 1);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.expectRevert(JobsEvaluator.AlreadyRejected.selector);
        evaluator.completeAfterSilence(jobId);
    }

    function test_review_rejectAtExactDeadline() public {
        uint256 jobId = submittedJob();
        vm.warp(_reviewDeadline(jobId));
        // At the deadline the window is still open (silence needs strictly more), so rejection is allowed ...
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        // ... and silence cannot fire in the same second.
        vm.expectRevert(JobsEvaluator.AlreadyRejected.selector);
        evaluator.completeAfterSilence(jobId);
    }

    function test_review_lateRejectFailsWithoutAnyKeeper() public {
        uint256 jobId = submittedJob();
        vm.warp(_reviewDeadline(jobId) + 1);
        // Nobody has called completeAfterSilence; the rejection is still closed.
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.ReviewWindowClosed.selector);
        evaluator.creatorReject(jobId);
        evaluator.completeAfterSilence(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
    }

    function test_review_orderingSilenceFirstThenReject() public {
        uint256 jobId = submittedJob();
        vm.warp(_reviewDeadline(jobId) + 1);
        evaluator.completeAfterSilence(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotSubmitted.selector);
        evaluator.creatorReject(jobId);
    }

    function test_review_acceptStaysOpenLate() public {
        uint256 jobId = submittedJob();
        vm.warp(_reviewDeadline(jobId) + 1 days);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD, "a late accept only helps the worker");
    }

    // ---- arbitration window: rule vs refundAfterArbitrationTimeout ----

    function _arbitrationDeadline(uint256 jobId) internal view returns (uint256) {
        return uint256(evaluator.disputedAt(jobId)) + ARBITRATION;
    }

    function test_arbitration_ruleAtDeadlineMinusOne() public {
        uint256 jobId = disputedJob();
        vm.warp(_arbitrationDeadline(jobId) - 1);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, false);
        assertEq(pay.balanceOf(worker), REWARD);
    }

    function test_arbitration_ruleAtExactDeadline() public {
        uint256 jobId = disputedJob();
        vm.warp(_arbitrationDeadline(jobId));
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, false);
    }

    function test_arbitration_lateRuleFailsWithoutAnyKeeper() public {
        uint256 jobId = disputedJob();
        vm.warp(_arbitrationDeadline(jobId) + 1);
        vm.prank(arbitrator);
        vm.expectRevert(JobsEvaluator.ArbitrationWindowClosed.selector);
        evaluator.rule(jobId, true, true);
        evaluator.refundAfterArbitrationTimeout(jobId);
        assertEq(uint256(core.getJob(jobId).status), uint256(ERC8183.JobStatus.Rejected));
    }

    function test_arbitration_orderingTimeoutFirstThenRule() public {
        uint256 jobId = disputedJob();
        vm.warp(_arbitrationDeadline(jobId) + 1);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.prank(arbitrator);
        vm.expectRevert(JobsEvaluator.ArbitrationWindowClosed.selector);
        evaluator.rule(jobId, true, false);
    }

    /// @dev The cutoffs stay inside the core's own protection: the latest possible ruling still precedes
    ///      `expiredAt + EVALUATION_GRACE_PERIOD` when the worker finalized at the delivery deadline.
    function test_cutoffsFitInsideCoreExpiry() public {
        uint256 jobId = fundedJob();
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)));
        submitDirect(jobId);
        vm.warp(block.timestamp + REVIEW);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.warp(block.timestamp + DISPUTE);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.warp(block.timestamp + ARBITRATION);
        vm.expectRevert(ERC8183.GracePeriodActive.selector);
        core.claimRefund(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, false);
    }
}

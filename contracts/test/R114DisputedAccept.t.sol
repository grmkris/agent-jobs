// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev R114-02, found at 47c4dd2 (accept during a dispute), written as counterexamples before the fix (spec §13,
///      S7 row).
contract R114DisputedAcceptTest is Base {
    // ------------------------------------------------------------------------------------------
    // R114-02: once disputed, only a ruling or the arbitration timeout settles
    // ------------------------------------------------------------------------------------------

    function test_R114_02_acceptDuringDisputeIsRefused() public {
        uint256 jobId = disputedJob();
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Submitted), "still the arbitrator's call");
    }

    /// @dev The dodge R114 found: paying late during a dispute returned both bonds and escaped the bad-faith
    ///      finding. The ruling must still be able to burn the creator's bond.
    function test_R114_02_acceptRefused_thenBadFaithRulingBurnsCreatorBond() public {
        uint256 supply = factory.totalSupply();
        uint256 jobId = disputedJob();
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, true);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(factory.totalSupply(), supply - CREATOR_BOND, "the bad-faith finding still burns");
    }

    function test_R114_02_acceptRefused_thenArbitrationTimeoutRefunds() public {
        uint256 jobId = disputedJob();
        vm.warp(uint256(evaluator.disputedAt(jobId)) + ARBITRATION);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
        vm.warp(block.timestamp + 1);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
        evaluator.refundAfterArbitrationTimeout(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        assertEq(pay.balanceOf(worker), 0);
    }

    function test_R114_02_rulingFirstThenAccept() public {
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, false);
        vm.prank(creator);
        vm.expectRevert();
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), 0, "a ruling for the creator stays final");
    }

    function test_R114_02_timeoutFirstThenAccept() public {
        uint256 jobId = disputedJob();
        vm.warp(uint256(evaluator.disputedAt(jobId)) + ARBITRATION + 1);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.prank(creator);
        vm.expectRevert();
        evaluator.accept(jobId);
    }

    /// @dev Before a dispute the approver may reconsider; afterwards a dispute on the settled job is refused.
    function test_R114_02_reconsiderBeforeDispute_thenDisputeRefused() public {
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD, "pre-dispute reconsideration pays");
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.NotSubmitted.selector);
        evaluator.dispute(jobId);
        assertEq(evaluator.disputedAt(jobId), 0, "no dispute recorded on a settled job");
    }
}

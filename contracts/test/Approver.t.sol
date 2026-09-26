// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev S7 publish rules and the per-offer approver (R20, R114-02, R114-07): the approver judges the work, the
///      creator pays and is refunded, and an approver never gains spending authority.
contract ApproverTest is Base {
    address internal approver = makeAddr("approver");

    function _publishApproved() internal returns (uint256 jobId) {
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        p.approver = approver;
        vm.prank(creator);
        jobId = holding.publish(p);
    }

    function _submittedApproved() internal returns (uint256 jobId) {
        jobId = _publishApproved();
        activate(jobId);
        submitDirect(jobId);
    }

    // ---- publish ----

    function test_publish_zeroPolicyHashRefused() public {
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        p.policyHash = bytes32(0);
        vm.prank(creator);
        vm.expectRevert(JobHolding.PolicyHashRequired.selector);
        holding.publish(p);
    }

    /// @dev R114-07: a retried publish of the same offer must not fund a second escrow, whoever sends it.
    function test_publish_reusedPolicyHashRefused() public {
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        holding.publish(p);
        uint256 escrowed = pay.balanceOf(address(holding));
        vm.prank(creator);
        vm.expectRevert(JobHolding.PolicyHashUsed.selector);
        holding.publish(p);
        assertEq(pay.balanceOf(address(holding)), escrowed, "no second escrow");
        assertTrue(holding.policyListed(p.policyHash));
    }

    function test_publish_contestWithWorkerBondRefused() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND);
        p.workerBond = 1;
        vm.prank(creator);
        vm.expectRevert(JobHolding.ContestWorkerBond.selector);
        holding.publish(p);
    }

    function test_publish_approverDefaultsToCreator() public {
        uint256 own = publish();
        uint256 delegated = _publishApproved();
        assertEq(holding.approverOf(own), creator);
        assertEq(holding.approverOf(delegated), approver);
    }

    // ---- approver != creator ----

    function test_approver_acceptsAndCreatorCannot() public {
        uint256 jobId = _submittedApproved();
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotApprover.selector);
        evaluator.accept(jobId);
        vm.prank(stranger);
        vm.expectRevert(JobsEvaluator.NotApprover.selector);
        evaluator.accept(jobId);
        vm.prank(approver);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(approver) + factory.balanceOf(approver), 0, "the approver receives nothing");
    }

    function test_approver_rejectsAndCreatorKeepsTheRefund() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 jobId = _submittedApproved();
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotApprover.selector);
        evaluator.creatorReject(jobId);
        vm.prank(approver);
        evaluator.creatorReject(jobId);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);
        vm.prank(approver);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "the refund goes to the creator, whoever settles");
        assertEq(pay.balanceOf(approver) + factory.balanceOf(approver), 0);
    }

    /// @dev R114-02 with approver != creator: neither party can pay its way out of a dispute.
    function test_R114_02_approverCannotAcceptDuringDispute() public {
        uint256 supply = factory.totalSupply();
        uint256 jobId = _submittedApproved();
        vm.prank(approver);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(approver);
        vm.expectRevert(JobsEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotApprover.selector);
        evaluator.accept(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, true);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(factory.totalSupply(), supply - CREATOR_BOND, "the creator's bond answers for the rejection");
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
    }
}

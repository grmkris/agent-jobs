// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev The §4 acceptance list, one test per line, against the pinned core.
contract LifecycleTest is Base {
    // ------------------------------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------------------------------

    function test_happyPath_directWorker() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = publish(REWARD, BOND);
        assertEq(token.balanceOf(creator), before - REWARD - BOND, "listing is the escrow");
        assertEq(core.getJob(jobId).client, address(holding), "Holding is the client");
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Open));

        assign(jobId);
        assertEq(core.getJob(jobId).provider, worker);
        assertEq(core.getJob(jobId).providerAgentId, AGENT_ID, "agent id rides on the core job");

        vm.expectRevert(JobHolding.NotAccepted.selector);
        holding.fundAfterAccept(jobId);

        acceptDirect(jobId, REWARD);
        fund(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Funded));
        assertEq(token.balanceOf(address(core)), REWARD, "reward moved into the core");
        assertEq(token.balanceOf(address(holding)), BOND, "bond stays in Holding");

        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);

        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
        assertEq(token.balanceOf(worker), REWARD, "worker paid from escrow");
        assertEq(token.balanceOf(creator), before - REWARD, "bond came back");
        assertEq(token.balanceOf(address(holding)), 0);
        assertEq(token.balanceOf(address(core)), 0);
    }

    function test_happyPath_relayedWorker() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        acceptRelayed(jobId, REWARD, 1, block.timestamp + 1 hours);
        fund(jobId);
        submitRelayed(jobId, 2);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Submitted));
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(token.balanceOf(worker), REWARD);
        assertEq(token.balanceOf(relayer), 0, "the relayer never touches money");
    }

    function test_publish_requiresSettlementWindowAfterDelivery() public {
        uint48 dd = deliveryDeadline();
        uint48 tooShort = dd + evaluator.settlementWindow() - 1;
        vm.prank(creator);
        vm.expectRevert(JobHolding.ExpiryTooShort.selector);
        holding.publish(MANIFEST, REWARD, BOND, dd, tooShort);
    }

    function test_assign_requiresAgentId() public {
        uint256 jobId = publish(REWARD, BOND);
        vm.prank(creator);
        vm.expectRevert(JobHolding.AgentIdRequired.selector);
        holding.assign(jobId, worker, 0);
    }

    // ------------------------------------------------------------------------------------------
    // Three money paths, each recovered exactly once
    // ------------------------------------------------------------------------------------------

    function test_moneyPath_cancelBeforeAssignment() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = publish(REWARD, BOND);
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        assertEq(token.balanceOf(address(core)), 0, "nothing was ever escrowed in the core");

        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before, "reward and bond back");

        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
    }

    function test_moneyPath_cancelRefusedOnceAssigned() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        vm.prank(creator);
        vm.expectRevert(JobHolding.AlreadyAssigned.selector);
        holding.cancel(jobId);
    }

    function test_moneyPath_terminalRejectAfterFunding() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);

        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        assertEq(token.balanceOf(address(holding)), REWARD, "core refunded the reward to Holding");
        assertEq(token.balanceOf(creator), before - REWARD, "bond already returned by the evaluator");

        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before);
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
    }

    function test_moneyPath_thirdPartyClaimRefund() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = fundedJob(REWARD, BOND);
        // The worker never submits; a stranger calls the core directly once the job has expired.
        vm.warp(uint256(expiry()) + 1);
        vm.prank(stranger);
        core.claimRefund(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Expired));
        assertEq(token.balanceOf(address(holding)), REWARD + BOND, "refund landed in Holding without our API");

        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before, "reward and bond recovered together");
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
    }

    function test_withdraw_nothingWhileListingIsLive() public {
        uint256 jobId = publish(REWARD, BOND);
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
        vm.prank(stranger);
        vm.expectRevert(JobHolding.NotCreator.selector);
        holding.withdraw(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Dispute
    // ------------------------------------------------------------------------------------------

    function test_dispute_rulingForWorkerMovesRewardAndBond() public {
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Submitted), "rejection moves nothing");

        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true);

        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
        assertEq(token.balanceOf(worker), REWARD + BOND, "reward from escrow, bond from Holding");
        assertEq(token.balanceOf(address(holding)), 0);
    }

    function test_dispute_rulingForCreatorRefundsAndReturnsBond() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, false);

        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before);
        assertEq(token.balanceOf(worker), 0);
    }

    function test_dispute_onlyPartiesAndOnlyInWindow() public {
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.NotRejected.selector);
        evaluator.dispute(jobId);

        vm.prank(stranger);
        vm.expectRevert(JobsEvaluator.NotCreator.selector);
        evaluator.creatorReject(jobId);
        vm.prank(creator);
        evaluator.creatorReject(jobId);

        vm.prank(stranger);
        vm.expectRevert(JobsEvaluator.NotProvider.selector);
        evaluator.dispute(jobId);

        vm.warp(block.timestamp + DISPUTE + 1);
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.WindowClosed.selector);
        evaluator.dispute(jobId);
    }

    function test_rule_onlyArbitratorAndOnlyWhenDisputed() public {
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(arbitrator);
        vm.expectRevert(JobsEvaluator.NotDisputed.selector);
        evaluator.rule(jobId, true);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotArbitrator.selector);
        evaluator.rule(jobId, false);
    }

    // ------------------------------------------------------------------------------------------
    // Permissionless timeouts
    // ------------------------------------------------------------------------------------------

    function test_timeout_silenceIsAcceptance() public {
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(stranger);
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.completeAfterSilence(jobId);

        vm.warp(block.timestamp + REVIEW + 1);
        vm.prank(stranger);
        evaluator.completeAfterSilence(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
        assertEq(token.balanceOf(worker), REWARD);
    }

    function test_timeout_silenceNotAfterRejection() public {
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.expectRevert(JobsEvaluator.AlreadyRejected.selector);
        evaluator.completeAfterSilence(jobId);
    }

    function test_timeout_undisputedRejectionBecomesFinal() public {
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.rejectAfterWindow(jobId);
        vm.warp(block.timestamp + DISPUTE + 1);
        vm.prank(stranger);
        evaluator.rejectAfterWindow(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
    }

    function test_timeout_arbitratorInactiveIsStatusQuo() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = submittedJob(REWARD, BOND);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);

        vm.warp(block.timestamp + ARBITRATION + 1);
        vm.prank(stranger);
        evaluator.refundAfterArbitrationTimeout(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before, "status quo: reward and bond back to the creator");
    }

    function test_timeout_deliveryDeadlineRejectsUnfinalizedJob() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = fundedJob(REWARD, BOND);
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        vm.prank(stranger);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before);
    }

    // ------------------------------------------------------------------------------------------
    // Adversarial: the inherited surface
    // ------------------------------------------------------------------------------------------

    function test_adversarial_milestoneClaimCannotBlockRefund() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = fundedJob(REWARD, BOND);
        // The provider files a milestone claim directly on the core; nothing in our SDK does this.
        vm.prank(worker);
        core.submitClaim(jobId, REWARD / 2, keccak256("half"), "");
        assertTrue(core.pendingClaimHash(jobId) != bytes32(0));

        // With the claim pending, the core's own refund is blocked past expiry ...
        vm.warp(uint256(expiry()) + 1);
        vm.expectRevert(ERC8183.PendingClaimExists.selector);
        core.claimRefund(jobId);

        // ... but the evaluator's delivery-deadline rejection clears it and refunds.
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(core.pendingClaimHash(jobId), bytes32(0));
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before);
    }

    function test_adversarial_claimRefundCannotPreemptSettlement() public {
        uint256 jobId = fundedJob(REWARD, BOND);
        // Submit at the last legal moment and reject at the end of the review window.
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)));
        submitDirect(jobId);
        vm.warp(block.timestamp + REVIEW);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.warp(block.timestamp + DISPUTE);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.warp(block.timestamp + ARBITRATION);
        // The whole settlement window has elapsed; the core's refund is still gated.
        vm.expectRevert(ERC8183.GracePeriodActive.selector);
        core.claimRefund(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true);
        assertEq(token.balanceOf(worker), REWARD + BOND);
    }

    function test_adversarial_submitBeforeAcceptCannotBeSettled() public {
        uint256 before = token.balanceOf(creator);
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        // The core allows a provider to submit an Open job whose budget is still 0.
        submitDirect(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Submitted));
        assertFalse(listing(jobId).funded);

        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NeverFunded.selector);
        evaluator.accept(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.expectRevert(JobsEvaluator.NeverFunded.selector);
        evaluator.completeAfterSilence(jobId);

        // Past the delivery deadline anyone can clear it, and the creator recovers everything.
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        vm.prank(stranger);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(token.balanceOf(creator), before);
        assertEq(token.balanceOf(worker), 0);
    }

    function test_adversarial_holdingNeverSettlesClaims() public {
        uint256 jobId = fundedJob(REWARD, BOND);
        vm.prank(worker);
        core.submitClaim(jobId, REWARD / 2, keccak256("half"), "");
        // Only the client (Holding) could settle or approve it, and Holding exposes no such path.
        vm.prank(creator);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.settleClaim(jobId, REWARD / 2, keccak256("half"), "");
        vm.prank(creator);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.approveClaim(jobId, REWARD / 2, keccak256("half"), "");
    }

    // ------------------------------------------------------------------------------------------
    // Authorization negatives
    // ------------------------------------------------------------------------------------------

    function test_auth_replayRejected() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSetBudget(workerPk, worker, jobId, address(token), REWARD, 7, deadline);
        ERC8183WithAuthorization.Authorization memory auth =
            ERC8183WithAuthorization.Authorization(worker, 7, deadline, sig);
        core.setBudgetWithAuthorization(jobId, address(token), REWARD, "", auth);
        vm.expectRevert(ERC8183WithAuthorization.AuthorizationNonceUsed.selector);
        core.setBudgetWithAuthorization(jobId, address(token), REWARD, "", auth);
    }

    function test_auth_expiredRejected() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = signSetBudget(workerPk, worker, jobId, address(token), REWARD, 1, deadline);
        vm.expectRevert(ERC8183WithAuthorization.AuthorizationExpired.selector);
        core.setBudgetWithAuthorization(
            jobId, address(token), REWARD, "", ERC8183WithAuthorization.Authorization(worker, 1, deadline, sig)
        );
    }

    function test_auth_mismatchedAmountRejected() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSetBudget(workerPk, worker, jobId, address(token), REWARD, 1, deadline);
        vm.expectRevert();
        core.setBudgetWithAuthorization(
            jobId, address(token), REWARD + 1, "", ERC8183WithAuthorization.Authorization(worker, 1, deadline, sig)
        );
    }

    function test_auth_wrongSignerCannotAccept() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        uint256 deadline = block.timestamp + 1 hours;
        // A valid signature from someone who is not the provider: the core rejects it as Unauthorized.
        bytes memory sig = signSetBudget(impostorPk, impostor, jobId, address(token), REWARD, 1, deadline);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.setBudgetWithAuthorization(
            jobId, address(token), REWARD, "", ERC8183WithAuthorization.Authorization(impostor, 1, deadline, sig)
        );
    }

    function test_auth_workerCannotUnderfundThemselves() public {
        uint256 jobId = publish(REWARD, BOND);
        assign(jobId);
        // A budget that is not the listed reward is not an acceptance; Holding refuses to fund it.
        acceptDirect(jobId, REWARD - 1);
        vm.expectRevert(JobHolding.NotAccepted.selector);
        holding.fundAfterAccept(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Fuzz: amounts
    // ------------------------------------------------------------------------------------------

    function testFuzz_happyPath_conservesMoney(uint96 reward, uint96 bond) public {
        vm.assume(reward > 0);
        token.mint(creator, uint256(reward) + bond);
        uint256 creatorBefore = token.balanceOf(creator);
        uint256 jobId = submittedJob(reward, bond);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(token.balanceOf(worker), reward);
        assertEq(token.balanceOf(creator), creatorBefore - reward);
        assertEq(token.balanceOf(address(holding)) + token.balanceOf(address(core)), 0);
    }

    function testFuzz_rulingForWorker_conservesMoney(uint96 reward, uint96 bond) public {
        vm.assume(reward > 0);
        token.mint(creator, uint256(reward) + bond);
        uint256 creatorBefore = token.balanceOf(creator);
        uint256 jobId = submittedJob(reward, bond);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true);
        assertEq(token.balanceOf(worker), uint256(reward) + bond);
        assertEq(token.balanceOf(creator), creatorBefore - reward - bond);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {BlocklistToken, ReentrantToken} from "../mocks/OddTokens.sol";
import {MockReputation} from "../mocks/MockReputation.sol";
import {PausableToken, GasHungryToken} from "./mocks/V1Tokens.sol";
import {BaseV1} from "./BaseV1.t.sol";

contract HirelingEvaluatorTest is BaseV1 {
    // ------------------------------------------------------------------------------------------
    // Per-listing terms
    // ------------------------------------------------------------------------------------------

    function test_silencePaysAfterTheListingsOwnReviewWindow() public {
        IHirelingHolding.PublishParams memory p = params();
        p.reviewWindow = 1 hours;
        p.expiredAt = p.deliveryDeadline + 1 hours + DISPUTE + ARBITRATION + MARGIN;
        uint256 jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
        uint256 submittedAt = core.getJob(jobId).submittedAt;
        vm.warp(submittedAt + 1 hours);
        vm.expectRevert(IHirelingEvaluator.WindowOpen.selector);
        evaluator.completeAfterSilence(jobId);
        vm.warp(submittedAt + 1 hours + 1);
        evaluator.completeAfterSilence(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
        assertEq(uint8(evaluator.outcome(jobId)), uint8(IHirelingEvaluator.Outcome.Silence));
        assertEq(reputation.lastTag2(), "completed");
    }

    function test_reject_onlyApproverWithinItsWindow() public {
        uint256 jobId = submittedJob();
        vm.prank(stranger);
        vm.expectRevert(IHirelingEvaluator.NotApprover.selector);
        evaluator.reject(jobId, IHirelingEvaluator.Violation.None, REASON);
        vm.warp(core.getJob(jobId).submittedAt + REVIEW + 1);
        vm.prank(creator);
        vm.expectRevert(IHirelingEvaluator.ReviewWindowClosed.selector);
        evaluator.reject(jobId, IHirelingEvaluator.Violation.None, REASON);
    }

    function test_thirdPartyApproverJudges() public {
        address approver = makeAddr("approver");
        IHirelingHolding.PublishParams memory p = params();
        p.approver = approver;
        uint256 jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
        vm.prank(creator);
        vm.expectRevert(IHirelingEvaluator.NotApprover.selector);
        evaluator.accept(jobId);
        vm.prank(approver);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
    }

    function test_customArbitratorRules_defaultCannot() public {
        (address custom, uint256 customPk) = makeAddrAndKey("custom-arbiter");
        IHirelingHolding.PublishParams memory p = params();
        p.arbitrator = custom;
        uint256 jobId = publishWith(p);
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, IHirelingEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);

        vm.prank(arbitrator);
        vm.expectRevert(IHirelingEvaluator.NotArbitrator.selector);
        evaluator.rule(jobId, true, false, REASON);

        // The default arbitrator's signature is no good either.
        IHirelingEvaluator.Ruling memory r = IHirelingEvaluator.Ruling(jobId, true, false, REASON, block.timestamp, 1);
        bytes memory wrong = signRuling(arbitratorPk, r);
        vm.expectRevert(IHirelingEvaluator.InvalidSignature.selector);
        evaluator.ruleWithSignature(r, wrong);

        bytes memory right = signRuling(customPk, r);
        vm.prank(relayer);
        evaluator.ruleWithSignature(r, right);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(IHirelingEvaluator.Outcome.RuledForWorker));
        assertTrue(evaluator.rulingNonceUsed(custom, 1));
        assertFalse(evaluator.rulingNonceUsed(arbitrator, 1));
    }

    function test_dispute_onlyWorkerWithinWindow() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, IHirelingEvaluator.Violation.None);
        vm.prank(stranger);
        vm.expectRevert(IHirelingEvaluator.NotProvider.selector);
        evaluator.dispute(jobId);
        vm.warp(block.timestamp + DISPUTE + 1);
        vm.prank(worker);
        vm.expectRevert(IHirelingEvaluator.WindowClosed.selector);
        evaluator.dispute(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Rulings, slashes, nonces
    // ------------------------------------------------------------------------------------------

    function test_ruleForWorker_badFaithBurnsCreatorBond() public {
        uint256 jobId = disputedJob();
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 supply = factory.totalSupply();
        uint256 before = pay.balanceOf(worker);
        rule(jobId, true, true);
        assertEq(pay.balanceOf(worker) - before, net);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND);
        assertEq(vault.stakeOf(worker), WORKER_STAKE);
        assertEq(factory.totalSupply(), supply - CREATOR_BOND, "burned");
        assertTrue(evaluator.creatorPenaltyDue(jobId));
        assertFalse(evaluator.workerPenaltyDue(jobId));
        assertTrue(listing(jobId).creatorBondBurned);
        assertEq(uint8(evaluator.slashed(jobId)), uint8(IHirelingEvaluator.SlashedSide.Creator));
    }

    function test_ruleForCreator_upholdsViolationBurnsWorkerBond() public {
        uint256 jobId = disputedJob();
        rule(jobId, false, true);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        uint256 before = pay.balanceOf(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator) - before, REWARD);
        assertEq(reputation.lastTag2(), "rejected-quality");
    }

    function test_ruleForCreator_slashNeedsANamedViolation() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, IHirelingEvaluator.Violation.None);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        vm.expectRevert(IHirelingEvaluator.InvalidRuling.selector);
        evaluator.rule(jobId, false, true, REASON);
    }

    function test_alreadyRuled_secondRulingRefused() public {
        uint256 jobId = disputedJob();
        rule(jobId, true, false);
        vm.prank(arbitrator);
        vm.expectRevert(IHirelingEvaluator.AlreadyRuled.selector);
        evaluator.rule(jobId, false, true, REASON);
        vm.warp(block.timestamp + ARBITRATION + 1);
        vm.expectRevert(IHirelingEvaluator.AlreadyRuled.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
    }

    function test_arbitrationCutoffAndTimeout() public {
        uint256 jobId = disputedJob();
        uint256 at = evaluator.disputedAt(jobId);
        vm.warp(at + ARBITRATION);
        vm.expectRevert(IHirelingEvaluator.WindowOpen.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.warp(at + ARBITRATION + 1);
        vm.prank(arbitrator);
        vm.expectRevert(IHirelingEvaluator.ArbitrationWindowClosed.selector);
        evaluator.rule(jobId, true, false, REASON);
        uint256 calls = reputation.calls();
        evaluator.refundAfterArbitrationTimeout(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(IHirelingEvaluator.Outcome.ArbitrationTimeout));
        assertEq(reputation.calls(), calls, "no feedback on arbitration timeout");
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "inactivity never burns");
        assertEq(vault.reservedOf(worker), 0);
    }

    function test_rulingNonces_perArbitrator() public {
        (address other, uint256 otherPk) = makeAddrAndKey("other-arbiter");
        uint256 a = disputedJob();
        IHirelingHolding.PublishParams memory p = params();
        p.arbitrator = other;
        uint256 b = publishWith(p);
        activate(b);
        submit(b);
        rejectAs(b, IHirelingEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(b);
        uint256 c = disputedJob();

        IHirelingEvaluator.Ruling memory ra = IHirelingEvaluator.Ruling(a, true, false, REASON, block.timestamp, 7);
        bytes memory sigA = signRuling(arbitratorPk, ra);
        evaluator.ruleWithSignature(ra, sigA);
        // Another arbitrator's nonce 7 is untouched.
        IHirelingEvaluator.Ruling memory rb = IHirelingEvaluator.Ruling(b, true, false, REASON, block.timestamp, 7);
        bytes memory sigB = signRuling(otherPk, rb);
        evaluator.ruleWithSignature(rb, sigB);
        // The same arbitrator cannot reuse 7 on another job.
        IHirelingEvaluator.Ruling memory rc = IHirelingEvaluator.Ruling(c, true, false, REASON, block.timestamp, 7);
        bytes memory sigC = signRuling(arbitratorPk, rc);
        vm.expectRevert(IHirelingEvaluator.RulingNonceUsed.selector);
        evaluator.ruleWithSignature(rc, sigC);

        rc.nonce = 8;
        rc.deadline = block.timestamp - 1;
        sigC = signRuling(arbitratorPk, rc);
        vm.expectRevert(IHirelingEvaluator.RulingExpired.selector);
        evaluator.ruleWithSignature(rc, sigC);
    }

    function test_undisputedViolationBurns_noneDoesNot() public {
        uint256 jobId = submittedJob();
        rejectAs(jobId, IHirelingEvaluator.Violation.Falsified);
        vm.warp(block.timestamp + DISPUTE + 1);
        assertTrue(evaluator.workerPenaltyDue(jobId));
        evaluator.rejectAfterWindow(jobId);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(reputation.lastTag2(), "rejected-falsified");

        uint256 other = submittedJob();
        rejectAs(other, IHirelingEvaluator.Violation.None);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(other);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND, "no second burn");
        assertEq(vault.reservedOf(worker), 0);
    }

    function test_missedDeliveryBurn() public {
        uint256 jobId = fundedJob();
        uint48 deadline = listing(jobId).deliveryDeadline;
        vm.warp(deadline);
        vm.expectRevert(IHirelingEvaluator.WindowOpen.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.warp(deadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(IHirelingEvaluator.Outcome.DeliveryMissed));
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        assertEq(vault.stakeOf(creator), CREATOR_STAKE);
        vm.expectRevert(IHirelingEvaluator.AlreadyResolved.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
    }

    function test_acceptRefusedWhileDisputed() public {
        uint256 jobId = disputedJob();
        vm.prank(creator);
        vm.expectRevert(IHirelingEvaluator.DisputeOpen.selector);
        evaluator.accept(jobId);
    }

    function test_pausedCoreRevertsInsteadOfDeferring() public {
        uint256 jobId = submittedJob();
        vm.prank(deployer);
        core.pause();
        vm.prank(creator);
        vm.expectRevert(IHirelingEvaluator.CorePaused.selector);
        evaluator.accept(jobId);
        assertFalse(evaluator.payoutDeferred(jobId));
        assertEq(uint8(evaluator.outcome(jobId)), 0);
    }

    // ------------------------------------------------------------------------------------------
    // M1: a hostile reward token re-entering settle during the core call gains nothing
    // ------------------------------------------------------------------------------------------

    function _hookJob() internal returns (ReentrantToken hook, uint256 jobId) {
        hook = new ReentrantToken();
        hook.mint(creator, REWARD);
        vm.prank(creator);
        hook.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(hook)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, IHirelingEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
    }

    function test_M1_reentrantSettleDuringRulingForWorkerCannotRecoverCreatorBond() public {
        (ReentrantToken hook, uint256 jobId) = _hookJob();
        hook.arm(address(holding), abi.encodeCall(IHirelingHolding.settle, (jobId)));
        rule(jobId, true, true);
        assertTrue(hook.attempted());
        assertEq(vault.stakeOf(creator), CREATOR_STAKE - CREATOR_BOND, "the bad-faith bond still burned");
        assertTrue(listing(jobId).creatorBondBurned);
        assertEq(vault.reservedOf(creator), 0);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(hook.balanceOf(worker), net);
        // The re-entrant settle ran inside the core call and could only do the fixed thing: the fee to the treasury.
        assertTrue(hook.reentered(), "settle was re-entered during complete");
        assertEq(hook.balanceOf(treasury), fee);
        vm.expectRevert(IHirelingHolding.NothingToSettle.selector);
        holding.settle(jobId);
        assertEq(hook.balanceOf(address(holding)), 0);
    }

    function test_M1_reentrantSettleDuringRulingForCreatorCannotRecoverWorkerBond() public {
        (ReentrantToken hook, uint256 jobId) = _hookJob();
        hook.arm(address(holding), abi.encodeCall(IHirelingHolding.settle, (jobId)));
        rule(jobId, false, true);
        assertTrue(hook.attempted());
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND, "the upheld violation still burned");
        assertTrue(listing(jobId).workerBondBurned);
        assertTrue(hook.reentered(), "settle was re-entered during reject");
        assertEq(hook.balanceOf(creator), REWARD);
    }

    function test_M1_reentryIntoTheEvaluatorIsRefused() public {
        (ReentrantToken hook, uint256 jobId) = _hookJob();
        hook.arm(address(evaluator), abi.encodeCall(IHirelingEvaluator.refundAfterArbitrationTimeout, (jobId)));
        rule(jobId, true, false);
        assertTrue(hook.attempted());
        assertFalse(hook.reentered());
        assertEq(uint8(evaluator.outcome(jobId)), uint8(IHirelingEvaluator.Outcome.RuledForWorker));
    }

    // ------------------------------------------------------------------------------------------
    // M2: a token refusing the worker defers the payout; the worker is still paid
    // ------------------------------------------------------------------------------------------

    function _blockyJob() internal returns (BlocklistToken blk, uint256 jobId) {
        blk = new BlocklistToken();
        blk.mint(creator, REWARD);
        blk.mint(contributor, REWARD);
        vm.prank(creator);
        blk.approve(address(holding), REWARD);
        vm.prank(contributor);
        blk.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(blk)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        vm.prank(contributor);
        holding.topUp(jobId, 10e6);
        submit(jobId);
    }

    function test_M2_blocklistedWorker_acceptDefersThenSettlePaysThroughOwed() public {
        (BlocklistToken blk, uint256 jobId) = _blockyJob();
        blk.setBlocked(worker, true);
        vm.expectEmit(address(evaluator));
        emit IHirelingEvaluator.PayoutDeferred(jobId, true);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertTrue(evaluator.payoutDeferred(jobId));
        assertTrue(evaluator.earnedByWorker(jobId));
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected), "the reward came back to Holding");
        assertEq(reputation.lastTag2(), "completed");

        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 bonusFee = 10e6 * 3000 / 10_000;
        uint256 creatorBefore = blk.balanceOf(creator);
        holding.settle(jobId);
        assertEq(blk.balanceOf(creator), creatorBefore, "never a refund to the creator");
        assertEq(holding.owed(IERC20(address(blk)), worker), net + 10e6 - bonusFee);
        assertEq(blk.balanceOf(treasury), fee + bonusFee);
        assertEq(uint8(listing(jobId).outcome), uint8(IHirelingHolding.Outcome.Paid));

        blk.setBlocked(worker, false);
        vm.prank(worker);
        holding.withdraw(IERC20(address(blk)));
        assertEq(blk.balanceOf(worker), net + 10e6 - bonusFee);
    }

    /// @dev The original M2: a ruling for the worker used to revert, and the timeout then refunded the creator.
    function test_M2_blocklistedWorker_rulingStands_timeoutCannotRefund() public {
        (BlocklistToken blk, uint256 jobId) = _blockyJob();
        rejectAs(jobId, IHirelingEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        blk.setBlocked(worker, true);
        rule(jobId, true, false);
        assertTrue(evaluator.payoutDeferred(jobId));
        vm.warp(block.timestamp + ARBITRATION + 1);
        vm.expectRevert(IHirelingEvaluator.AlreadyRuled.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        holding.settle(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertGe(holding.owed(IERC20(address(blk)), worker), net);
    }

    /// @dev Worst case: the token refuses every transfer, so both `complete` and `reject` fail. The decision stands,
    ///      every other path is closed, and after expiry the core's `claimRefund` brings the reward to Holding.
    function test_M2_frozenToken_bothCallsFail_claimRefundLaterPaysWorker() public {
        PausableToken pau = new PausableToken();
        pau.mint(creator, REWARD);
        vm.prank(creator);
        pau.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(pau)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        pau.setPaused(true);
        vm.expectEmit(address(evaluator));
        emit IHirelingEvaluator.PayoutDeferred(jobId, false);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Submitted));
        assertEq(vault.reservedOf(worker), 0, "bonds settled before the core call");

        vm.prank(creator);
        vm.expectRevert(IHirelingEvaluator.AlreadyResolved.selector);
        evaluator.reject(jobId, IHirelingEvaluator.Violation.Quality, REASON);
        vm.warp(core.getJob(jobId).submittedAt + REVIEW + 1);
        vm.expectRevert(IHirelingEvaluator.AlreadyResolved.selector);
        evaluator.completeAfterSilence(jobId);

        pau.setPaused(false);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pau.balanceOf(worker), net);
        assertEq(pau.balanceOf(treasury), fee);
    }

    function test_M2_rulingForCreatorWithFrozenTokenStillRecordsAndSlashes() public {
        PausableToken pau = new PausableToken();
        pau.mint(creator, REWARD);
        vm.prank(creator);
        pau.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(pau)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        rejectAs(jobId, IHirelingEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        pau.setPaused(true);
        vm.expectEmit(address(evaluator));
        emit IHirelingEvaluator.RefundDeferred(jobId);
        rule(jobId, false, true);
        assertEq(vault.stakeOf(worker), WORKER_STAKE - WORKER_BOND);
        pau.setPaused(false);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        holding.settle(jobId);
        assertEq(pau.balanceOf(creator), REWARD);
    }

    // ------------------------------------------------------------------------------------------
    // Evidence and feedback
    // ------------------------------------------------------------------------------------------

    function test_evidence_boundToTheListingsPolicy() public {
        uint256 jobId = submittedJob();
        IHirelingEvaluator.EvidenceAttestation memory a = IHirelingEvaluator.EvidenceAttestation({
            jobId: jobId,
            submissionHash: DELIVERABLE,
            policyHash: listing(jobId).policyHash,
            repo: keccak256("repo"),
            headSha: keccak256("head"),
            testedSha: keccak256("tested"),
            checkRunsHash: keccak256("checks"),
            conclusion: 1,
            validUntil: block.timestamp + 1 days
        });
        vm.prank(attester);
        evaluator.attachEvidenceDirect(jobId, a);
        (bytes32 digest,,,,,,) = evaluator.evidence(jobId, attester);
        assertTrue(digest != bytes32(0));

        a.policyHash = keccak256("other");
        vm.prank(attester);
        vm.expectRevert(IHirelingEvaluator.EvidencePolicyMismatch.selector);
        evaluator.attachEvidenceDirect(jobId, a);
        vm.prank(stranger);
        vm.expectRevert(IHirelingEvaluator.NotVerifier.selector);
        evaluator.attachEvidenceDirect(jobId, a);
    }

    function test_feedback_failureNeverUndoesPayment_andGasFloor() public {
        uint256 jobId = submittedJob();
        reputation.setMode(MockReputation.Mode.Revert);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));

        uint256 other = submittedJob();
        reputation.setMode(MockReputation.Mode.Ok);
        vm.prank(creator);
        vm.expectRevert();
        evaluator.accept{gas: 350_000}(other);
    }
}

/// @dev Gas starvation, with no reputation registry (otherwise the feedback gas floor refuses a starved call outright):
///      an expensive transfer to the worker fails inside `complete` for lack of gas, and only the route changes.
contract HirelingEvaluatorStarvationTest is BaseV1 {
    function withReputation() internal pure override returns (bool) {
        return false;
    }

    function test_M2_gasStarvationChangesOnlyTheRoute() public {
        GasHungryToken hungry = new GasHungryToken();
        hungry.mint(creator, REWARD);
        vm.prank(creator);
        hungry.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(hungry)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        // An honest but expensive transfer to the worker: about 6M gas.
        hungry.setHungry(worker, 60_000);

        vm.prank(creator);
        evaluator.accept{gas: 3_000_000}(jobId);
        assertTrue(evaluator.payoutDeferred(jobId), "the starved complete was deferred");
        assertTrue(evaluator.earnedByWorker(jobId));

        if (status(jobId) == ERC8183.JobStatus.Submitted) {
            vm.warp(core.getJob(jobId).expiredAt + 1 hours);
            core.claimRefund(jobId);
        }
        holding.settle(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        // The push to the worker exceeds TRANSFER_GAS, so it is owed; the worker withdraws with enough gas.
        uint256 owedNow = holding.owed(IERC20(address(hungry)), worker);
        uint256 paidNow = hungry.balanceOf(worker);
        assertEq(owedNow + paidNow, net);
        if (owedNow > 0) {
            vm.prank(worker);
            holding.withdraw{gas: 20_000_000}(IERC20(address(hungry)));
        }
        assertEq(hungry.balanceOf(worker), net, "the worker is paid in full");
        assertEq(hungry.balanceOf(creator), 0, "the creator never got the reward back");
    }

    function test_withoutStarvationTheSameJobCompletesDirectly() public {
        GasHungryToken hungry = new GasHungryToken();
        hungry.mint(creator, REWARD);
        vm.prank(creator);
        hungry.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(hungry)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        hungry.setHungry(worker, 60_000);
        vm.prank(creator);
        evaluator.accept{gas: 30_000_000}(jobId);
        assertFalse(evaluator.payoutDeferred(jobId));
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {IERC8004Reputation} from "../src/vendor/erc8004/IERC8004.sol";

/// @dev S7 review, delivery and signed-ruling rows (R20): violations and burns, late submissions, the penalty guard
///      after a core refund, and `ruleWithSignature`.
contract SlashingTest is Base {
    uint256 internal arbitratorPk;
    uint256 internal supply;
    uint256 internal creatorPay;
    uint256 internal cFac;
    uint256 internal wFac;

    function setUp() public override {
        super.setUp();
        // Re-deploy the evaluator with an arbitrator whose key the tests hold, so they can sign rulings.
        address arb;
        (arb, arbitratorPk) = makeAddrAndKey("signing-arbitrator");
        arbitrator = arb;
        vm.startPrank(deployer);
        holding = new JobHolding(core, factory, holding.identity(), MIN_HOLD, MIN_HOLD);
        evaluator = new JobsEvaluator(
            core, holding, IERC8004Reputation(address(reputation)), arbitrator, REVIEW, DISPUTE, ARBITRATION, MARGIN
        );
        holding.setEvaluator(address(evaluator));
        vm.stopPrank();
        vm.prank(creator);
        pay.approve(address(holding), type(uint256).max);
        vm.prank(creator);
        factory.approve(address(holding), type(uint256).max);
        vm.prank(worker);
        factory.approve(address(holding), type(uint256).max);

        supply = factory.totalSupply();
        creatorPay = pay.balanceOf(creator);
        cFac = factory.balanceOf(creator);
        wFac = factory.balanceOf(worker);
    }

    function _rejected(JobsEvaluator.Violation v) internal returns (uint256 jobId) {
        jobId = submittedJob();
        vm.prank(creator);
        evaluator.reject(jobId, v, REASON);
    }

    function _disputed(JobsEvaluator.Violation v) internal returns (uint256 jobId) {
        jobId = _rejected(v);
        vm.prank(worker);
        evaluator.dispute(jobId);
    }

    function _assertOutcome(uint256 jobId, bool workerPaid, bool workerBurned, bool creatorBurned) internal {
        if (!workerPaid) holding.settle(jobId);
        assertEq(pay.balanceOf(worker), workerPaid ? REWARD : 0, "reward");
        assertEq(pay.balanceOf(creator), workerPaid ? creatorPay - REWARD : creatorPay, "refund");
        assertEq(factory.balanceOf(worker), workerBurned ? wFac - WORKER_BOND : wFac, "worker bond");
        assertEq(factory.balanceOf(creator), creatorBurned ? cFac - CREATOR_BOND : cFac, "creator bond");
        uint256 burned = (workerBurned ? WORKER_BOND : 0) + (creatorBurned ? CREATOR_BOND : 0);
        assertEq(factory.totalSupply(), supply - burned, "burned, not transferred");
        assertEq(listing(jobId).workerBondBurned, workerBurned);
        assertEq(listing(jobId).creatorBondBurned, creatorBurned);
        assertEq(pay.balanceOf(address(holding)) + factory.balanceOf(address(holding)), 0, "each amount once");
    }

    // ---- rejection × undisputed ----

    function test_undisputed_noneReturnsBothBonds() public {
        uint256 jobId = _rejected(JobsEvaluator.Violation.None);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);
        _assertOutcome(jobId, false, false, false);
        assertEq(reputation.lastTag2(), "rejected");
    }

    function test_undisputed_qualityBurnsWorkerBond() public {
        uint256 jobId = _rejected(JobsEvaluator.Violation.Quality);
        vm.warp(block.timestamp + DISPUTE);
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.rejectAfterWindow(jobId);
        vm.warp(block.timestamp + 1);
        evaluator.rejectAfterWindow(jobId);
        _assertOutcome(jobId, false, true, false);
        assertEq(reputation.lastTag2(), "rejected-quality");
    }

    function test_undisputed_falsifiedBurnsWorkerBond() public {
        uint256 jobId = _rejected(JobsEvaluator.Violation.Falsified);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);
        _assertOutcome(jobId, false, true, false);
        assertEq(reputation.lastTag2(), "rejected-falsified");
    }

    // ---- rejection × disputed and ruled ----

    function test_ruled_violationUpheldBurnsWorkerBond() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Falsified);
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, true, REASON);
        _assertOutcome(jobId, false, true, false);
        assertEq(reputation.lastTag2(), "rejected-falsified");
    }

    function test_ruled_forCreatorWithoutFindingBurnsNothing() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, false, REASON);
        _assertOutcome(jobId, false, false, false);
        assertEq(reputation.lastTag2(), "rejected");
    }

    function test_ruled_badFaithRejectionBurnsCreatorBond() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, true, REASON);
        _assertOutcome(jobId, true, false, true);
        assertEq(reputation.lastTag2(), "completed");
    }

    function test_ruled_cannotUpholdAViolationNobodyNamed() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.None);
        vm.prank(arbitrator);
        vm.expectRevert(JobsEvaluator.InvalidRuling.selector);
        evaluator.rule(jobId, false, true, REASON);
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, false, REASON);
        _assertOutcome(jobId, false, false, false);
    }

    // ---- rejection × arbitration timeout ----

    function test_arbitrationTimeout_neverBurnsAndWritesNoFeedback() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Falsified);
        uint256 calls = reputation.calls();
        vm.warp(block.timestamp + ARBITRATION + 1);
        evaluator.refundAfterArbitrationTimeout(jobId);
        _assertOutcome(jobId, false, false, false);
        assertEq(reputation.calls(), calls, "skip-arb: no feedback about the worker");
    }

    function test_disputeRefusedOnUnactivatedOrSettledJobs() public {
        uint256 open = publish();
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.NotProvider.selector);
        evaluator.dispute(open);
        uint256 jobId = _rejected(JobsEvaluator.Violation.Quality);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.NotSubmitted.selector);
        evaluator.dispute(jobId);
    }

    // ---- late delivery ----

    function _late() internal returns (uint256 jobId) {
        jobId = fundedJob();
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        submitDirect(jobId);
    }

    function test_late_noSilencePaymentNoRejection() public {
        uint256 jobId = _late();
        vm.warp(block.timestamp + REVIEW + 1);
        vm.expectRevert(JobsEvaluator.LateSubmission.selector);
        evaluator.completeAfterSilence(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.LateSubmission.selector);
        evaluator.reject(jobId, JobsEvaluator.Violation.Quality, REASON);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        _assertOutcome(jobId, false, true, false);
    }

    function test_late_approverAcceptsBeforeTheBurn() public {
        uint256 jobId = _late();
        vm.prank(creator);
        evaluator.accept(jobId);
        vm.expectRevert(JobsEvaluator.NotLate.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        _assertOutcome(jobId, true, false, false);
    }

    function test_late_burnBeforeTheApproverAccepts() public {
        uint256 jobId = _late();
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotSubmitted.selector);
        evaluator.accept(jobId);
        _assertOutcome(jobId, false, true, false);
    }

    function test_timely_submissionCannotBeBurned() public {
        uint256 jobId = fundedJob();
        vm.warp(holding.deliveryDeadlineOf(jobId));
        submitDirect(jobId);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(JobsEvaluator.NotLate.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
    }

    // ---- the penalty guard after a direct core refund ----

    function _pastCoreExpiry(uint256 jobId) internal {
        vm.warp(uint256(core.getJob(jobId).expiredAt) + core.EVALUATION_GRACE_PERIOD());
    }

    /// @dev Refund first: `settle` still burns the no-show's bond.
    function test_guard_claimRefundThenSettleBurnsNoShow() public {
        uint256 jobId = fundedJob();
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _assertOutcome(jobId, false, true, false);
    }

    /// @dev Burn first: the core refund is no longer available and nothing is left to settle twice.
    function test_guard_burnThenClaimRefundRefused() public {
        uint256 jobId = fundedJob();
        _pastCoreExpiry(jobId);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.expectRevert(ERC8183.WrongStatus.selector);
        core.claimRefund(jobId);
        _assertOutcome(jobId, false, true, false);
    }

    function test_guard_undisputedViolationThenClaimRefundStillBurns() public {
        uint256 jobId = _rejected(JobsEvaluator.Violation.Quality);
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _assertOutcome(jobId, false, true, false);
    }

    function test_guard_lateSubmissionThenClaimRefundStillBurns() public {
        uint256 jobId = _late();
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _assertOutcome(jobId, false, true, false);
    }

    function test_guard_pendingMilestoneClaimDoesNotEscapeTheBurn() public {
        uint256 jobId = fundedJob();
        vm.prank(worker);
        core.submitClaim(jobId, REWARD / 2, keccak256("half"), "");
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(core.pendingClaimHash(jobId), bytes32(0));
        _assertOutcome(jobId, false, true, false);
    }

    // ---- signed rulings ----

    function _ruling(uint256 jobId, bool forWorker, bool slash, uint256 nonce)
        internal
        view
        returns (JobsEvaluator.Ruling memory r, bytes memory sig)
    {
        r = JobsEvaluator.Ruling(jobId, forWorker, slash, REASON, block.timestamp + 1 hours, nonce);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(arbitratorPk, evaluator.rulingDigest(r));
        sig = abi.encodePacked(rr, s, v);
    }

    function test_signedRuling_anyRelayerEqualsRule() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        (JobsEvaluator.Ruling memory r, bytes memory sig) = _ruling(jobId, true, true, 1);
        vm.prank(relayer);
        evaluator.ruleWithSignature(r, sig);
        _assertOutcome(jobId, true, false, true);
        assertEq(pay.balanceOf(relayer) + factory.balanceOf(relayer), 0, "the relayer holds no authority or money");
    }

    function test_signedRuling_wrongSignerRefused() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        (JobsEvaluator.Ruling memory r,) = _ruling(jobId, true, false, 1);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(impostorPk, evaluator.rulingDigest(r));
        vm.expectRevert(JobsEvaluator.InvalidSignature.selector);
        evaluator.ruleWithSignature(r, abi.encodePacked(rr, s, v));
    }

    function test_signedRuling_expiredRefused() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        (JobsEvaluator.Ruling memory r, bytes memory sig) = _ruling(jobId, true, false, 1);
        vm.warp(r.deadline + 1);
        vm.expectRevert(JobsEvaluator.RulingExpired.selector);
        evaluator.ruleWithSignature(r, sig);
    }

    function test_signedRuling_replayedNonceRefused() public {
        uint256 first = _disputed(JobsEvaluator.Violation.Quality);
        uint256 second = _disputed(JobsEvaluator.Violation.Quality);
        (JobsEvaluator.Ruling memory r, bytes memory sig) = _ruling(first, true, false, 7);
        evaluator.ruleWithSignature(r, sig);
        vm.expectRevert(JobsEvaluator.RulingNonceUsed.selector);
        evaluator.ruleWithSignature(r, sig);
        (JobsEvaluator.Ruling memory r2, bytes memory sig2) = _ruling(second, false, false, 7);
        vm.expectRevert(JobsEvaluator.RulingNonceUsed.selector);
        evaluator.ruleWithSignature(r2, sig2);
    }

    function test_signedRuling_sameCutoffAsRule() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        vm.warp(uint256(evaluator.disputedAt(jobId)) + ARBITRATION + 1);
        (JobsEvaluator.Ruling memory r, bytes memory sig) = _ruling(jobId, true, false, 1);
        vm.expectRevert(JobsEvaluator.ArbitrationWindowClosed.selector);
        evaluator.ruleWithSignature(r, sig);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.expectRevert(JobsEvaluator.ArbitrationWindowClosed.selector);
        evaluator.ruleWithSignature(r, sig);
    }

    function test_signedRuling_atExactCutoffBeatsTheTimeout() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.Quality);
        vm.warp(uint256(evaluator.disputedAt(jobId)) + ARBITRATION);
        (JobsEvaluator.Ruling memory r, bytes memory sig) = _ruling(jobId, true, false, 1);
        evaluator.ruleWithSignature(r, sig);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(JobsEvaluator.NotSubmitted.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        _assertOutcome(jobId, true, false, false);
    }

    function test_signedRuling_invalidCombinationRefused() public {
        uint256 jobId = _disputed(JobsEvaluator.Violation.None);
        (JobsEvaluator.Ruling memory r, bytes memory sig) = _ruling(jobId, false, true, 1);
        vm.expectRevert(JobsEvaluator.InvalidRuling.selector);
        evaluator.ruleWithSignature(r, sig);
    }
}

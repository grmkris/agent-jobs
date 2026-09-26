// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {EvidenceReceiver} from "../src/EvidenceReceiver.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev The §4 acceptance list (S1 + S1b), one test per line, against the pinned core.
contract LifecycleTest is Base {
    // ------------------------------------------------------------------------------------------
    // Happy path, two assets
    // ------------------------------------------------------------------------------------------

    function test_happyPath_directWorker() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 cFacBefore = factory.balanceOf(creator);
        uint256 wFacBefore = factory.balanceOf(worker);

        uint256 jobId = publish();
        assertEq(pay.balanceOf(creator), payBefore - REWARD, "reward escrowed in the payment token");
        assertEq(factory.balanceOf(creator), cFacBefore - CREATOR_BOND, "creator bond pulled in FACTORY");
        assertEq(core.getJob(jobId).client, address(holding), "Holding is the client");

        activate(jobId);
        assertEq(core.getJob(jobId).providerAgentId, AGENT_ID, "agent id rides on the core job");
        assertEq(factory.balanceOf(worker), wFacBefore - WORKER_BOND, "worker bond pulled at activation");
        assertEq(pay.balanceOf(address(core)), REWARD, "reward moved into the core");
        assertEq(factory.balanceOf(address(core)), 0, "FACTORY never enters the core");
        assertEq(factory.balanceOf(address(holding)), CREATOR_BOND + WORKER_BOND, "both bonds locked in Holding");

        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);

        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
        assertEq(pay.balanceOf(worker), REWARD, "worker paid from escrow");
        assertEq(factory.balanceOf(creator), cFacBefore, "creator bond back");
        assertEq(factory.balanceOf(worker), wFacBefore, "worker bond back");
        assertEq(factory.balanceOf(address(holding)) + pay.balanceOf(address(holding)), 0);
    }

    /// @dev Activation is never relayed (R114-01); the submission may be.
    function test_happyPath_relayedSubmission() public {
        uint256 jobId = fundedJob();
        submitRelayed(jobId, 1_000);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(relayer) + factory.balanceOf(relayer), 0, "the relayer never touches money");
    }

    function test_publish_requiresSettlementWindowAfterDelivery() public {
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        p.expiredAt = p.deliveryDeadline + evaluator.settlementWindow() - 1;
        vm.prank(creator);
        vm.expectRevert(JobHolding.ExpiryTooShort.selector);
        holding.publish(p);
    }

    // ------------------------------------------------------------------------------------------
    // Hold gate and bonds
    // ------------------------------------------------------------------------------------------

    function test_holdGate_publish() public {
        JobHolding.PublishParams memory p = params(REWARD, 0, 0);
        pay.mint(stranger, REWARD);
        vm.prank(stranger);
        pay.approve(address(holding), REWARD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(JobHolding.InsufficientFactoryHeld.selector, 0, MIN_HOLD));
        holding.publish(p);
    }

    // ------------------------------------------------------------------------------------------
    // Money paths, each recovered exactly once
    // ------------------------------------------------------------------------------------------

    function test_moneyPath_cancelBeforeAssignment() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 facBefore = factory.balanceOf(creator);
        uint256 jobId = publish();
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        vm.prank(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "reward back");
        assertEq(factory.balanceOf(creator), facBefore, "creator bond back");
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToSettle.selector);
        holding.settle(jobId);
    }

    function test_moneyPath_terminalRejectAfterFundingReturnsBothBonds() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.warp(block.timestamp + DISPUTE + 1);
        evaluator.rejectAfterWindow(jobId);
        assertEq(factory.balanceOf(creator), cFac, "creator bond returned by the timeout");
        assertEq(factory.balanceOf(worker), wFac, "worker bond returned by the timeout");
        vm.prank(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "reward refunded");
    }

    function test_moneyPath_thirdPartyClaimRefund_settleReturnsEverything() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = fundedJob();
        vm.warp(uint256(expiry()) + 1);
        vm.prank(stranger);
        core.claimRefund(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Expired));
        // No evaluator path ran; anyone settles, and the evaluator says who is owed the reward.
        vm.prank(stranger);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore);
        assertEq(factory.balanceOf(creator), cFac);
        assertEq(factory.balanceOf(worker), wFac);
        vm.expectRevert(JobHolding.NothingToSettle.selector);
        holding.settle(jobId);
    }

    function test_settle_notBeforeTerminal() public {
        uint256 jobId = fundedJob();
        vm.expectRevert(JobHolding.NotTerminal.selector);
        holding.settle(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Dispute: the two-part ruling
    // ------------------------------------------------------------------------------------------

    function test_ruling_forWorkerNoViolation_bothBondsReturn() public {
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 supply = factory.totalSupply();
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, false);
        assertEq(pay.balanceOf(worker), REWARD, "reward from escrow");
        assertEq(factory.balanceOf(creator), cFac, "creator bond back: losing is not misconduct");
        assertEq(factory.balanceOf(worker), wFac);
        assertEq(factory.totalSupply(), supply, "nothing burned");
    }

    function test_ruling_forWorkerWithViolation_burnsCreatorBond() public {
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 supply = factory.totalSupply();
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, true);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(factory.balanceOf(creator), cFac - CREATOR_BOND, "creator bond gone");
        assertEq(factory.balanceOf(worker), wFac, "worker bond back, worker does not receive the burn");
        assertEq(factory.totalSupply(), supply - CREATOR_BOND, "burned, not transferred");
    }

    function test_ruling_forCreatorNoViolation_refundAndBothBondsReturn() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, false);
        vm.prank(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore);
        assertEq(factory.balanceOf(creator), cFac);
        assertEq(factory.balanceOf(worker), wFac);
    }

    function test_ruling_forCreatorWithViolation_burnsWorkerBond() public {
        uint256 wFac = factory.balanceOf(worker);
        uint256 supply = factory.totalSupply();
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, true);
        assertEq(factory.balanceOf(worker), wFac - WORKER_BOND, "worker bond gone");
        assertEq(factory.totalSupply(), supply - WORKER_BOND);
        assertEq(pay.balanceOf(worker), 0);
    }

    function test_dispute_onlyPartiesAndOnlyInWindow() public {
        uint256 jobId = submittedJob();
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.NotRejected.selector);
        evaluator.dispute(jobId);
        vm.prank(stranger);
        vm.expectRevert(JobsEvaluator.NotApprover.selector);
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
        uint256 jobId = submittedJob();
        vm.prank(arbitrator);
        vm.expectRevert(JobsEvaluator.NotDisputed.selector);
        evaluator.rule(jobId, true, false);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotArbitrator.selector);
        evaluator.rule(jobId, false, true);
    }

    // ------------------------------------------------------------------------------------------
    // Permissionless timeouts never burn
    // ------------------------------------------------------------------------------------------

    function test_timeout_silenceIsAcceptance() public {
        uint256 supply = factory.totalSupply();
        uint256 jobId = submittedJob();
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.completeAfterSilence(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.prank(stranger);
        evaluator.completeAfterSilence(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(factory.totalSupply(), supply);
        assertEq(factory.balanceOf(address(holding)), 0, "both bonds returned");
    }

    function test_timeout_arbitratorInactiveIsStatusQuo() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 supply = factory.totalSupply();
        uint256 jobId = disputedJob();
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.warp(block.timestamp + ARBITRATION + 1);
        vm.prank(stranger);
        evaluator.refundAfterArbitrationTimeout(jobId);
        vm.prank(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore);
        assertEq(factory.totalSupply(), supply, "a timeout never burns");
        assertEq(factory.balanceOf(address(holding)), 0);
    }

    function test_timeout_deliveryDeadlineRejectsUnfinalizedJob() public {
        uint256 jobId = fundedJob();
        vm.expectRevert(JobsEvaluator.WindowOpen.selector);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        vm.prank(stranger);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        assertEq(factory.balanceOf(address(holding)), 0, "both bonds returned");
    }

    // ------------------------------------------------------------------------------------------
    // Adversarial: the inherited surface
    // ------------------------------------------------------------------------------------------

    function test_adversarial_milestoneClaimCannotBlockRefund() public {
        uint256 jobId = fundedJob();
        vm.prank(worker);
        core.submitClaim(jobId, REWARD / 2, keccak256("half"), "");
        vm.warp(uint256(expiry()) + 1);
        vm.expectRevert(ERC8183.PendingClaimExists.selector);
        core.claimRefund(jobId);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(core.pendingClaimHash(jobId), bytes32(0));
    }

    function test_adversarial_claimRefundCannotPreemptSettlement() public {
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
        assertEq(pay.balanceOf(worker), REWARD);
    }

    /// @dev With activation setting the provider and funding in one step, there is no provider to submit
    ///         before funding: the core refuses anyone's submission on an unactivated listing.
    function test_adversarial_noSubmissionBeforeActivation() public {
        uint256 jobId = publish();
        vm.prank(worker);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.submit(jobId, DELIVERABLE, "");
    }

    function test_adversarial_holdingNeverSettlesClaims() public {
        uint256 jobId = fundedJob();
        vm.prank(worker);
        core.submitClaim(jobId, REWARD / 2, keccak256("half"), "");
        vm.prank(creator);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.settleClaim(jobId, REWARD / 2, keccak256("half"), "");
    }

    // ------------------------------------------------------------------------------------------
    // Authorization negatives
    // ------------------------------------------------------------------------------------------

    /// @dev The worker's budget authorization is spent by its activation; a relayer cannot replay it.
    function test_auth_replayRejected() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, REWARD, 7);
        vm.prank(worker);
        holding.activate(sel, sig, auth);
        vm.prank(relayer);
        vm.expectRevert(ERC8183WithAuthorization.AuthorizationNonceUsed.selector);
        core.setBudgetWithAuthorization(jobId, address(pay), REWARD, "", auth);
    }

    function test_auth_wrongSignerCannotSetTheBudget() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(impostorPk, impostor, jobId, REWARD, 1);
        vm.prank(worker);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        holding.activate(sel, sig, auth);
    }

    /// @dev Holding fixes token and amount from the listing; an authorization for anything else does not verify.
    function test_auth_workerCannotUnderfundThemselves() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, REWARD - 1, 1);
        vm.prank(worker);
        vm.expectRevert(ERC8183WithAuthorization.InvalidAuthorizationSignature.selector);
        holding.activate(sel, sig, auth);
    }

    // ------------------------------------------------------------------------------------------
    // Evidence
    // ------------------------------------------------------------------------------------------

    function test_evidence_attesterAttaches_movesNoMoney() public {
        uint256 jobId = submittedJob();
        uint256 holdingPay = pay.balanceOf(address(holding));
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        bytes memory sig = signEvidence(attesterPk, a);
        vm.prank(stranger);
        evaluator.attachEvidence(jobId, a, attester, sig);
        (bytes32 digest, bytes32 submissionHash, bytes32 policyHash, bytes32 testedSha, uint48 at,, uint8 conclusion)
        = evaluator.evidence(jobId, attester);
        assertEq(digest, evidenceDigest(a));
        assertEq(submissionHash, DELIVERABLE);
        assertEq(policyHash, holding.policyHashOf(jobId));
        assertEq(testedSha, bytes32(uint256(0xdef)));
        assertEq(at, uint48(block.timestamp));
        assertEq(conclusion, 1);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Submitted), "still the reviewer's call");
        assertEq(pay.balanceOf(address(holding)), holdingPay);
    }

    function test_evidence_unregisteredWrongExpiredReplayed() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        bytes memory good = signEvidence(attesterPk, a);
        bytes memory bad = signEvidence(impostorPk, a);

        vm.expectRevert(JobsEvaluator.NotVerifier.selector);
        evaluator.attachEvidence(jobId, a, impostor, bad);
        vm.expectRevert(JobsEvaluator.InvalidSignature.selector);
        evaluator.attachEvidence(jobId, a, attester, bad);

        JobsEvaluator.EvidenceAttestation memory expired = attestation(jobId, 1, block.timestamp - 1);
        bytes memory expiredSig = signEvidence(attesterPk, expired);
        vm.expectRevert(JobsEvaluator.EvidenceExpired.selector);
        evaluator.attachEvidence(jobId, expired, attester, expiredSig);

        evaluator.attachEvidence(jobId, a, attester, good);

        JobsEvaluator.EvidenceAttestation memory other = attestation(jobId + 1, 1, block.timestamp + 1 days);
        bytes memory otherSig = signEvidence(attesterPk, other);
        vm.expectRevert(JobsEvaluator.EvidenceJobMismatch.selector);
        evaluator.attachEvidence(jobId, other, attester, otherSig);
    }

    function test_evidence_creReceiverIsAContractVerifier() public {
        address forwarder = makeAddr("cre-forwarder");
        EvidenceReceiver receiver = new EvidenceReceiver(evaluator, forwarder);
        vm.prank(deployer);
        evaluator.setVerifier(address(receiver), true);

        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        vm.prank(stranger);
        vm.expectRevert(EvidenceReceiver.NotForwarder.selector);
        receiver.onReport("", abi.encode(a));
        vm.prank(forwarder);
        receiver.onReport("", abi.encode(a));
        (bytes32 digest,,,,,,) = evaluator.evidence(jobId, address(receiver));
        assertEq(digest, evidenceDigest(a), "the receiver contract is the registered verifier");
    }

    // ------------------------------------------------------------------------------------------
    // Fuzz: amounts across both assets
    // ------------------------------------------------------------------------------------------

    function testFuzz_ruling_conservesBothAssets(uint64 reward, uint96 cBond, uint96 wBond, bool forWorker, bool slash)
        public
    {
        vm.assume(reward > 0);
        pay.mint(creator, reward);
        factory.mint(creator, cBond);
        factory.mint(worker, wBond);
        uint256 supply = factory.totalSupply();
        uint256 creatorPay = pay.balanceOf(creator);
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);

        uint256 jobId = publish(reward, cBond, wBond);
        activate(jobId);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, forWorker, slash);
        if (!forWorker) {
            vm.prank(creator);
            holding.settle(jobId);
        }

        uint256 burned = slash ? (forWorker ? cBond : wBond) : 0;
        assertEq(factory.totalSupply(), supply - burned, "burned exactly the loser's bond, or nothing");
        assertEq(pay.balanceOf(worker), forWorker ? reward : 0);
        assertEq(pay.balanceOf(creator), forWorker ? creatorPay - reward : creatorPay);
        assertEq(factory.balanceOf(creator), (slash && forWorker) ? cFac - cBond : cFac);
        assertEq(factory.balanceOf(worker), (slash && !forWorker) ? wFac - wBond : wFac);
        assertEq(factory.balanceOf(address(holding)) + pay.balanceOf(address(holding)), 0);
    }
}

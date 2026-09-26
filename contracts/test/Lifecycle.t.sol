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

        assign(jobId);
        assertEq(core.getJob(jobId).providerAgentId, AGENT_ID, "agent id rides on the core job");
        vm.expectRevert(JobHolding.BondNotPosted.selector);
        holding.fundAfterAccept(jobId);

        acceptDirect(jobId, REWARD);
        assertEq(factory.balanceOf(worker), wFacBefore - WORKER_BOND, "worker bond pulled at accept");
        fund(jobId);
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

    function test_happyPath_relayedWorker() public {
        uint256 jobId = publish();
        assign(jobId);
        acceptRelayed(jobId, REWARD, 1, block.timestamp + 1 hours);
        fund(jobId);
        submitRelayed(jobId, 2);
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

    function test_assign_requiresAgentId() public {
        uint256 jobId = publish();
        vm.prank(creator);
        vm.expectRevert(JobHolding.AgentIdRequired.selector);
        holding.assign(jobId, worker, 0);
    }

    // ------------------------------------------------------------------------------------------
    // Hold gate and bonds
    // ------------------------------------------------------------------------------------------

    function test_holdGate_publishAndClaim() public {
        JobHolding.PublishParams memory p = params(REWARD, 0, 0);
        pay.mint(stranger, REWARD);
        vm.prank(stranger);
        pay.approve(address(holding), REWARD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(JobHolding.InsufficientFactoryHeld.selector, 0, MIN_HOLD));
        holding.publish(p);

        uint256 jobId = publish(REWARD, 0, 0);
        vm.prank(creator);
        holding.assign(jobId, stranger, AGENT_ID);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(JobHolding.InsufficientFactoryHeld.selector, 0, MIN_HOLD));
        holding.postWorkerBond(jobId);
    }

    function test_bond_zeroBondsStillNeedAnExplicitAccept() public {
        uint256 jobId = publish(REWARD, 0, 0);
        assign(jobId);
        vm.prank(worker);
        core.setBudget(jobId, address(pay), REWARD, "");
        vm.expectRevert(JobHolding.BondNotPosted.selector);
        holding.fundAfterAccept(jobId);
        postBond(jobId);
        fund(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Funded));
    }

    function test_bond_onlyTheAssignedWorkerPostsOnce() public {
        uint256 jobId = publish();
        assign(jobId);
        vm.prank(stranger);
        vm.expectRevert(JobHolding.NotWorker.selector);
        holding.postWorkerBond(jobId);
        postBond(jobId);
        vm.prank(worker);
        vm.expectRevert(JobHolding.BondAlreadyPosted.selector);
        holding.postWorkerBond(jobId);
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
        holding.withdraw(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "reward back");
        assertEq(factory.balanceOf(creator), facBefore, "creator bond back");
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
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
        holding.withdraw(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "reward refunded");
    }

    function test_moneyPath_thirdPartyClaimRefund_workerRecoversOwnBond() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = fundedJob();
        vm.warp(uint256(expiry()) + 1);
        vm.prank(stranger);
        core.claimRefund(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Expired));
        // No evaluator path ran, so each side pulls its own share.
        vm.prank(creator);
        holding.withdraw(jobId);
        vm.prank(worker);
        holding.withdrawWorkerBond(jobId);
        assertEq(pay.balanceOf(creator), payBefore);
        assertEq(factory.balanceOf(creator), cFac);
        assertEq(factory.balanceOf(worker), wFac);
        vm.prank(worker);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdrawWorkerBond(jobId);
    }

    function test_withdrawWorkerBond_notBeforeTerminal() public {
        uint256 jobId = fundedJob();
        vm.prank(worker);
        vm.expectRevert(JobHolding.NotTerminal.selector);
        holding.withdrawWorkerBond(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Contest mode
    // ------------------------------------------------------------------------------------------

    function test_contest_pickWinnerThenNormalSettlement() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        assertEq(pay.balanceOf(address(holding)), REWARD, "prize locked at publish");

        vm.prank(creator);
        vm.expectRevert(JobHolding.WrongMode.selector);
        holding.assign(jobId, worker, AGENT_ID);

        vm.prank(creator);
        holding.select(jobId, worker, AGENT_ID);
        acceptDirect(jobId, REWARD);
        fund(jobId);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD, "the picked entrant is paid like a hired worker");
    }

    function test_contest_noPickByDeadlineRefundsThePrize() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 facBefore = factory.balanceOf(creator);
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);

        vm.expectRevert(JobHolding.SelectionWindowOpen.selector);
        holding.expireContest(jobId);
        vm.warp(uint256(p.selectionDeadline) + 1);
        vm.prank(creator);
        vm.expectRevert(JobHolding.SelectionWindowClosed.selector);
        holding.select(jobId, worker, AGENT_ID);

        vm.prank(stranger);
        holding.expireContest(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "prize back");
        assertEq(factory.balanceOf(creator), facBefore, "creator bond back");
    }

    function test_contest_liveContestCannotBeCancelled() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        vm.prank(creator);
        vm.expectRevert(JobHolding.WrongMode.selector);
        holding.cancel(jobId);
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
        assertEq(pay.balanceOf(address(holding)), REWARD, "the prize stays available to entrants");
    }

    function test_contest_expiredOnceRecoveredOnce() public {
        uint256 payBefore = pay.balanceOf(creator);
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        vm.warp(uint256(p.selectionDeadline) + 1);
        holding.expireContest(jobId);
        vm.expectRevert();
        holding.expireContest(jobId);
        vm.prank(creator);
        holding.withdraw(jobId);
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingToWithdraw.selector);
        holding.withdraw(jobId);
        assertEq(pay.balanceOf(creator), payBefore);
    }

    function test_contest_selectedCannotBeExpired() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        vm.prank(creator);
        holding.select(jobId, worker, AGENT_ID);
        acceptDirect(jobId, REWARD);
        fund(jobId);
        vm.warp(uint256(p.selectionDeadline) + 1);
        vm.expectRevert(JobHolding.AlreadyAssigned.selector);
        holding.expireContest(jobId);
    }

    /// @dev R16-03: a selected winner's agreement settles exactly like hire-first.
    function test_contest_winnerSilenceIsAcceptance() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        vm.prank(creator);
        holding.select(jobId, worker, AGENT_ID);
        acceptDirect(jobId, REWARD);
        fund(jobId);
        submitDirect(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        evaluator.completeAfterSilence(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
    }

    function test_contest_winnerCanDisputeATimelyRejection() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        vm.prank(creator);
        holding.select(jobId, worker, AGENT_ID);
        acceptDirect(jobId, REWARD);
        fund(jobId);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, true, false);
        assertEq(pay.balanceOf(worker), REWARD);
    }

    function test_contest_unselectedEntrantHasNoAgreementPath() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        vm.prank(worker);
        vm.expectRevert(JobHolding.NotWorker.selector);
        holding.postWorkerBond(jobId);
        vm.prank(worker);
        vm.expectRevert(JobsEvaluator.NotProvider.selector);
        evaluator.dispute(jobId);
    }

    function test_contest_selectionDeadlineMustPrecedeDelivery() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND, WORKER_BOND);
        p.selectionDeadline = p.deliveryDeadline;
        vm.prank(creator);
        vm.expectRevert(JobHolding.SelectionDeadlineInvalid.selector);
        holding.publish(p);
        JobHolding.PublishParams memory h = params(REWARD, CREATOR_BOND, WORKER_BOND);
        h.selectionDeadline = uint48(block.timestamp + 1 days);
        vm.prank(creator);
        vm.expectRevert(JobHolding.SelectionDeadlineInvalid.selector);
        holding.publish(h);
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
        holding.withdraw(jobId);
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
        holding.withdraw(jobId);
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

    function test_adversarial_submitBeforeAcceptCannotBeSettled() public {
        uint256 jobId = publish();
        assign(jobId);
        submitDirect(jobId);
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NeverFunded.selector);
        evaluator.accept(jobId);
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        vm.prank(creator);
        holding.withdraw(jobId);
        assertEq(pay.balanceOf(worker), 0);
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

    function test_auth_replayRejected() public {
        uint256 jobId = publish();
        assign(jobId);
        postBond(jobId);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSetBudget(workerPk, worker, jobId, address(pay), REWARD, 7, deadline);
        ERC8183WithAuthorization.Authorization memory auth =
            ERC8183WithAuthorization.Authorization(worker, 7, deadline, sig);
        core.setBudgetWithAuthorization(jobId, address(pay), REWARD, "", auth);
        vm.expectRevert(ERC8183WithAuthorization.AuthorizationNonceUsed.selector);
        core.setBudgetWithAuthorization(jobId, address(pay), REWARD, "", auth);
    }

    function test_auth_wrongSignerCannotAccept() public {
        uint256 jobId = publish();
        assign(jobId);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = signSetBudget(impostorPk, impostor, jobId, address(pay), REWARD, 1, deadline);
        vm.expectRevert(ERC8183.Unauthorized.selector);
        core.setBudgetWithAuthorization(
            jobId, address(pay), REWARD, "", ERC8183WithAuthorization.Authorization(impostor, 1, deadline, sig)
        );
    }

    function test_auth_workerCannotUnderfundThemselves() public {
        uint256 jobId = publish();
        assign(jobId);
        acceptDirect(jobId, REWARD - 1);
        vm.expectRevert(JobHolding.NotAccepted.selector);
        holding.fundAfterAccept(jobId);
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
        assertEq(policyHash, POLICY);
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
        assign(jobId);
        acceptDirect(jobId, reward);
        fund(jobId);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
        vm.prank(arbitrator);
        evaluator.rule(jobId, forWorker, slash);
        if (!forWorker) {
            vm.prank(creator);
            holding.withdraw(jobId);
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

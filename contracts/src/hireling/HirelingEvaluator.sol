// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Signatures} from "../Signatures.sol";
import {ERC8183} from "../vendor/erc8183/ERC8183.sol";
import {IERC8004Reputation} from "../vendor/erc8004/IERC8004.sol";
import {IHirelingHolding} from "./interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "./interfaces/IHirelingEvaluator.sol";

/// @title HirelingEvaluator
/// @notice The evaluator of every Hireling v1 job (ADR-0011; the full contract is in `IHirelingEvaluator`). Forked
///         from the legacy `JobsEvaluator` without contests. The windows, approver and arbitrator are each listing's
///         own (`holding.termsOf`). Every terminal path records the outcome and any slash before it touches a bond or
///         the core (M1), pays the worker through `_payWorker` (M2), and decides a job at most once.
contract HirelingEvaluator is IHirelingEvaluator, EIP712, Ownable2Step, ReentrancyGuardTransient {
    bytes32 public constant EVIDENCE_TYPEHASH = keccak256(
        "EvidenceAttestation(uint256 jobId,bytes32 submissionHash,bytes32 policyHash,bytes32 repo,bytes32 headSha,bytes32 testedSha,bytes32 checkRunsHash,uint8 conclusion,uint256 validUntil)"
    );
    bytes32 public constant RULING_TYPEHASH = keccak256(
        "Ruling(uint256 jobId,bool forWorker,bool slashLoser,bytes32 reasonHash,uint256 deadline,uint256 nonce)"
    );
    /// @dev Upper bound for the ERC-8004 feedback call. Monad charges the gas limit, so this is also a cost cap.
    uint256 public constant FEEDBACK_GAS = 400_000;

    ERC8183 public immutable core;
    IHirelingHolding public immutable holding;
    IERC8004Reputation public immutable reputation;

    mapping(uint256 jobId => Case) internal _cases;
    mapping(address arbitrator => mapping(uint256 nonce => bool)) public rulingNonceUsed;
    mapping(uint256 jobId => mapping(address verifier => Evidence)) public evidence;
    mapping(address verifier => bool) public verifiers;
    mapping(address verifier => mapping(bytes32 digest => bool)) public usedDigest;

    constructor(ERC8183 core_, IHirelingHolding holding_, IERC8004Reputation reputation_)
        EIP712("AgentJobsEvaluator", "1")
        Ownable(msg.sender)
    {
        if (address(core_) == address(0) || address(holding_) == address(0)) revert ZeroAddress();
        core = core_;
        holding = holding_;
        reputation = reputation_;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        verifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Parties
    // ---------------------------------------------------------------------------------------------

    function accept(uint256 jobId) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (t.approver != msg.sender) revert NotApprover();
        Case storage c = _cases[jobId];
        _requireOpen(jobId, t, c);
        if (c.disputedAt != 0) revert DisputeOpen();
        c.outcome = Outcome.Accepted;
        emit Accepted(jobId, msg.sender);
        holding.returnBonds(jobId);
        _payWorker(jobId, "accepted");
        _feedback(jobId, 1, "completed");
    }

    function reject(uint256 jobId, Violation violation, bytes32 reasonHash) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (t.approver != msg.sender) revert NotApprover();
        Case storage c = _cases[jobId];
        uint48 submittedAt = _requireOpen(jobId, t, c);
        if (c.rejectedAt != 0) revert AlreadyRejected();
        if (submittedAt > t.deliveryDeadline) revert LateSubmission();
        // The review window closes on its own: once silence has become acceptance, a late rejection must not be able
        // to race the permissionless `completeAfterSilence` (R16-01).
        if (block.timestamp > uint256(submittedAt) + t.reviewWindow) revert ReviewWindowClosed();
        c.rejectedAt = uint48(block.timestamp);
        c.violation = violation;
        c.rejectionReason = reasonHash;
        emit Rejected(jobId, msg.sender, violation, reasonHash);
    }

    function dispute(uint256 jobId) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (t.worker != msg.sender || msg.sender == address(0)) revert NotProvider();
        Case storage c = _cases[jobId];
        _requireOpen(jobId, t, c);
        uint48 at = c.rejectedAt;
        if (at == 0) revert NotRejected();
        if (c.disputedAt != 0) revert AlreadyDisputed();
        if (block.timestamp > uint256(at) + t.disputeWindow) revert WindowClosed();
        c.disputedAt = uint48(block.timestamp);
        emit Disputed(jobId, msg.sender);
    }

    function rule(uint256 jobId, bool forWorker, bool slashLoser, bytes32 reasonHash) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (msg.sender != t.arbitrator || msg.sender == address(0)) revert NotArbitrator();
        _rule(jobId, t, forWorker, slashLoser, reasonHash);
    }

    function ruleWithSignature(Ruling calldata r, bytes calldata sig) external nonReentrant {
        if (block.timestamp > r.deadline) revert RulingExpired();
        IHirelingHolding.Terms memory t = holding.termsOf(r.jobId);
        if (rulingNonceUsed[t.arbitrator][r.nonce]) revert RulingNonceUsed();
        if (!Signatures.isValid(t.arbitrator, rulingDigest(r), sig)) revert InvalidSignature();
        rulingNonceUsed[t.arbitrator][r.nonce] = true;
        _rule(r.jobId, t, r.forWorker, r.slashLoser, r.reasonHash);
    }

    function rulingDigest(Ruling calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(RULING_TYPEHASH, r.jobId, r.forWorker, r.slashLoser, r.reasonHash, r.deadline, r.nonce)
            )
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------------------------------

    function attachEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes calldata sig)
        external
        nonReentrant
    {
        if (!verifiers[verifier]) revert NotVerifier();
        bytes32 digest = _evidenceDigest(a);
        if (!Signatures.isValid(verifier, digest, sig)) revert InvalidSignature();
        _storeEvidence(jobId, a, verifier, digest);
    }

    function attachEvidenceDirect(uint256 jobId, EvidenceAttestation calldata a) external nonReentrant {
        if (!verifiers[msg.sender]) revert NotVerifier();
        _storeEvidence(jobId, a, msg.sender, _evidenceDigest(a));
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless timeouts
    // ---------------------------------------------------------------------------------------------

    function completeAfterSilence(uint256 jobId) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        uint48 submittedAt = _requireOpen(jobId, t, c);
        if (c.rejectedAt != 0) revert AlreadyRejected();
        if (submittedAt > t.deliveryDeadline) revert LateSubmission();
        if (block.timestamp <= uint256(submittedAt) + t.reviewWindow) revert WindowOpen();
        c.outcome = Outcome.Silence;
        emit TimedOut(jobId, "review-window");
        holding.returnBonds(jobId);
        _payWorker(jobId, "silence-is-acceptance");
        _feedback(jobId, 1, "completed");
    }

    function rejectAfterWindow(uint256 jobId) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        uint48 at = c.rejectedAt;
        if (at == 0) revert NotRejected();
        if (c.disputedAt != 0) revert AlreadyDisputed();
        if (block.timestamp <= uint256(at) + t.disputeWindow) revert WindowOpen();
        _requireOpen(jobId, t, c);
        Violation v = c.violation;
        c.outcome = Outcome.RejectionFinal;
        if (v != Violation.None) c.slashed = SlashedSide.Worker;
        emit TimedOut(jobId, "dispute-window");
        if (v != Violation.None) holding.burnBond(jobId, IHirelingHolding.Side.Worker);
        holding.returnBonds(jobId);
        _refundCreator(jobId, "rejection-undisputed");
        _feedback(jobId, 0, _rejectionTag(v));
    }

    function refundAfterArbitrationTimeout(uint256 jobId) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        // A ruling whose core call was deferred still stands: the timeout can never turn it into a refund.
        if (c.outcome != Outcome.None) revert AlreadyRuled();
        uint48 at = c.disputedAt;
        if (at == 0) revert NotDisputed();
        if (block.timestamp <= uint256(at) + t.arbitrationWindow) revert WindowOpen();
        _requireOpen(jobId, t, c);
        c.outcome = Outcome.ArbitrationTimeout;
        emit TimedOut(jobId, "arbitration-window");
        holding.returnBonds(jobId);
        _refundCreator(jobId, "arbitrator-inactive");
    }

    function rejectAfterDeliveryDeadline(uint256 jobId) external nonReentrant {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        Case storage c = _cases[jobId];
        if (c.outcome != Outcome.None) revert AlreadyResolved();
        if (t.funded == 0) revert NotFunded();
        ERC8183.Job memory job = core.getJob(jobId);
        bool missed = job.status == ERC8183.JobStatus.Funded
            || (job.status == ERC8183.JobStatus.Submitted && job.submittedAt > t.deliveryDeadline);
        if (!missed) revert NotLate();
        if (block.timestamp <= t.deliveryDeadline) revert WindowOpen();
        c.outcome = Outcome.DeliveryMissed;
        c.slashed = SlashedSide.Worker;
        emit TimedOut(jobId, "delivery-deadline");
        holding.burnBond(jobId, IHirelingHolding.Side.Worker);
        holding.returnBonds(jobId);
        _refundCreator(jobId, "not-delivered");
        _feedback(jobId, 0, "not-delivered");
    }

    // ---------------------------------------------------------------------------------------------
    // Views read by Holding's settle
    // ---------------------------------------------------------------------------------------------

    function earnedByWorker(uint256 jobId) external view returns (bool) {
        Case memory c = _cases[jobId];
        if (c.payoutDeferred) return true;
        if (c.outcome != Outcome.None) {
            return c.outcome == Outcome.Accepted || c.outcome == Outcome.Silence || c.outcome == Outcome.RuledForWorker;
        }
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (t.funded == 0 || c.rejectedAt != 0) return false;
        uint48 submittedAt = core.getJob(jobId).submittedAt;
        if (submittedAt == 0 || submittedAt > t.deliveryDeadline) return false;
        return block.timestamp > uint256(submittedAt) + t.reviewWindow;
    }

    function workerPenaltyDue(uint256 jobId) external view returns (bool) {
        Case memory c = _cases[jobId];
        if (c.outcome != Outcome.None) return c.slashed == SlashedSide.Worker;
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (t.funded == 0) return false;
        uint48 submittedAt = core.getJob(jobId).submittedAt;
        if ((submittedAt == 0 || submittedAt > t.deliveryDeadline) && block.timestamp > t.deliveryDeadline) {
            return true;
        }
        return c.rejectedAt != 0 && c.disputedAt == 0 && c.violation != Violation.None
            && block.timestamp > uint256(c.rejectedAt) + t.disputeWindow;
    }

    function creatorPenaltyDue(uint256 jobId) external view returns (bool) {
        return _cases[jobId].slashed == SlashedSide.Creator;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function caseOf(uint256 jobId) external view returns (Case memory) {
        return _cases[jobId];
    }

    function rejectedAt(uint256 jobId) external view returns (uint48) {
        return _cases[jobId].rejectedAt;
    }

    function disputedAt(uint256 jobId) external view returns (uint48) {
        return _cases[jobId].disputedAt;
    }

    function violationOf(uint256 jobId) external view returns (Violation) {
        return _cases[jobId].violation;
    }

    function rejectionReasonOf(uint256 jobId) external view returns (bytes32) {
        return _cases[jobId].rejectionReason;
    }

    function outcome(uint256 jobId) external view returns (Outcome) {
        return _cases[jobId].outcome;
    }

    function slashed(uint256 jobId) external view returns (SlashedSide) {
        return _cases[jobId].slashed;
    }

    function payoutDeferred(uint256 jobId) external view returns (bool) {
        return _cases[jobId].payoutDeferred;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    /// @dev A job still waiting on a decision: no outcome, the core job Submitted, and funded by Holding.
    function _requireOpen(uint256 jobId, IHirelingHolding.Terms memory t, Case storage c)
        private
        view
        returns (uint48 submittedAt)
    {
        if (c.outcome != Outcome.None) revert AlreadyResolved();
        ERC8183.Job memory job = core.getJob(jobId);
        if (job.status != ERC8183.JobStatus.Submitted) revert NotSubmitted();
        if (t.funded == 0) revert NeverFunded();
        return job.submittedAt;
    }

    /// @dev M1: checks, then the outcome and the slash are recorded and emitted, then the loser's bond burns and the
    ///      rest are released, and only then does the core move the reward.
    function _rule(uint256 jobId, IHirelingHolding.Terms memory t, bool forWorker, bool slashLoser, bytes32 reasonHash)
        private
    {
        Case storage c = _cases[jobId];
        if (c.outcome != Outcome.None) revert AlreadyRuled();
        uint48 at = c.disputedAt;
        if (at == 0) revert NotDisputed();
        // Strict cutoff: after the arbitration window only `refundAfterArbitrationTimeout` may settle (R16-01).
        if (block.timestamp > uint256(at) + t.arbitrationWindow) revert ArbitrationWindowClosed();
        _requireOpen(jobId, t, c);
        Violation v = c.violation;
        // Upholding a violation needs a rejection that named one.
        if (!forWorker && slashLoser && v == Violation.None) revert InvalidRuling();

        c.outcome = forWorker ? Outcome.RuledForWorker : Outcome.RuledForCreator;
        if (slashLoser) c.slashed = forWorker ? SlashedSide.Creator : SlashedSide.Worker;
        emit Ruled(jobId, t.arbitrator, forWorker, slashLoser, reasonHash);
        if (slashLoser) {
            holding.burnBond(jobId, forWorker ? IHirelingHolding.Side.Creator : IHirelingHolding.Side.Worker);
        }
        holding.returnBonds(jobId);
        if (forWorker) {
            _payWorker(jobId, "ruled-for-worker");
            _feedback(jobId, 1, "completed");
        } else {
            _refundCreator(jobId, "ruled-for-creator");
            _feedback(jobId, 0, slashLoser ? _rejectionTag(v) : "rejected");
        }
    }

    /// @dev M2. A failed `complete` (a token refusing the worker, or a starved call) defers the payout instead of
    ///      blocking the decision: the reward goes to Holding through `reject`, or later through the core's
    ///      `claimRefund`, and Holding's `settle` pays the worker because `earnedByWorker` stays true. The revert data
    ///      is never copied. A paused core reverts the whole call, so a pause never becomes a deferral.
    function _payWorker(uint256 jobId, bytes32 reason) private {
        try core.complete(jobId, reason, "") {}
        catch {
            if (core.paused()) revert CorePaused();
            _cases[jobId].payoutDeferred = true;
            bool refunded;
            try core.reject(jobId, "payout-deferred", "") {
                refunded = true;
            } catch {}
            emit PayoutDeferred(jobId, refunded);
        }
    }

    /// @dev The refund side of M2: a failed `reject` leaves the reward in the core until its `claimRefund`; the
    ///      recorded outcome already decides where Holding sends it.
    function _refundCreator(uint256 jobId, bytes32 reason) private {
        try core.reject(jobId, reason, "") {}
        catch {
            if (core.paused()) revert CorePaused();
            emit RefundDeferred(jobId);
        }
    }

    function _rejectionTag(Violation v) private pure returns (string memory) {
        if (v == Violation.Quality) return "rejected-quality";
        if (v == Violation.Falsified) return "rejected-falsified";
        return "rejected";
    }

    function _evidenceDigest(EvidenceAttestation calldata a) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    EVIDENCE_TYPEHASH,
                    a.jobId,
                    a.submissionHash,
                    a.policyHash,
                    a.repo,
                    a.headSha,
                    a.testedSha,
                    a.checkRunsHash,
                    a.conclusion,
                    a.validUntil
                )
            )
        );
    }

    function _storeEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes32 digest) private {
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        if (a.jobId != jobId || t.creator == address(0)) revert EvidenceJobMismatch();
        if (a.policyHash != t.policyHash) revert EvidencePolicyMismatch();
        if (block.timestamp > a.validUntil) revert EvidenceExpired();
        // Same verifier, same statement: acknowledged once, never a second endorsement (R16-06).
        if (usedDigest[verifier][digest]) return;
        usedDigest[verifier][digest] = true;
        evidence[jobId][verifier] = Evidence({
            digest: digest,
            submissionHash: a.submissionHash,
            policyHash: a.policyHash,
            testedSha: a.testedSha,
            at: uint48(block.timestamp),
            validUntil: uint48(a.validUntil),
            conclusion: a.conclusion
        });
        emit EvidenceAttached(
            jobId, verifier, digest, a.submissionHash, a.policyHash, a.testedSha, a.conclusion, a.validUntil
        );
    }

    /// @dev Reason-aware ERC-8004 feedback for the worker's agent, as the client of record. Bounded gas and
    ///      `try/catch`: a registry failure is observable and never undoes a settlement (R16-10). A call whose gas
    ///      cannot cover the whole budget reverts instead, so estimation never settles on a limit that starves it.
    function _feedback(uint256 jobId, int128 value, string memory tag) private {
        if (address(reputation) == address(0)) return;
        uint256 agentId = core.getJob(jobId).providerAgentId;
        if (agentId == 0) return;
        uint256 needed = FEEDBACK_GAS * 64 / 63 + 10_000;
        if (gasleft() < needed) revert FeedbackGasTooLow(gasleft(), needed);
        try reputation.giveFeedback{gas: FEEDBACK_GAS}(agentId, value, 0, "agent-jobs", tag, "", "", bytes32(jobId)) {
            emit FeedbackRecorded(jobId, agentId, value, tag);
        } catch (bytes memory reason) {
            emit FeedbackFailed(jobId, agentId, reason);
        }
    }
}

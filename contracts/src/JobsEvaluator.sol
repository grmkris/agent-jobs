// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Signatures} from "./Signatures.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {JobHolding} from "./JobHolding.sol";
import {IERC8004Reputation} from "./vendor/erc8004/IERC8004.sol";

/// @title JobsEvaluator
/// @notice The evaluator of every listed job (spec §4). It keeps the minimal dispute state on-chain and only
///         ever makes terminal calls on the core: `complete` pays the worker from escrow, `reject` refunds the
///         creator through Holding. The listing's approver judges the work; a rejection names a violation, is
///         recorded here and opens a dispute window; nothing moves until a ruling or a permissionless timeout.
///         Silence after a timely final submission is acceptance.
///
///         Payment and violations are separate findings (R20). Slashable: a funded worker missing the delivery
///         deadline (burned permissionlessly after it), poor work against the published criteria (`Quality`) and
///         falsified evidence (`Falsified`), each burning the offender's whole posted bond only when the filing
///         window passes undisputed or the arbitrator upholds it; a ruling may instead find the rejection in bad
///         faith and burn the creator's bond. A `None` rejection, a lost dispute, approver silence and arbitrator
///         inactivity never burn.
///
///         Evidence: a registered verifier (our attester, or a Chainlink CRE receiver) can attach a signed
///         `EvidenceAttestation` about the named CI checks of the tested commit. It records what that verifier
///         said and moves no money; payment gating on it is a later, opt-in policy.
contract JobsEvaluator is EIP712 {
    struct EvidenceAttestation {
        uint256 jobId;
        bytes32 submissionHash;
        bytes32 policyHash;
        bytes32 repo;
        bytes32 headSha;
        bytes32 testedSha;
        bytes32 checkRunsHash;
        uint8 conclusion;
        uint256 validUntil;
    }

    /// @dev One verifier's attestation for one job. The binding fields let a reader check what it covers
    ///      without fetching the report; matching `submissionHash` to the finalized deliverable is the
    ///      indexer's job, because the core keeps the deliverable only in its `JobSubmitted` event (R16-07).
    struct Evidence {
        bytes32 digest;
        bytes32 submissionHash;
        bytes32 policyHash;
        bytes32 testedSha;
        uint48 at;
        uint48 validUntil;
        uint8 conclusion;
    }

    bytes32 public constant EVIDENCE_TYPEHASH = keccak256(
        "EvidenceAttestation(uint256 jobId,bytes32 submissionHash,bytes32 policyHash,bytes32 repo,bytes32 headSha,bytes32 testedSha,bytes32 checkRunsHash,uint8 conclusion,uint256 validUntil)"
    );

    /// @dev Upper bound for the ERC-8004 feedback call. Monad charges the gas limit, so this is also a cost cap. A
    ///      first feedback for an agent costs ~270k on the testnet registry (cold storage), so the cap leaves margin.
    uint256 public constant FEEDBACK_GAS = 400_000;

    enum Violation {
        None,
        Quality,
        Falsified
    }

    /// @notice The arbitrator's decision on a disputed job, signed off-chain by any harness and relayed by anyone
    ///         (`ruleWithSignature`). `reasonHash` points at the published reasoning.
    struct Ruling {
        uint256 jobId;
        bool forWorker;
        bool slashLoser;
        bytes32 reasonHash;
        uint256 deadline;
        uint256 nonce;
    }

    bytes32 public constant RULING_TYPEHASH = keccak256(
        "Ruling(uint256 jobId,bool forWorker,bool slashLoser,bytes32 reasonHash,uint256 deadline,uint256 nonce)"
    );

    ERC8183 public immutable core;
    JobHolding public immutable holding;
    /// @notice ERC-8004 Reputation Registry; zero disables feedback (tests, chains without the registry).
    IERC8004Reputation public immutable reputation;
    address public immutable admin;
    /// @notice Pinned at deploy; never replaced mid-agreement.
    address public immutable arbitrator;
    uint48 public immutable reviewWindow;
    uint48 public immutable disputeWindow;
    uint48 public immutable arbitrationWindow;
    uint48 public immutable margin;

    mapping(uint256 jobId => uint48) public rejectedAt;
    mapping(uint256 jobId => uint48) public disputedAt;
    mapping(uint256 jobId => Violation) public violationOf;
    mapping(uint256 jobId => bytes32) public rejectionReasonOf;
    /// @notice Ruling nonces spent by `ruleWithSignature`.
    mapping(uint256 nonce => bool) public rulingNonceUsed;
    /// @notice Per-verifier evidence: two verifiers attesting the same statement are both kept (R16-06).
    mapping(uint256 jobId => mapping(address verifier => Evidence)) public evidence;
    mapping(address => bool) public verifiers;
    mapping(address verifier => mapping(bytes32 digest => bool)) public usedDigest;

    event Accepted(uint256 indexed jobId, address indexed approver);
    event Rejected(uint256 indexed jobId, address indexed approver, Violation violation, bytes32 reasonHash);
    event Disputed(uint256 indexed jobId, address indexed worker);
    event Ruled(uint256 indexed jobId, bool forWorker, bool slashLoser, bytes32 reasonHash);
    event TimedOut(uint256 indexed jobId, bytes32 reason);
    /// @dev Every binding field, so an indexer can keep each statement without reading storage (R114, evidence
    ///      history).
    event EvidenceAttached(
        uint256 indexed jobId,
        address indexed verifier,
        bytes32 digest,
        bytes32 submissionHash,
        bytes32 policyHash,
        bytes32 testedSha,
        uint8 conclusion,
        uint256 validUntil
    );
    event VerifierSet(address indexed verifier, bool allowed);
    event FeedbackRecorded(uint256 indexed jobId, uint256 indexed agentId, int128 value, string tag);
    event FeedbackFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason);

    error NotAdmin();
    /// @dev The transaction's gas cannot cover the feedback call's full budget (see `_feedback`).
    error FeedbackGasTooLow(uint256 left, uint256 needed);
    error NotApprover();
    error NotProvider();
    error NotArbitrator();
    error NotVerifier();
    error NotSubmitted();
    error NotFunded();
    error NeverFunded();
    error AlreadyRejected();
    error NotRejected();
    error AlreadyDisputed();
    error NotDisputed();
    error WindowClosed();
    error WindowOpen();
    error EvidenceExpired();
    error EvidenceReplayed();
    error EvidenceJobMismatch();
    error EvidencePolicyMismatch();
    error ReviewWindowClosed();
    error ArbitrationWindowClosed();
    error InvalidSignature();
    error DisputeOpen();
    error LateSubmission();
    error NotLate();
    error InvalidRuling();
    error RulingExpired();
    error RulingNonceUsed();
    error NotHolding();

    constructor(
        ERC8183 core_,
        JobHolding holding_,
        IERC8004Reputation reputation_,
        address arbitrator_,
        uint48 reviewWindow_,
        uint48 disputeWindow_,
        uint48 arbitrationWindow_,
        uint48 margin_
    ) EIP712("SidequestEvaluator", "1") {
        core = core_;
        holding = holding_;
        reputation = reputation_;
        admin = msg.sender;
        arbitrator = arbitrator_;
        reviewWindow = reviewWindow_;
        disputeWindow = disputeWindow_;
        arbitrationWindow = arbitrationWindow_;
        margin = margin_;
    }

    /// @notice How long settlement can take after the delivery deadline; Holding adds it to `expiredAt`.
    function settlementWindow() external view returns (uint48) {
        return reviewWindow + disputeWindow + arbitrationWindow + margin;
    }

    // ---------------------------------------------------------------------------------------------
    // Admin: the verifier set (visible, documented)
    // ---------------------------------------------------------------------------------------------

    function setVerifier(address verifier, bool allowed) external {
        if (msg.sender != admin) revert NotAdmin();
        verifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    // ---------------------------------------------------------------------------------------------
    // Parties
    // ---------------------------------------------------------------------------------------------

    /// @notice The listing's approver accepts the final submission: the reward leaves escrow, both bonds return.
    ///         Before a dispute this is also a reconsideration of a rejection; once the worker has disputed, only a
    ///         ruling or the arbitration timeout settles, so a pending bad-faith finding cannot be dodged by paying
    ///         late (R114-02). A late submission may be accepted until someone executes the missed-delivery burn.
    function accept(uint256 jobId) external {
        if (holding.approverOf(jobId) != msg.sender) revert NotApprover();
        _requireSubmitted(jobId);
        if (disputedAt[jobId] != 0) revert DisputeOpen();
        emit Accepted(jobId, msg.sender);
        _complete(jobId, "accepted");
    }

    /// @notice The listing's approver rejects a timely submission within the review window, naming a violation
    ///         and a reason hash. Nothing moves: the job stays Submitted and the dispute window opens.
    function reject(uint256 jobId, Violation violation, bytes32 reasonHash) external {
        if (holding.approverOf(jobId) != msg.sender) revert NotApprover();
        ERC8183.Job memory job = _requireSubmitted(jobId);
        if (rejectedAt[jobId] != 0) revert AlreadyRejected();
        if (job.submittedAt > holding.deliveryDeadlineOf(jobId)) revert LateSubmission();
        // The review window closes on its own: once silence has become acceptance, a late rejection must not
        // be able to race the permissionless `completeAfterSilence` (R16-01).
        if (block.timestamp > uint256(job.submittedAt) + reviewWindow) revert ReviewWindowClosed();
        rejectedAt[jobId] = uint48(block.timestamp);
        violationOf[jobId] = violation;
        rejectionReasonOf[jobId] = reasonHash;
        emit Rejected(jobId, msg.sender, violation, reasonHash);
    }

    /// @notice The worker disputes a rejection within the dispute window.
    function dispute(uint256 jobId) external {
        if (core.getJob(jobId).provider != msg.sender) revert NotProvider();
        // A job settled by a pre-dispute reconsideration (or anything else) has nothing left to dispute.
        _requireSubmitted(jobId);
        uint48 at = rejectedAt[jobId];
        if (at == 0) revert NotRejected();
        if (disputedAt[jobId] != 0) revert AlreadyDisputed();
        if (block.timestamp > uint256(at) + disputeWindow) revert WindowClosed();
        disputedAt[jobId] = uint48(block.timestamp);
        emit Disputed(jobId, msg.sender);
    }

    /// @notice The arbitrator rules twice in one call: who gets the reward, and whether the loser broke a
    ///         slashable obligation. For the worker, `slashLoser` finds the rejection in bad faith and burns the
    ///         creator's bond; for the creator, it upholds the named violation and burns the worker's bond, which
    ///         needs a rejection that named one. The other side's bond always returns.
    function rule(uint256 jobId, bool forWorker, bool slashLoser, bytes32 reasonHash) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        _rule(jobId, forWorker, slashLoser, reasonHash);
    }

    /// @notice The same ruling, signed by the arbitrator as an EIP-712 `Ruling` and sent by anyone, under the
    ///         same arbitration cutoff. Lets any harness arbitrate without holding gas.
    function ruleWithSignature(Ruling calldata r, bytes calldata sig) external {
        if (block.timestamp > r.deadline) revert RulingExpired();
        if (rulingNonceUsed[r.nonce]) revert RulingNonceUsed();
        if (!Signatures.isValid(arbitrator, rulingDigest(r), sig)) revert InvalidSignature();
        rulingNonceUsed[r.nonce] = true;
        _rule(r.jobId, r.forWorker, r.slashLoser, r.reasonHash);
    }

    /// @notice The EIP-712 digest the arbitrator signs for `r` (domain "SidequestEvaluator", version "1").
    function rulingDigest(Ruling calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(RULING_TYPEHASH, r.jobId, r.forWorker, r.slashLoser, r.reasonHash, r.deadline, r.nonce))
        );
    }

    /// @notice The last step of a contest `award`, callable only by Holding inside that transaction: the approver
    ///         chose this entry, so it completes like an acceptance (reward to the entrant, creator bond back,
    ///         feedback).
    function completeAward(uint256 jobId) external {
        if (msg.sender != address(holding)) revert NotHolding();
        _requireSubmitted(jobId);
        emit Accepted(jobId, holding.approverOf(jobId));
        _complete(jobId, "awarded");
    }

    // ---------------------------------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------------------------------

    /// @notice A registered verifier's signed statement about the named checks of the tested commit. Stored,
    ///         emitted, never acted on here. Raw ECDSA is checked before ERC-1271, including delegated EOAs.
    function attachEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes calldata sig)
        external
    {
        if (!verifiers[verifier]) revert NotVerifier();
        bytes32 digest = _evidenceDigest(a);
        if (!Signatures.isValid(verifier, digest, sig)) revert InvalidSignature();
        _storeEvidence(jobId, a, verifier, digest);
    }

    /// @notice The same, for a verifier that is itself a contract calling us (the CRE receiver): the call is
    ///         the signature.
    function attachEvidenceDirect(uint256 jobId, EvidenceAttestation calldata a) external {
        if (!verifiers[msg.sender]) revert NotVerifier();
        _storeEvidence(jobId, a, msg.sender, _evidenceDigest(a));
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless timeouts
    // ---------------------------------------------------------------------------------------------

    /// @notice No approver decision within the review window on a timely submission: silence is acceptance.
    ///         A late submission earns no silence right (hires only; an awarded contest entry is completed inside
    ///         the award).
    function completeAfterSilence(uint256 jobId) external {
        ERC8183.Job memory job = _requireSubmitted(jobId);
        if (rejectedAt[jobId] != 0) revert AlreadyRejected();
        if (job.submittedAt > holding.deliveryDeadlineOf(jobId)) revert LateSubmission();
        if (block.timestamp <= uint256(job.submittedAt) + reviewWindow) revert WindowOpen();
        emit TimedOut(jobId, "review-window");
        _complete(jobId, "silence-is-acceptance");
    }

    /// @notice A rejection nobody disputed within the dispute window becomes final. A named violation burns the
    ///         worker's whole bond; `None` returns both.
    function rejectAfterWindow(uint256 jobId) external {
        uint48 at = rejectedAt[jobId];
        if (at == 0) revert NotRejected();
        if (disputedAt[jobId] != 0) revert AlreadyDisputed();
        if (block.timestamp <= uint256(at) + disputeWindow) revert WindowOpen();
        _requireSubmitted(jobId);
        emit TimedOut(jobId, "dispute-window");
        Violation v = violationOf[jobId];
        core.reject(jobId, "rejection-undisputed", "");
        if (v != Violation.None) holding.burnBond(jobId, JobHolding.Side.Worker);
        holding.returnBonds(jobId);
        _feedback(jobId, 0, _rejectionTag(v));
    }

    /// @notice The arbitrator never ruled: status quo, refund and both bonds back, and no feedback about the worker
    ///         (`skip-arb`). The README states this SLA is ours.
    function refundAfterArbitrationTimeout(uint256 jobId) external {
        uint48 at = disputedAt[jobId];
        if (at == 0) revert NotDisputed();
        if (block.timestamp <= uint256(at) + arbitrationWindow) revert WindowOpen();
        _requireSubmitted(jobId);
        emit TimedOut(jobId, "arbitration-window");
        core.reject(jobId, "arbitrator-inactive", "");
        holding.returnBonds(jobId);
    }

    /// @notice The missed-delivery burn, permissionless strictly after the delivery deadline: a funded job with no
    ///         timely final submission (none at all, or a late one nobody accepted). Refunds the reward, burns the
    ///         worker's whole bond, returns the creator's. Also clears a milestone claim filed directly on the core.
    function rejectAfterDeliveryDeadline(uint256 jobId) external {
        ERC8183.Job memory job = core.getJob(jobId);
        if (!holding.isFunded(jobId)) revert NotFunded();
        uint48 deadline = holding.deliveryDeadlineOf(jobId);
        bool missed = job.status == ERC8183.JobStatus.Funded
            || (job.status == ERC8183.JobStatus.Submitted && job.submittedAt > deadline);
        if (!missed) revert NotLate();
        if (block.timestamp <= deadline) revert WindowOpen();
        emit TimedOut(jobId, "delivery-deadline");
        core.reject(jobId, "not-delivered", "");
        holding.burnBond(jobId, JobHolding.Side.Worker);
        holding.returnBonds(jobId);
        _feedback(jobId, 0, "not-delivered");
    }

    // ---------------------------------------------------------------------------------------------
    // Views for Holding's settlement after a core refund (R114-03)
    // ---------------------------------------------------------------------------------------------

    /// @notice Whether the worker is owed the reward regardless of what the core did since: a funded job, submitted
    ///         by the delivery deadline, not rejected within the review window, and that window has passed.
    ///         Holding reads this after a core refund, so an earned silence payment survives the core's outer
    ///         expiry and a third party's `claimRefund` (R114-03). A late submission earns nothing by silence.
    function earnedByWorker(uint256 jobId) public view returns (bool) {
        if (!holding.isFunded(jobId) || rejectedAt[jobId] != 0) return false;
        uint48 submittedAt = core.getJob(jobId).submittedAt;
        if (submittedAt == 0 || submittedAt > holding.deliveryDeadlineOf(jobId)) return false;
        return block.timestamp > uint256(submittedAt) + reviewWindow;
    }

    /// @notice Whether the worker's bond is forfeit on the evidence so far, whatever the core did since: a missed
    ///         delivery past the deadline, or an undisputed rejection that named a violation past the filing
    ///         window. Holding burns instead of returning when it settles a bond no evaluator path settled, so a
    ///         direct `claimRefund` never releases a bond whose penalty is due.
    function workerPenaltyDue(uint256 jobId) public view returns (bool) {
        if (!holding.isFunded(jobId)) return false;
        uint48 deadline = holding.deliveryDeadlineOf(jobId);
        uint48 submittedAt = core.getJob(jobId).submittedAt;
        if ((submittedAt == 0 || submittedAt > deadline) && block.timestamp > deadline) return true;
        uint48 at = rejectedAt[jobId];
        return at != 0 && disputedAt[jobId] == 0 && violationOf[jobId] != Violation.None
            && block.timestamp > uint256(at) + disputeWindow;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _requireSubmitted(uint256 jobId) private view returns (ERC8183.Job memory job) {
        job = core.getJob(jobId);
        if (job.status != ERC8183.JobStatus.Submitted) revert NotSubmitted();
        if (!holding.isFunded(jobId)) revert NeverFunded();
    }

    function _rule(uint256 jobId, bool forWorker, bool slashLoser, bytes32 reasonHash) private {
        uint48 at = disputedAt[jobId];
        if (at == 0) revert NotDisputed();
        // Strict cutoff: after the arbitration window only `refundAfterArbitrationTimeout` may settle (R16-01).
        if (block.timestamp > uint256(at) + arbitrationWindow) revert ArbitrationWindowClosed();
        _requireSubmitted(jobId);
        Violation v = violationOf[jobId];
        // Upholding a violation needs a rejection that named one.
        if (!forWorker && slashLoser && v == Violation.None) revert InvalidRuling();
        emit Ruled(jobId, forWorker, slashLoser, reasonHash);
        if (forWorker) {
            core.complete(jobId, "ruled-for-worker", "");
            if (slashLoser) holding.burnBond(jobId, JobHolding.Side.Creator);
            holding.returnBonds(jobId);
            _feedback(jobId, 1, "completed");
        } else {
            core.reject(jobId, "ruled-for-creator", "");
            if (slashLoser) holding.burnBond(jobId, JobHolding.Side.Worker);
            holding.returnBonds(jobId);
            _feedback(jobId, 0, slashLoser ? _rejectionTag(v) : "rejected");
        }
    }

    function _complete(uint256 jobId, bytes32 reason) private {
        core.complete(jobId, reason, "");
        holding.returnBonds(jobId);
        _feedback(jobId, 1, "completed");
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

    function _storeEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes32 digest)
        private
    {
        if (a.jobId != jobId || holding.creatorOf(jobId) == address(0)) revert EvidenceJobMismatch();
        if (a.policyHash != holding.policyHashOf(jobId)) revert EvidencePolicyMismatch();
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

    /// @dev Reason-aware ERC-8004 feedback for the worker's agent, as the client of record: `completed` (1),
    ///      `not-delivered`, `rejected`, `rejected-quality`, `rejected-falsified` (0). Bounded gas and `try/catch`:
    ///      a registry failure is observable (`FeedbackFailed`) and never undoes a settlement that already moved
    ///      money (R16-10). Silent when no registry is configured or the job never had an agent.
    function _feedback(uint256 jobId, int128 value, string memory tag) internal virtual {
        if (address(reputation) == address(0)) return;
        uint256 agentId = core.getJob(jobId).providerAgentId;
        if (agentId == 0) return;
        // A caller's gas limit must cover the whole feedback budget. Otherwise gas estimation settles on a limit at
        // which the settlement succeeds and the feedback call, starved by the 63/64 rule, fails inside `try`: the
        // worker is paid but its reputation entry is silently lost (found live, testnet jobs 12 and 34).
        uint256 needed = FEEDBACK_GAS * 64 / 63 + 10_000;
        if (gasleft() < needed) revert FeedbackGasTooLow(gasleft(), needed);
        try reputation.giveFeedback{gas: FEEDBACK_GAS}(agentId, value, 0, "sidequest", tag, "", "", bytes32(jobId)) {
            emit FeedbackRecorded(jobId, agentId, value, tag);
        } catch (bytes memory reason) {
            emit FeedbackFailed(jobId, agentId, reason);
        }
    }
}

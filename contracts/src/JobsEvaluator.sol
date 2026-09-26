// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {JobHolding} from "./JobHolding.sol";
import {IERC8004Reputation} from "./vendor/erc8004/IERC8004.sol";

/// @title JobsEvaluator
/// @notice The evaluator of every listed job (spec §4). It keeps the minimal dispute state on-chain and only
///         ever makes terminal calls on the core: `complete` pays the worker from escrow, `reject` refunds the
///         creator through Holding. A creator's rejection is recorded here and opens a dispute window; nothing
///         moves until a ruling or a permissionless timeout. Silence after a finalized submission is acceptance.
///
///         Two findings, not one: `rule` settles the reward per `forWorker` and, separately, burns the loser's
///         collateral only when the arbitrator also finds a predefined violation (`slashLoser`). Timeouts never
///         burn. Losing a quality dispute is not misconduct.
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

    /// @dev Upper bound for the ERC-8004 feedback call. Monad charges the gas limit, so this is also a cost cap.
    uint256 public constant FEEDBACK_GAS = 300_000;

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
    /// @notice Per-verifier evidence: two verifiers attesting the same statement are both kept (R16-06).
    mapping(uint256 jobId => mapping(address verifier => Evidence)) public evidence;
    mapping(address => bool) public verifiers;
    mapping(address verifier => mapping(bytes32 digest => bool)) public usedDigest;

    event Accepted(uint256 indexed jobId, address indexed creator);
    event CreatorRejected(uint256 indexed jobId, address indexed creator);
    event Disputed(uint256 indexed jobId, address indexed worker);
    event Ruled(uint256 indexed jobId, bool forWorker, bool slashLoser);
    event TimedOut(uint256 indexed jobId, bytes32 reason);
    event EvidenceAttached(
        uint256 indexed jobId, address indexed verifier, bytes32 digest, bytes32 testedSha, uint8 conclusion
    );
    event VerifierSet(address indexed verifier, bool allowed);
    event FeedbackRecorded(uint256 indexed jobId, uint256 indexed agentId, bool completed);
    event FeedbackFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason);

    error NotAdmin();
    error NotCreator();
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

    constructor(
        ERC8183 core_,
        JobHolding holding_,
        IERC8004Reputation reputation_,
        address arbitrator_,
        uint48 reviewWindow_,
        uint48 disputeWindow_,
        uint48 arbitrationWindow_,
        uint48 margin_
    ) EIP712("AgentJobsEvaluator", "1") {
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

    /// @notice The creator accepts the finalized submission: the reward leaves escrow, both bonds return.
    function accept(uint256 jobId) external {
        if (holding.creatorOf(jobId) != msg.sender) revert NotCreator();
        _requireSubmitted(jobId);
        emit Accepted(jobId, msg.sender);
        _complete(jobId, "accepted");
    }

    /// @notice The creator rejects. Nothing moves: the job stays Submitted and the dispute window opens.
    function creatorReject(uint256 jobId) external {
        if (holding.creatorOf(jobId) != msg.sender) revert NotCreator();
        ERC8183.Job memory job = _requireSubmitted(jobId);
        if (rejectedAt[jobId] != 0) revert AlreadyRejected();
        // The review window closes on its own: once silence has become acceptance, a late rejection must not
        // be able to race the permissionless `completeAfterSilence` (R16-01).
        if (block.timestamp > uint256(job.submittedAt) + reviewWindow) revert ReviewWindowClosed();
        rejectedAt[jobId] = uint48(block.timestamp);
        emit CreatorRejected(jobId, msg.sender);
    }

    /// @notice The worker disputes a rejection within the dispute window.
    function dispute(uint256 jobId) external {
        if (core.getJob(jobId).provider != msg.sender) revert NotProvider();
        uint48 at = rejectedAt[jobId];
        if (at == 0) revert NotRejected();
        if (disputedAt[jobId] != 0) revert AlreadyDisputed();
        if (block.timestamp > uint256(at) + disputeWindow) revert WindowClosed();
        disputedAt[jobId] = uint48(block.timestamp);
        emit Disputed(jobId, msg.sender);
    }

    /// @notice The arbitrator rules twice in one call: who gets the reward, and whether the loser violated a
    ///         predefined obligation. Only the second finding burns collateral; the other side's bond always
    ///         returns.
    function rule(uint256 jobId, bool forWorker, bool slashLoser) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        uint48 at = disputedAt[jobId];
        if (at == 0) revert NotDisputed();
        // Strict cutoff: after the arbitration window only `refundAfterArbitrationTimeout` may settle (R16-01).
        if (block.timestamp > uint256(at) + arbitrationWindow) revert ArbitrationWindowClosed();
        _requireSubmitted(jobId);
        emit Ruled(jobId, forWorker, slashLoser);
        if (forWorker) {
            core.complete(jobId, "ruled-for-worker", "");
            if (slashLoser) holding.burnBond(jobId, JobHolding.Side.Creator);
        } else {
            core.reject(jobId, "ruled-for-creator", "");
            if (slashLoser) holding.burnBond(jobId, JobHolding.Side.Worker);
        }
        holding.returnBonds(jobId);
        _recordOutcome(jobId, forWorker);
    }

    // ---------------------------------------------------------------------------------------------
    // Evidence
    // ---------------------------------------------------------------------------------------------

    /// @notice A registered verifier's signed statement about the named checks of the tested commit. Stored,
    ///         emitted, never acted on here. `SignatureChecker` accepts EOA and ERC-1271 signers.
    function attachEvidence(uint256 jobId, EvidenceAttestation calldata a, address verifier, bytes calldata sig)
        external
    {
        if (!verifiers[verifier]) revert NotVerifier();
        bytes32 digest = _evidenceDigest(a);
        if (!SignatureChecker.isValidSignatureNow(verifier, digest, sig)) revert InvalidSignature();
        _storeEvidence(jobId, a, verifier, digest);
    }

    /// @notice The same, for a verifier that is itself a contract calling us (the CRE receiver): the call is
    ///         the signature.
    function attachEvidenceDirect(uint256 jobId, EvidenceAttestation calldata a) external {
        if (!verifiers[msg.sender]) revert NotVerifier();
        _storeEvidence(jobId, a, msg.sender, _evidenceDigest(a));
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless timeouts (never burn)
    // ---------------------------------------------------------------------------------------------

    /// @notice No creator decision within the review window: silence is acceptance (hire-first only; a contest
    ///         has a selection deadline instead and its winner's agreement is hire-first from then on).
    function completeAfterSilence(uint256 jobId) external {
        ERC8183.Job memory job = _requireSubmitted(jobId);
        if (rejectedAt[jobId] != 0) revert AlreadyRejected();
        if (block.timestamp <= uint256(job.submittedAt) + reviewWindow) revert WindowOpen();
        emit TimedOut(jobId, "review-window");
        _complete(jobId, "silence-is-acceptance");
    }

    /// @notice A rejection nobody disputed within the dispute window becomes final.
    function rejectAfterWindow(uint256 jobId) external {
        uint48 at = rejectedAt[jobId];
        if (at == 0) revert NotRejected();
        if (disputedAt[jobId] != 0) revert AlreadyDisputed();
        if (block.timestamp <= uint256(at) + disputeWindow) revert WindowOpen();
        _requireSubmitted(jobId);
        emit TimedOut(jobId, "dispute-window");
        _reject(jobId, "rejection-undisputed");
    }

    /// @notice The arbitrator never ruled: status quo, refund and both bonds back. The README states this SLA
    ///         is ours.
    function refundAfterArbitrationTimeout(uint256 jobId) external {
        uint48 at = disputedAt[jobId];
        if (at == 0) revert NotDisputed();
        if (block.timestamp <= uint256(at) + arbitrationWindow) revert WindowOpen();
        _requireSubmitted(jobId);
        emit TimedOut(jobId, "arbitration-window");
        _reject(jobId, "arbitrator-inactive");
    }

    /// @notice A job never finalized by its delivery deadline is rejected: a funded job the worker never
    ///         submitted, or one submitted before accepting (the core allows `submit` on an Open job with
    ///         budget 0), which Holding never funded and this contract never settles. Also the recovery rule
    ///         for a milestone claim filed directly on the core: terminal rejection clears it.
    function rejectAfterDeliveryDeadline(uint256 jobId) external {
        ERC8183.JobStatus status = core.getJob(jobId).status;
        bool stalled = status == ERC8183.JobStatus.Funded
            || (status == ERC8183.JobStatus.Submitted && !holding.isFunded(jobId));
        if (!stalled) revert NotFunded();
        if (block.timestamp <= holding.deliveryDeadlineOf(jobId)) revert WindowOpen();
        emit TimedOut(jobId, "delivery-deadline");
        _reject(jobId, "not-delivered");
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _requireSubmitted(uint256 jobId) private view returns (ERC8183.Job memory job) {
        job = core.getJob(jobId);
        if (job.status != ERC8183.JobStatus.Submitted) revert NotSubmitted();
        if (!holding.isFunded(jobId)) revert NeverFunded();
    }

    function _complete(uint256 jobId, bytes32 reason) private {
        core.complete(jobId, reason, "");
        holding.returnBonds(jobId);
        _recordOutcome(jobId, true);
    }

    function _reject(uint256 jobId, bytes32 reason) private {
        core.reject(jobId, reason, "");
        holding.returnBonds(jobId);
        _recordOutcome(jobId, false);
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
        emit EvidenceAttached(jobId, verifier, digest, a.testedSha, a.conclusion);
    }

    /// @dev ERC-8004 feedback for the worker's agent, as the client of record. Bounded gas and `try/catch`: a
    ///      registry failure is observable (`FeedbackFailed`) and never undoes a settlement that already moved
    ///      money (R16-10). Silent when no registry is configured or the job never had an agent.
    function _recordOutcome(uint256 jobId, bool completed) internal virtual {
        if (address(reputation) == address(0)) return;
        uint256 agentId = core.getJob(jobId).providerAgentId;
        if (agentId == 0) return;
        try reputation.giveFeedback{gas: FEEDBACK_GAS}(
            agentId,
            completed ? int128(1) : int128(0),
            0,
            "agent-jobs",
            completed ? "completed" : "rejected",
            "",
            "",
            bytes32(jobId)
        ) {
            emit FeedbackRecorded(jobId, agentId, completed);
        } catch (bytes memory reason) {
            emit FeedbackFailed(jobId, agentId, reason);
        }
    }
}

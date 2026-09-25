// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {JobHolding} from "./JobHolding.sol";

/// @title JobsEvaluator
/// @notice The evaluator of every listed job (spec §4). It keeps the minimal dispute state on-chain and only
///         ever makes terminal calls on the core: `complete` pays the worker from escrow, `reject` refunds the
///         creator through Holding. A creator's rejection is recorded here and opens a dispute window; nothing
///         moves until a ruling or a permissionless timeout. Silence after a finalized submission is acceptance.
///
///         Clocks (all config, set at deploy): review window after the on-chain submit; dispute-filing window
///         after a creator rejection; arbitration window after a dispute; plus a margin. Holding requires the
///         core's `expiredAt` to sit beyond delivery + all of them, so `claimRefund` can never pre-empt them.
contract JobsEvaluator {
    ERC8183 public immutable core;
    JobHolding public immutable holding;
    /// @notice Pinned at deploy; never replaced mid-agreement.
    address public immutable arbitrator;
    uint48 public immutable reviewWindow;
    uint48 public immutable disputeWindow;
    uint48 public immutable arbitrationWindow;
    uint48 public immutable margin;

    mapping(uint256 jobId => uint48) public rejectedAt;
    mapping(uint256 jobId => uint48) public disputedAt;

    event Accepted(uint256 indexed jobId, address indexed creator);
    event CreatorRejected(uint256 indexed jobId, address indexed creator);
    event Disputed(uint256 indexed jobId, address indexed worker);
    event Ruled(uint256 indexed jobId, bool forWorker);
    event TimedOut(uint256 indexed jobId, bytes32 reason);

    error NotCreator();
    error NotProvider();
    error NotArbitrator();
    error NotSubmitted();
    error NotFunded();
    error NeverFunded();
    error AlreadyRejected();
    error NotRejected();
    error AlreadyDisputed();
    error NotDisputed();
    error WindowClosed();
    error WindowOpen();

    constructor(
        ERC8183 core_,
        JobHolding holding_,
        address arbitrator_,
        uint48 reviewWindow_,
        uint48 disputeWindow_,
        uint48 arbitrationWindow_,
        uint48 margin_
    ) {
        core = core_;
        holding = holding_;
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
    // Parties
    // ---------------------------------------------------------------------------------------------

    /// @notice The creator accepts the finalized submission: the reward leaves escrow, the bond comes back.
    function accept(uint256 jobId) external {
        if (holding.creatorOf(jobId) != msg.sender) revert NotCreator();
        _requireSubmitted(jobId);
        emit Accepted(jobId, msg.sender);
        _complete(jobId, "accepted");
    }

    /// @notice The creator rejects. Nothing moves: the job stays Submitted and the dispute window opens.
    function creatorReject(uint256 jobId) external {
        if (holding.creatorOf(jobId) != msg.sender) revert NotCreator();
        _requireSubmitted(jobId);
        if (rejectedAt[jobId] != 0) revert AlreadyRejected();
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

    /// @notice The arbitrator rules. For the worker: reward from escrow plus the bond. Otherwise: refund and
    ///         the bond returns to the creator.
    function rule(uint256 jobId, bool forWorker) external {
        if (msg.sender != arbitrator) revert NotArbitrator();
        if (disputedAt[jobId] == 0) revert NotDisputed();
        _requireSubmitted(jobId);
        emit Ruled(jobId, forWorker);
        if (forWorker) {
            core.complete(jobId, "ruled-for-worker", "");
            holding.moveBondToWorker(jobId);
        } else {
            _reject(jobId, "ruled-for-creator");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Permissionless timeouts
    // ---------------------------------------------------------------------------------------------

    /// @notice No creator decision within the review window: silence is acceptance.
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

    /// @notice The arbitrator never ruled: status quo, refund and bond back. The README states this SLA is ours.
    function refundAfterArbitrationTimeout(uint256 jobId) external {
        uint48 at = disputedAt[jobId];
        if (at == 0) revert NotDisputed();
        if (block.timestamp <= uint256(at) + arbitrationWindow) revert WindowOpen();
        _requireSubmitted(jobId);
        emit TimedOut(jobId, "arbitration-window");
        _reject(jobId, "arbitrator-inactive");
    }

    /// @notice A job never finalized by its delivery deadline is rejected: a funded job the worker never
    ///         submitted, or a job the worker submitted before accepting (the core allows `submit` on an
    ///         Open job with budget 0), which Holding never funded and the evaluator will never settle. This
    ///         is also the recovery rule for a milestone claim filed directly on the core: the core clears a
    ///         pending claim on terminal rejection, so the refund can no longer be blocked by it.
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

    /// @dev Submitted *and* funded by Holding. The core lets a provider submit an Open job with budget 0,
    ///      which would complete with a zero payout and strand the reward in Holding; such a job is never
    ///      settled here, only rejected after its delivery deadline.
    function _requireSubmitted(uint256 jobId) private view returns (ERC8183.Job memory job) {
        job = core.getJob(jobId);
        if (job.status != ERC8183.JobStatus.Submitted) revert NotSubmitted();
        if (!holding.isFunded(jobId)) revert NeverFunded();
    }

    function _complete(uint256 jobId, bytes32 reason) private {
        core.complete(jobId, reason, "");
        holding.returnBond(jobId);
        _recordOutcome(jobId, true);
    }

    function _reject(uint256 jobId, bytes32 reason) private {
        core.reject(jobId, reason, "");
        holding.returnBond(jobId);
        _recordOutcome(jobId, false);
    }

    /// @dev ERC-8004 feedback lands here once spike S2 has the registry ABI. Kept as a no-op so the
    ///      settlement path is complete without it.
    function _recordOutcome(uint256 jobId, bool completed) internal virtual {}
}

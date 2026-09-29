// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {JobHolding} from "./JobHolding.sol";

interface IEvaluatorWindow {
    function settlementWindow() external view returns (uint48);
}

/// @title JobPool
/// @notice Pooled funding of ONE offer (ADR-0007). Pledgers put the reward token in until the goal is reached;
///         `launch` then publishes the offer on `JobHolding` with the pool as the creator, so the pool owns the
///         listing: its reward, its cancel right and its selection signatures. A curator, fixed at creation, is the
///         listing's approver (judges the work) and the signer the pool honours through ERC-1271, so `activate`
///         accepts a curator-signed `Selection` for a listing whose creator is this contract. Whatever comes back to
///         the pool (a cancelled or rejected offer's reward, an expired contest's prize) is refunded to pledgers pro
///         rata; a paid reward never comes back and refunds nothing. Nothing is upgradeable; one pool, one offer.
/// @dev A minimal proxy (`JobPoolFactory`) at a predictable address, so a board can freeze `terms.creator = pool`
///      and compute the `policyHash` before the pool exists. `governance` names how the curator is chosen or
///      overruled: only 0 (curator decides) is implemented, the field and its event are reserved.
contract JobPool is IERC1271, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Params {
        /// @dev The pledge token; must be the offer's reward token.
        IERC20 token;
        /// @dev What pledges add up to; must be the offer's reward. Pledges past it are capped.
        uint256 goal;
        /// @dev Pledging closes here; `launch` may still run for `LAUNCH_GRACE` after it.
        uint48 pledgeDeadline;
        /// @dev Judges the work and signs selections for the pool. Frozen.
        address curator;
        JobHolding holding;
        /// @dev The offer as the board built it: `approver` is the curator (zero means the curator), `reward` the
        ///      goal, `creatorBond` zero (the pool posts no bond), `policyHash` the board's terms hash.
        JobHolding.PublishParams publish;
        /// @dev Reserved: 0 = the curator decides. Anything else reverts.
        uint8 governance;
        /// @dev Receives the FACTORY hold back once the pool is over (defaults to the pool's creator).
        address holdProvider;
    }

    enum Phase {
        Funding,
        Launched,
        Cancelled,
        Expired
    }

    /// @notice How long after the pledge deadline a full pool may still launch.
    uint48 public constant LAUNCH_GRACE = 1 days;
    bytes4 private constant MAGIC = 0x1626ba7e;

    address public creator;
    uint256 public totalPledged;
    mapping(address pledger => uint256) public pledged;
    mapping(address pledger => uint256) public claimed;
    /// @notice Everything refunded so far.
    uint256 public paidOut;
    uint256 public jobId;
    uint48 public launchedAt;
    uint48 public cancelledAt;
    /// @notice FACTORY the factory placed here so `publish` passes the hold gate; never spent.
    uint256 public holdAmount;
    bool public holdReclaimed;
    bool private _initialized;
    Params private _p;

    event Initialized(
        address indexed creator,
        address indexed curator,
        address indexed token,
        uint256 goal,
        uint48 pledgeDeadline,
        bytes32 policyHash,
        uint8 governance
    );
    event Pledged(address indexed pledger, uint256 amount, uint256 totalPledged);
    event Unpledged(address indexed pledger, uint256 amount, uint256 totalPledged);
    event Launched(uint256 indexed jobId, bytes32 indexed policyHash);
    event PoolCancelled(address indexed by);
    event Refunded(address indexed pledger, uint256 amount);
    event HoldReclaimed(address indexed to, uint256 amount);

    error AlreadyInitialized();
    error NotCurator();
    error NotFunding();
    error GoalNotReached();
    error PledgeDeadlinePassed();
    error AlreadyLaunched();
    error NotLaunched();
    error NothingToRefund();
    error JobNotTerminal();
    error OverGoal();
    error PoolFull();
    error GovernanceUnsupported();
    error ZeroAmount();
    error BadParams(string what);
    error TokenFeeOnTransfer(uint256 expected, uint256 received);
    error HoldNotReclaimable();

    constructor() {
        // The implementation is never a pool; clones start with `_initialized == false`.
        _initialized = true;
    }

    /// @notice Set once by the factory, in the transaction that clones the pool.
    function initialize(address creator_, Params calldata p, uint256 hold) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (p.governance != 0) revert GovernanceUnsupported();
        if (p.goal == 0) revert BadParams("goal");
        if (p.curator == address(0)) revert BadParams("curator");
        if (address(p.holding) == address(0)) revert BadParams("holding");
        if (address(p.publish.token) != address(p.token)) revert BadParams("token");
        if (p.publish.reward != p.goal) revert BadParams("reward");
        if (p.publish.creatorBond != 0) revert BadParams("creatorBond");
        if (p.pledgeDeadline <= block.timestamp) revert BadParams("pledgeDeadline");
        if (p.publish.deliveryDeadline <= p.pledgeDeadline + LAUNCH_GRACE) revert BadParams("deliveryDeadline");
        if (p.publish.approver != address(0) && p.publish.approver != p.curator) revert BadParams("approver");
        _p = p;
        if (_p.publish.approver == address(0)) _p.publish.approver = p.curator;
        if (_p.holdProvider == address(0)) _p.holdProvider = creator_;
        creator = creator_;
        holdAmount = hold;
        emit Initialized(creator_, p.curator, address(p.token), p.goal, p.pledgeDeadline, p.publish.policyHash, 0);
    }

    // ---------------------------------------------------------------------------------------------
    // Pledgers
    // ---------------------------------------------------------------------------------------------

    /// @notice Puts `amount` of the reward token in, capped to what the goal still needs.
    function pledge(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (phase() != Phase.Funding || block.timestamp > _p.pledgeDeadline) revert NotFunding();
        uint256 room = _p.goal - totalPledged;
        if (room == 0) revert OverGoal();
        if (amount > room) amount = room;
        uint256 before = _p.token.balanceOf(address(this));
        _p.token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = _p.token.balanceOf(address(this)) - before;
        if (received != amount) revert TokenFeeOnTransfer(amount, received);
        pledged[msg.sender] += amount;
        totalPledged += amount;
        emit Pledged(msg.sender, amount, totalPledged);
    }

    /// @notice Takes a pledge back while the pool is still funding and not yet full: a full pool is committed, anyone
    ///         may launch it, and its pledges come back only through `refund` if it never launches.
    function unpledge(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (phase() != Phase.Funding || block.timestamp > _p.pledgeDeadline) revert NotFunding();
        if (totalPledged == _p.goal) revert PoolFull();
        if (pledged[msg.sender] < amount) revert NothingToRefund();
        pledged[msg.sender] -= amount;
        totalPledged -= amount;
        _p.token.safeTransfer(msg.sender, amount);
        emit Unpledged(msg.sender, amount, totalPledged);
    }

    /// @notice Refunds the caller's share of whatever came back to the pool: everything when the pool was
    ///         cancelled or never launched; the returned reward, pro rata, once a launched offer ended without
    ///         paying the worker. Settles the listing first when the core says the job is over. Idempotent.
    function refund() external nonReentrant {
        if (launchedAt != 0) {
            if (!_jobTerminal()) revert JobNotTerminal();
            // Holding refuses to settle twice; a second refund after a settled listing is still fine.
            try _p.holding.settle(jobId) {} catch {}
        } else if (cancelledAt == 0 && block.timestamp <= _p.pledgeDeadline + LAUNCH_GRACE) {
            revert NotLaunched();
        }
        uint256 available = _p.token.balanceOf(address(this)) + paidOut;
        uint256 owed = totalPledged == 0 ? 0 : pledged[msg.sender] * available / totalPledged - claimed[msg.sender];
        if (owed == 0) revert NothingToRefund();
        claimed[msg.sender] += owed;
        paidOut += owed;
        _p.token.safeTransfer(msg.sender, owed);
        emit Refunded(msg.sender, owed);
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    /// @notice Publishes the offer once the goal is reached: the pool becomes the listing's creator, the curator its
    ///         approver. Allowed until `LAUNCH_GRACE` after the pledge deadline.
    function launch() external nonReentrant returns (uint256 id) {
        if (launchedAt != 0) revert AlreadyLaunched();
        if (cancelledAt != 0) revert NotFunding();
        if (block.timestamp > _p.pledgeDeadline + LAUNCH_GRACE) revert PledgeDeadlinePassed();
        if (totalPledged != _p.goal) revert GoalNotReached();
        JobHolding.PublishParams memory p = _p.publish;
        uint48 floor = p.deliveryDeadline + IEvaluatorWindow(_p.holding.evaluator()).settlementWindow();
        if (p.expiredAt < floor) p.expiredAt = floor;
        launchedAt = uint48(block.timestamp);
        _p.token.forceApprove(address(_p.holding), _p.goal);
        id = _p.holding.publish(p);
        jobId = id;
        emit Launched(id, p.policyHash);
    }

    /// @notice Returns the FACTORY hold to its provider once the pool is over.
    function reclaimHold() external nonReentrant {
        if (holdReclaimed) revert HoldNotReclaimable();
        bool over = cancelledAt != 0 || (launchedAt == 0 && block.timestamp > _p.pledgeDeadline + LAUNCH_GRACE)
            || (launchedAt != 0 && _jobTerminal());
        if (!over) revert HoldNotReclaimable();
        holdReclaimed = true;
        IERC20 hold = _p.holding.factory();
        uint256 amount = hold.balanceOf(address(this));
        if (amount > 0) hold.safeTransfer(_p.holdProvider, amount);
        emit HoldReclaimed(_p.holdProvider, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Curator
    // ---------------------------------------------------------------------------------------------

    modifier onlyCurator() {
        if (msg.sender != _p.curator) revert NotCurator();
        _;
    }

    /// @notice Closes an unlaunched pool; every pledge becomes refundable in full.
    function cancelPool() external onlyCurator {
        if (launchedAt != 0) revert AlreadyLaunched();
        if (cancelledAt != 0) revert NotFunding();
        cancelledAt = uint48(block.timestamp);
        emit PoolCancelled(msg.sender);
    }

    /// @notice Cancels the launched hire before activation (Holding's `cancel`, creator-only, so forwarded).
    function cancel() external onlyCurator {
        if (launchedAt == 0) revert NotLaunched();
        _p.holding.cancel(jobId);
    }

    /// @notice Burns one of the pool's selection nonces (Holding's `cancelSelection`, forwarded).
    function cancelSelection(uint256 nonce) external onlyCurator {
        _p.holding.cancelSelection(nonce);
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-1271: the pool signs what its curator signs
    // ---------------------------------------------------------------------------------------------

    function isValidSignature(bytes32 hash, bytes memory signature) external view override returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(_p.curator, hash, signature) ? MAGIC : bytes4(0xffffffff);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function params() external view returns (Params memory) {
        return _p;
    }

    function curator() external view returns (address) {
        return _p.curator;
    }

    function goal() external view returns (uint256) {
        return _p.goal;
    }

    function pledgeDeadline() external view returns (uint48) {
        return _p.pledgeDeadline;
    }

    function phase() public view returns (Phase) {
        if (cancelledAt != 0) return Phase.Cancelled;
        if (launchedAt != 0) return Phase.Launched;
        if (block.timestamp > _p.pledgeDeadline + LAUNCH_GRACE) return Phase.Expired;
        return Phase.Funding;
    }

    /// @notice Whether `refund` can pay anyone now.
    function refundable() external view returns (bool) {
        Phase ph = phase();
        if (ph == Phase.Cancelled || ph == Phase.Expired) return true;
        return ph == Phase.Launched && _jobTerminal();
    }

    function _jobTerminal() private view returns (bool) {
        ERC8183.JobStatus s = _p.holding.core().getJob(jobId).status;
        return s == ERC8183.JobStatus.Completed || s == ERC8183.JobStatus.Rejected || s == ERC8183.JobStatus.Expired;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {FactoryToken} from "./FactoryToken.sol";

/// @dev What Holding needs from the evaluator: how long settlement can take after delivery, and who is owed a
///      reward that a core refund put back into Holding.
interface ISettlementWindow {
    function settlementWindow() external view returns (uint48);
    function earnedByWorker(uint256 jobId) external view returns (bool);
}

/// @title JobHolding
/// @notice The ERC-8183 *client* of every listed job (spec §4). Two assets: the reward in any allowlisted
///         payment token, escrowed here at publish and moved into the core once the worker accepts; and
///         collateral in `$FACTORY`, a creator bond pulled at publish and a worker bond pulled at accept, both
///         locked here through settlement. A hold requirement in FACTORY gates publishing and claiming.
///
///         Two modes. Hire-first: the creator assigns one worker. Contest: the prize is locked at publish,
///         candidates are collected off-chain, and the creator picks one before `selectionDeadline`; if
///         nobody is picked, anyone can expire the contest and the prize returns.
///
///         Money rules: one job's assets never mix with another's; a bond is burned only by the evaluator on
///         a ruling that found a violation; every other terminal path returns both bonds; every refund the
///         core makes lands here as custody, not entitlement, and `settle` pays it to whoever the evaluator
///         says is owed it, exactly once (R114-03).
contract JobHolding {
    using SafeERC20 for IERC20;

    enum Mode {
        HireFirst,
        Contest
    }

    enum Side {
        Creator,
        Worker
    }

    struct Listing {
        address creator;
        /// @dev Judges the work (accept, reject, award); never pays, selects or receives anything. Frozen at
        ///      publish; defaults to the creator.
        address approver;
        address worker;
        IERC20 token;
        Mode mode;
        uint48 deliveryDeadline;
        uint48 selectionDeadline;
        bool funded;
        bool workerBondPosted;
        bool rewardSettled;
        bool creatorBondSettled;
        bool workerBondSettled;
        uint256 reward;
        uint256 creatorBond;
        uint256 workerBond;
        bytes32 manifestHash;
        /// @dev The board's `termsHash`: the canonical snapshot of the offer the worker accepts. Evidence is only
        ///      stored against the policy it names (R16-07).
        bytes32 policyHash;
    }

    struct PublishParams {
        /// @dev Zero means the creator approves its own offer.
        address approver;
        bytes32 manifestHash;
        bytes32 policyHash;
        IERC20 token;
        uint256 reward;
        uint256 creatorBond;
        uint256 workerBond;
        uint48 deliveryDeadline;
        uint48 expiredAt;
        Mode mode;
        /// @dev Contest only: the creator must pick a winner by then; zero for hire-first.
        uint48 selectionDeadline;
    }

    ERC8183 public immutable core;
    FactoryToken public immutable factory;
    address public immutable admin;
    /// @notice Set exactly once after deploy (the evaluator needs this address in its constructor).
    address public evaluator;
    /// @notice FACTORY a wallet must hold to publish, and to post a worker bond. Sybil resistance only.
    uint256 public minHoldToPublish;
    uint256 public minHoldToClaim;

    mapping(uint256 jobId => Listing) internal _listings;
    /// @notice Every `termsHash` ever listed. A retried publish of the same offer is refused rather than funding
    ///         a second escrow (R114-07).
    mapping(bytes32 policyHash => bool) public policyListed;

    event Published(
        uint256 indexed jobId,
        address indexed creator,
        address indexed approver,
        Mode mode,
        address token,
        uint256 reward,
        uint256 creatorBond,
        uint256 workerBond,
        bytes32 manifestHash,
        bytes32 policyHash,
        uint48 deliveryDeadline,
        uint48 selectionDeadline,
        uint48 expiredAt
    );
    event Assigned(uint256 indexed jobId, address indexed worker, uint256 agentId, bool byContestSelection);
    event WorkerBondPosted(uint256 indexed jobId, address indexed worker, uint256 amount);
    event Funded(uint256 indexed jobId);
    event Cancelled(uint256 indexed jobId);
    event ContestExpired(uint256 indexed jobId);
    event RewardSettled(uint256 indexed jobId, address indexed to, uint256 amount);
    event BondReturned(uint256 indexed jobId, Side side, address indexed to, uint256 amount);
    event BondBurned(uint256 indexed jobId, Side side, uint256 amount);
    event HoldRequirementsSet(uint256 minHoldToPublish, uint256 minHoldToClaim);

    error NotAdmin();
    error EvaluatorAlreadySet();
    error EvaluatorNotSet();
    error NotCreator();
    error NotWorker();
    error NotEvaluator();
    error ZeroReward();
    error AgentIdRequired();
    error PolicyHashRequired();
    error PolicyHashUsed();
    error ContestWorkerBond();
    error ExpiryTooShort();
    error SelectionDeadlineInvalid();
    error WrongMode();
    error InsufficientFactoryHeld(uint256 held, uint256 required);
    error AlreadyFunded();
    error AlreadyAssigned();
    error NotAssigned();
    error SelectionWindowClosed();
    error SelectionWindowOpen();
    error BondNotPosted();
    error BondAlreadyPosted();
    error NotAccepted();
    error UnknownJob();
    error NothingToSettle();
    error NotTerminal();

    constructor(ERC8183 core_, FactoryToken factory_, uint256 minHoldToPublish_, uint256 minHoldToClaim_) {
        core = core_;
        factory = factory_;
        admin = msg.sender;
        minHoldToPublish = minHoldToPublish_;
        minHoldToClaim = minHoldToClaim_;
    }

    modifier onlyCreator(uint256 jobId) {
        if (_listings[jobId].creator != msg.sender) revert NotCreator();
        _;
    }

    modifier onlyEvaluator() {
        if (msg.sender != evaluator) revert NotEvaluator();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // Admin (deployer EOA; documented in the README)
    // ---------------------------------------------------------------------------------------------

    function setEvaluator(address evaluator_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (evaluator != address(0)) revert EvaluatorAlreadySet();
        evaluator = evaluator_;
    }

    function setHoldRequirements(uint256 minHoldToPublish_, uint256 minHoldToClaim_) external {
        if (msg.sender != admin) revert NotAdmin();
        minHoldToPublish = minHoldToPublish_;
        minHoldToClaim = minHoldToClaim_;
        emit HoldRequirementsSet(minHoldToPublish_, minHoldToClaim_);
    }

    // ---------------------------------------------------------------------------------------------
    // Creator actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Escrows the reward and the creator's FACTORY bond and creates the core job with Holding as
    ///         client and no provider. The listing is the escrow.
    function publish(PublishParams calldata p) external returns (uint256 jobId) {
        if (evaluator == address(0)) revert EvaluatorNotSet();
        if (p.reward == 0) revert ZeroReward();
        if (p.policyHash == bytes32(0)) revert PolicyHashRequired();
        if (policyListed[p.policyHash]) revert PolicyHashUsed();
        _requireHold(msg.sender, minHoldToPublish);
        if (p.expiredAt < uint256(p.deliveryDeadline) + ISettlementWindow(evaluator).settlementWindow()) {
            revert ExpiryTooShort();
        }
        if (p.mode == Mode.Contest) {
            if (p.selectionDeadline <= block.timestamp || p.selectionDeadline >= p.deliveryDeadline) {
                revert SelectionDeadlineInvalid();
            }
            // Contest entrants risk their work and nothing else in this version (R20).
            if (p.workerBond > 0) revert ContestWorkerBond();
        } else if (p.selectionDeadline != 0) {
            revert SelectionDeadlineInvalid();
        }

        policyListed[p.policyHash] = true;
        address approver = p.approver == address(0) ? msg.sender : p.approver;
        p.token.safeTransferFrom(msg.sender, address(this), p.reward);
        if (p.creatorBond > 0) IERC20(address(factory)).safeTransferFrom(msg.sender, address(this), p.creatorBond);

        jobId = core.createJob(
            address(0), evaluator, p.expiredAt, Strings.toHexString(uint256(p.manifestHash), 32), address(0), 0
        );
        Listing storage l = _listings[jobId];
        l.creator = msg.sender;
        l.approver = approver;
        l.token = p.token;
        l.mode = p.mode;
        l.deliveryDeadline = p.deliveryDeadline;
        l.selectionDeadline = p.selectionDeadline;
        l.reward = p.reward;
        l.creatorBond = p.creatorBond;
        l.workerBond = p.workerBond;
        l.manifestHash = p.manifestHash;
        l.policyHash = p.policyHash;

        emit Published(
            jobId,
            msg.sender,
            approver,
            p.mode,
            address(p.token),
            p.reward,
            p.creatorBond,
            p.workerBond,
            p.manifestHash,
            p.policyHash,
            p.deliveryDeadline,
            p.selectionDeadline,
            p.expiredAt
        );
    }

    /// @notice Hire-first: names the worker (and its ERC-8004 agent id) as the core's provider.
    function assign(uint256 jobId, address worker, uint256 agentId) external onlyCreator(jobId) {
        if (_listings[jobId].mode != Mode.HireFirst) revert WrongMode();
        _assign(jobId, worker, agentId, false);
    }

    /// @notice Contest: picks the winning entrant before the selection deadline. Same effect as `assign`.
    function select(uint256 jobId, address worker, uint256 agentId) external onlyCreator(jobId) {
        Listing storage l = _listings[jobId];
        if (l.mode != Mode.Contest) revert WrongMode();
        if (block.timestamp > l.selectionDeadline) revert SelectionWindowClosed();
        _assign(jobId, worker, agentId, true);
    }

    /// @notice Cancels an unassigned hire-first listing. Nothing was escrowed in the core; `settle` then
    ///         returns reward and creator bond. A published contest cannot be cancelled: entrants work against
    ///         the locked prize, so it ends only through `select` or `expireContest` (R16-02).
    function cancel(uint256 jobId) external onlyCreator(jobId) {
        if (_listings[jobId].mode != Mode.HireFirst) revert WrongMode();
        if (_listings[jobId].funded) revert AlreadyFunded();
        if (_listings[jobId].worker != address(0)) revert AlreadyAssigned();
        core.reject(jobId, "cancelled", "");
        emit Cancelled(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Worker actions
    // ---------------------------------------------------------------------------------------------

    /// @notice The assigned worker posts its FACTORY bond (and passes the hold gate). Required before
    ///         funding, even when the bond is zero, so acceptance is an explicit act.
    function postWorkerBond(uint256 jobId) external {
        Listing storage l = _listings[jobId];
        if (l.worker != msg.sender) revert NotWorker();
        if (l.workerBondPosted) revert BondAlreadyPosted();
        _requireHold(msg.sender, minHoldToClaim);
        l.workerBondPosted = true;
        if (l.workerBond > 0) IERC20(address(factory)).safeTransferFrom(msg.sender, address(this), l.workerBond);
        emit WorkerBondPosted(jobId, msg.sender, l.workerBond);
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    /// @notice Funds the core once the assigned worker has posted its bond and set the budget to exactly the
    ///         listed reward in the listed token. Anyone may call: the effect is fixed by the listing.
    function fundAfterAccept(uint256 jobId) external {
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert NotCreator();
        if (l.funded) revert AlreadyFunded();
        if (!l.workerBondPosted) revert BondNotPosted();
        ERC8183.Job memory job = core.getJob(jobId);
        if (job.provider == address(0) || job.paymentToken != address(l.token) || job.budget != l.reward) {
            revert NotAccepted();
        }
        l.funded = true;
        l.token.forceApprove(address(core), l.reward);
        core.fund(jobId, address(l.token), l.reward, "");
        emit Funded(jobId);
    }

    /// @notice Settles whatever of a terminal job is still in Holding, each amount once. The reward is here
    ///         after any rejection and after the core's permissionless `claimRefund`; it goes to the worker when
    ///         the evaluator says the worker earned it (a timely submission nobody rejected within the review
    ///         window), otherwise to the creator. The core status alone never decides who is paid (R114-03).
    ///         Bonds no evaluator path settled return to their owners. Anyone may call: the effect is fixed.
    function settle(uint256 jobId) external {
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert UnknownJob();
        ERC8183.JobStatus status = core.getJob(jobId).status;
        if (!_isTerminal(status)) revert NotTerminal();
        bool settled;
        address rewardTo;
        if (!l.rewardSettled && _rewardIsHere(status)) {
            l.rewardSettled = true;
            rewardTo = ISettlementWindow(evaluator).earnedByWorker(jobId) ? l.worker : l.creator;
            emit RewardSettled(jobId, rewardTo, l.reward);
        }
        if (!l.creatorBondSettled) {
            settled = true;
            _returnBond(jobId, l, Side.Creator);
        }
        if (!l.workerBondSettled && l.workerBondPosted) {
            settled = true;
            _returnBond(jobId, l, Side.Worker);
        }
        if (rewardTo == address(0) && !settled) revert NothingToSettle();
        if (rewardTo != address(0)) l.token.safeTransfer(rewardTo, l.reward);
    }

    /// @notice A contest nobody was picked for by its selection deadline is over; the prize returns via
    ///         `settle`.
    function expireContest(uint256 jobId) external {
        Listing storage l = _listings[jobId];
        if (l.mode != Mode.Contest) revert WrongMode();
        if (l.worker != address(0)) revert AlreadyAssigned();
        if (block.timestamp <= l.selectionDeadline) revert SelectionWindowOpen();
        core.reject(jobId, "contest-expired", "");
        emit ContestExpired(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Evaluator-only collateral movements
    // ---------------------------------------------------------------------------------------------

    /// @notice The only path by which a bond is destroyed: a ruling that found a violation on that side.
    function burnBond(uint256 jobId, Side side) external onlyEvaluator {
        Listing storage l = _listings[jobId];
        (uint256 amount, bool present) = _bondOf(l, side);
        if (!present) return;
        _markSettled(l, side);
        if (amount == 0) return;
        factory.burn(amount);
        emit BondBurned(jobId, side, amount);
    }

    /// @notice Returns both bonds to their owners on any terminal settlement. Idempotent: a bond already
    ///         settled (returned or burned) is left alone.
    function returnBonds(uint256 jobId) external onlyEvaluator {
        Listing storage l = _listings[jobId];
        if (!l.creatorBondSettled) _returnBond(jobId, l, Side.Creator);
        if (!l.workerBondSettled && l.workerBondPosted) _returnBond(jobId, l, Side.Worker);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function getListing(uint256 jobId) external view returns (Listing memory) {
        return _listings[jobId];
    }

    function creatorOf(uint256 jobId) external view returns (address) {
        return _listings[jobId].creator;
    }

    function approverOf(uint256 jobId) external view returns (address) {
        return _listings[jobId].approver;
    }

    function deliveryDeadlineOf(uint256 jobId) external view returns (uint48) {
        return _listings[jobId].deliveryDeadline;
    }

    function policyHashOf(uint256 jobId) external view returns (bytes32) {
        return _listings[jobId].policyHash;
    }

    function isFunded(uint256 jobId) external view returns (bool) {
        return _listings[jobId].funded;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _assign(uint256 jobId, address worker, uint256 agentId, bool byContestSelection) private {
        Listing storage l = _listings[jobId];
        if (agentId == 0) revert AgentIdRequired();
        if (l.worker != address(0)) revert AlreadyAssigned();
        l.worker = worker;
        core.setProvider(jobId, worker, agentId);
        emit Assigned(jobId, worker, agentId, byContestSelection);
    }

    function _requireHold(address who, uint256 required) private view {
        uint256 held = factory.balanceOf(who);
        if (held < required) revert InsufficientFactoryHeld(held, required);
    }

    function _bondOf(Listing storage l, Side side) private view returns (uint256 amount, bool present) {
        if (side == Side.Creator) return (l.creatorBond, !l.creatorBondSettled);
        return (l.workerBond, l.workerBondPosted && !l.workerBondSettled);
    }

    function _markSettled(Listing storage l, Side side) private {
        if (side == Side.Creator) l.creatorBondSettled = true;
        else l.workerBondSettled = true;
    }

    function _returnBond(uint256 jobId, Listing storage l, Side side) private {
        (uint256 amount,) = _bondOf(l, side);
        _markSettled(l, side);
        address to = side == Side.Creator ? l.creator : l.worker;
        if (amount > 0) IERC20(address(factory)).safeTransfer(to, amount);
        emit BondReturned(jobId, side, to, amount);
    }

    /// @dev Rejected or Expired means the core either never held the reward or has refunded it to Holding.
    function _rewardIsHere(ERC8183.JobStatus status) private pure returns (bool) {
        return status == ERC8183.JobStatus.Rejected || status == ERC8183.JobStatus.Expired;
    }

    function _isTerminal(ERC8183.JobStatus status) private pure returns (bool) {
        return status == ERC8183.JobStatus.Completed || _rewardIsHere(status);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {FactoryToken} from "./FactoryToken.sol";

/// @dev The one thing Holding needs from the evaluator: how long settlement can take after delivery.
interface ISettlementWindow {
    function settlementWindow() external view returns (uint48);
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
///         core makes lands here and is recovered by its owner exactly once.
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
        address worker;
        IERC20 token;
        Mode mode;
        uint48 deliveryDeadline;
        uint48 selectionDeadline;
        bool funded;
        bool workerBondPosted;
        bool rewardWithdrawn;
        bool creatorBondSettled;
        bool workerBondSettled;
        uint256 reward;
        uint256 creatorBond;
        uint256 workerBond;
        bytes32 manifestHash;
    }

    struct PublishParams {
        bytes32 manifestHash;
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

    mapping(uint256 jobId => Listing) public listings;

    event Published(
        uint256 indexed jobId,
        address indexed creator,
        Mode mode,
        address token,
        uint256 reward,
        uint256 creatorBond,
        uint256 workerBond,
        bytes32 manifestHash,
        uint48 deliveryDeadline,
        uint48 selectionDeadline,
        uint48 expiredAt
    );
    event Assigned(uint256 indexed jobId, address indexed worker, uint256 agentId, bool byContestSelection);
    event WorkerBondPosted(uint256 indexed jobId, address indexed worker, uint256 amount);
    event Funded(uint256 indexed jobId);
    event Cancelled(uint256 indexed jobId);
    event ContestExpired(uint256 indexed jobId);
    event RewardWithdrawn(uint256 indexed jobId, address indexed creator, uint256 amount);
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
    error NothingToWithdraw();
    error NotTerminal();

    constructor(ERC8183 core_, FactoryToken factory_, uint256 minHoldToPublish_, uint256 minHoldToClaim_) {
        core = core_;
        factory = factory_;
        admin = msg.sender;
        minHoldToPublish = minHoldToPublish_;
        minHoldToClaim = minHoldToClaim_;
    }

    modifier onlyCreator(uint256 jobId) {
        if (listings[jobId].creator != msg.sender) revert NotCreator();
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
        _requireHold(msg.sender, minHoldToPublish);
        if (p.expiredAt < uint256(p.deliveryDeadline) + ISettlementWindow(evaluator).settlementWindow()) {
            revert ExpiryTooShort();
        }
        if (p.mode == Mode.Contest) {
            if (p.selectionDeadline <= block.timestamp || p.selectionDeadline >= p.deliveryDeadline) {
                revert SelectionDeadlineInvalid();
            }
        } else if (p.selectionDeadline != 0) {
            revert SelectionDeadlineInvalid();
        }

        p.token.safeTransferFrom(msg.sender, address(this), p.reward);
        if (p.creatorBond > 0) IERC20(address(factory)).safeTransferFrom(msg.sender, address(this), p.creatorBond);

        jobId = core.createJob(
            address(0), evaluator, p.expiredAt, Strings.toHexString(uint256(p.manifestHash), 32), address(0), 0
        );
        Listing storage l = listings[jobId];
        l.creator = msg.sender;
        l.token = p.token;
        l.mode = p.mode;
        l.deliveryDeadline = p.deliveryDeadline;
        l.selectionDeadline = p.selectionDeadline;
        l.reward = p.reward;
        l.creatorBond = p.creatorBond;
        l.workerBond = p.workerBond;
        l.manifestHash = p.manifestHash;

        emit Published(
            jobId,
            msg.sender,
            p.mode,
            address(p.token),
            p.reward,
            p.creatorBond,
            p.workerBond,
            p.manifestHash,
            p.deliveryDeadline,
            p.selectionDeadline,
            p.expiredAt
        );
    }

    /// @notice Hire-first: names the worker (and its ERC-8004 agent id) as the core's provider.
    function assign(uint256 jobId, address worker, uint256 agentId) external onlyCreator(jobId) {
        if (listings[jobId].mode != Mode.HireFirst) revert WrongMode();
        _assign(jobId, worker, agentId, false);
    }

    /// @notice Contest: picks the winning entrant before the selection deadline. Same effect as `assign`.
    function select(uint256 jobId, address worker, uint256 agentId) external onlyCreator(jobId) {
        Listing storage l = listings[jobId];
        if (l.mode != Mode.Contest) revert WrongMode();
        if (block.timestamp > l.selectionDeadline) revert SelectionWindowClosed();
        _assign(jobId, worker, agentId, true);
    }

    /// @notice Cancels an unassigned listing (either mode). Nothing was escrowed in the core; `withdraw`
    ///         then returns reward and creator bond.
    function cancel(uint256 jobId) external onlyCreator(jobId) {
        if (listings[jobId].funded) revert AlreadyFunded();
        if (listings[jobId].worker != address(0)) revert AlreadyAssigned();
        core.reject(jobId, "cancelled", "");
        emit Cancelled(jobId);
    }

    /// @notice Recovers the creator's share of whatever is back in Holding: the reward once the core job is
    ///         Rejected or Expired, the creator bond once the job is terminal and no ruling burned it.
    function withdraw(uint256 jobId) external onlyCreator(jobId) {
        Listing storage l = listings[jobId];
        ERC8183.JobStatus status = core.getJob(jobId).status;
        uint256 rewardOut;
        if (!l.rewardWithdrawn && _rewardIsHere(status)) {
            l.rewardWithdrawn = true;
            rewardOut = l.reward;
            emit RewardWithdrawn(jobId, l.creator, rewardOut);
        }
        bool bondOut;
        if (!l.creatorBondSettled && _isTerminal(status)) {
            bondOut = true;
            _returnBond(jobId, l, Side.Creator);
        }
        if (rewardOut == 0 && !bondOut) revert NothingToWithdraw();
        if (rewardOut > 0) l.token.safeTransfer(l.creator, rewardOut);
    }

    // ---------------------------------------------------------------------------------------------
    // Worker actions
    // ---------------------------------------------------------------------------------------------

    /// @notice The assigned worker posts its FACTORY bond (and passes the hold gate). Required before
    ///         funding, even when the bond is zero, so acceptance is an explicit act.
    function postWorkerBond(uint256 jobId) external {
        Listing storage l = listings[jobId];
        if (l.worker != msg.sender) revert NotWorker();
        if (l.workerBondPosted) revert BondAlreadyPosted();
        _requireHold(msg.sender, minHoldToClaim);
        l.workerBondPosted = true;
        if (l.workerBond > 0) IERC20(address(factory)).safeTransferFrom(msg.sender, address(this), l.workerBond);
        emit WorkerBondPosted(jobId, msg.sender, l.workerBond);
    }

    /// @notice Recovers the worker's bond after a terminal settlement that did not burn it and that no
    ///         evaluator path returned (a third-party `claimRefund`, for instance).
    function withdrawWorkerBond(uint256 jobId) external {
        Listing storage l = listings[jobId];
        if (l.worker != msg.sender) revert NotWorker();
        if (!_isTerminal(core.getJob(jobId).status)) revert NotTerminal();
        if (l.workerBondSettled || !l.workerBondPosted) revert NothingToWithdraw();
        _returnBond(jobId, l, Side.Worker);
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    /// @notice Funds the core once the assigned worker has posted its bond and set the budget to exactly the
    ///         listed reward in the listed token. Anyone may call: the effect is fixed by the listing.
    function fundAfterAccept(uint256 jobId) external {
        Listing storage l = listings[jobId];
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

    /// @notice A contest nobody was picked for by its selection deadline is over; the prize returns via
    ///         `withdraw`.
    function expireContest(uint256 jobId) external {
        Listing storage l = listings[jobId];
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
        Listing storage l = listings[jobId];
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
        Listing storage l = listings[jobId];
        if (!l.creatorBondSettled) _returnBond(jobId, l, Side.Creator);
        if (!l.workerBondSettled && l.workerBondPosted) _returnBond(jobId, l, Side.Worker);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function creatorOf(uint256 jobId) external view returns (address) {
        return listings[jobId].creator;
    }

    function deliveryDeadlineOf(uint256 jobId) external view returns (uint48) {
        return listings[jobId].deliveryDeadline;
    }

    function isFunded(uint256 jobId) external view returns (bool) {
        return listings[jobId].funded;
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _assign(uint256 jobId, address worker, uint256 agentId, bool byContestSelection) private {
        Listing storage l = listings[jobId];
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

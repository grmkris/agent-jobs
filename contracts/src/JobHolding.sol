// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";

/// @dev The one thing Holding needs from the evaluator: how long settlement can take after delivery.
interface ISettlementWindow {
    function settlementWindow() external view returns (uint48);
}

/// @title JobHolding
/// @notice The ERC-8183 *client* of every listed job (spec §4, option c). A creator deposits the reward and an
///         optional bond here at publish, so the listing is the escrow; Holding creates the core job, assigns
///         the worker, and funds the core once the worker has accepted by setting the budget. Every refund the
///         core makes lands here and is recovered by the creator exactly once through `withdraw`.
///
///         Money rules: one job's reward and bond are never mixed with another's; the bond goes to the worker
///         only on an arbitrator ruling for the worker (`moveBondToWorker`), and back to the creator on any
///         other terminal settlement.
contract JobHolding {
    using SafeERC20 for IERC20;

    struct Listing {
        address creator;
        uint48 deliveryDeadline;
        bool funded;
        bool rewardWithdrawn;
        bool bondSettled;
        uint256 reward;
        uint256 bond;
        bytes32 manifestHash;
    }

    ERC8183 public immutable core;
    IERC20 public immutable token;
    address public immutable deployer;
    /// @notice Set exactly once after deploy (the evaluator needs this address in its constructor).
    address public evaluator;

    mapping(uint256 jobId => Listing) public listings;

    event Published(
        uint256 indexed jobId,
        address indexed creator,
        bytes32 manifestHash,
        uint256 reward,
        uint256 bond,
        uint48 deliveryDeadline,
        uint48 expiredAt
    );
    event Assigned(uint256 indexed jobId, address indexed worker, uint256 agentId);
    event Funded(uint256 indexed jobId);
    event Cancelled(uint256 indexed jobId);
    event RewardWithdrawn(uint256 indexed jobId, address indexed creator, uint256 amount);
    event BondMovedToWorker(uint256 indexed jobId, address indexed worker, uint256 amount);
    event BondReturned(uint256 indexed jobId, address indexed creator, uint256 amount);

    error NotDeployer();
    error EvaluatorAlreadySet();
    error EvaluatorNotSet();
    error NotCreator();
    error NotEvaluator();
    error ZeroReward();
    error AgentIdRequired();
    error ExpiryTooShort();
    error AlreadyFunded();
    error AlreadyAssigned();
    error NotAccepted();
    error NothingToWithdraw();
    error BondAlreadySettled();

    constructor(ERC8183 core_, IERC20 token_) {
        core = core_;
        token = token_;
        deployer = msg.sender;
    }

    modifier onlyCreator(uint256 jobId) {
        if (listings[jobId].creator != msg.sender) revert NotCreator();
        _;
    }

    modifier onlyEvaluator() {
        if (msg.sender != evaluator) revert NotEvaluator();
        _;
    }

    /// @notice One-time wiring; the evaluator is immutable from then on.
    function setEvaluator(address evaluator_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (evaluator != address(0)) revert EvaluatorAlreadySet();
        evaluator = evaluator_;
    }

    // ---------------------------------------------------------------------------------------------
    // Creator actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Escrows `reward + bond` and creates the core job with Holding as client and no provider.
    /// @param manifestHash keccak256 of the canonical manifest JSON; the bytes live in R2.
    /// @param deliveryDeadline When the worker must have finalized. Enforced by the evaluator's
    ///        `rejectAfterDeliveryDeadline`; the board service refuses late finalizes off-chain too.
    /// @param expiredAt The core's expiry. Must leave the whole settlement window after delivery, so a
    ///        permissionless `claimRefund` can never pre-empt review, dispute filing or arbitration.
    function publish(bytes32 manifestHash, uint256 reward, uint256 bond, uint48 deliveryDeadline, uint48 expiredAt)
        external
        returns (uint256 jobId)
    {
        if (evaluator == address(0)) revert EvaluatorNotSet();
        if (reward == 0) revert ZeroReward();
        if (expiredAt < uint256(deliveryDeadline) + ISettlementWindow(evaluator).settlementWindow()) {
            revert ExpiryTooShort();
        }

        token.safeTransferFrom(msg.sender, address(this), reward + bond);
        jobId = core.createJob(
            address(0), evaluator, expiredAt, Strings.toHexString(uint256(manifestHash), 32), address(0), 0
        );
        listings[jobId] = Listing({
            creator: msg.sender,
            deliveryDeadline: deliveryDeadline,
            funded: false,
            rewardWithdrawn: false,
            bondSettled: false,
            reward: reward,
            bond: bond,
            manifestHash: manifestHash
        });
        emit Published(jobId, msg.sender, manifestHash, reward, bond, deliveryDeadline, expiredAt);
    }

    /// @notice Names the worker (and its ERC-8004 agent id) as the core's provider. The worker still has to
    ///         accept by setting the budget before anything is funded.
    function assign(uint256 jobId, address worker, uint256 agentId) external onlyCreator(jobId) {
        if (agentId == 0) revert AgentIdRequired();
        core.setProvider(jobId, worker, agentId);
        emit Assigned(jobId, worker, agentId);
    }

    /// @notice Cancels an unassigned listing. The core job becomes Rejected with nothing escrowed there;
    ///         `withdraw` then returns reward and bond.
    function cancel(uint256 jobId) external onlyCreator(jobId) {
        if (listings[jobId].funded) revert AlreadyFunded();
        if (core.getJob(jobId).provider != address(0)) revert AlreadyAssigned();
        core.reject(jobId, "cancelled", "");
        emit Cancelled(jobId);
    }

    /// @notice Recovers whatever of this job's money is back in Holding: the reward once the core job is
    ///         Rejected or Expired, the bond once the job is terminal and no ruling moved it. Each at most once.
    function withdraw(uint256 jobId) external onlyCreator(jobId) {
        Listing storage listing = listings[jobId];
        ERC8183.JobStatus status = core.getJob(jobId).status;
        uint256 amount;

        if (!listing.rewardWithdrawn && _rewardIsHere(status)) {
            listing.rewardWithdrawn = true;
            amount += listing.reward;
            emit RewardWithdrawn(jobId, listing.creator, listing.reward);
        }
        if (!listing.bondSettled && listing.bond > 0 && _isTerminal(status)) {
            listing.bondSettled = true;
            amount += listing.bond;
            emit BondReturned(jobId, listing.creator, listing.bond);
        }
        if (amount == 0) revert NothingToWithdraw();
        token.safeTransfer(listing.creator, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    /// @notice Funds the core once the assigned worker has accepted by setting the budget to exactly the
    ///         listed reward in the listed token. Anyone may call: the effect is fixed by the listing.
    function fundAfterAccept(uint256 jobId) external {
        Listing storage listing = listings[jobId];
        if (listing.creator == address(0)) revert NotCreator();
        if (listing.funded) revert AlreadyFunded();
        ERC8183.Job memory job = core.getJob(jobId);
        if (job.provider == address(0) || job.paymentToken != address(token) || job.budget != listing.reward) {
            revert NotAccepted();
        }
        listing.funded = true;
        token.forceApprove(address(core), listing.reward);
        core.fund(jobId, address(token), listing.reward, "");
        emit Funded(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Evaluator-only bond movements
    // ---------------------------------------------------------------------------------------------

    /// @notice The only path by which a bond reaches the worker: an arbitrator ruling for the worker.
    function moveBondToWorker(uint256 jobId) external onlyEvaluator {
        Listing storage listing = listings[jobId];
        if (listing.bondSettled) revert BondAlreadySettled();
        listing.bondSettled = true;
        if (listing.bond == 0) return;
        address worker = core.getJob(jobId).provider;
        token.safeTransfer(worker, listing.bond);
        emit BondMovedToWorker(jobId, worker, listing.bond);
    }

    /// @notice Returns the bond to the creator on any other terminal settlement. Idempotent for the
    ///         evaluator's convenience: a bond already settled is left alone.
    function returnBond(uint256 jobId) external onlyEvaluator {
        Listing storage listing = listings[jobId];
        if (listing.bondSettled) return;
        listing.bondSettled = true;
        if (listing.bond == 0) return;
        token.safeTransfer(listing.creator, listing.bond);
        emit BondReturned(jobId, listing.creator, listing.bond);
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

    /// @notice Whether Holding moved this job's reward into the core. The evaluator settles nothing else.
    function isFunded(uint256 jobId) external view returns (bool) {
        return listings[jobId].funded;
    }

    /// @dev Rejected or Expired means the core either never held the reward (cancelled or expired while
    ///      Open) or has refunded it to Holding. Completed means it went to the worker.
    function _rewardIsHere(ERC8183.JobStatus status) private pure returns (bool) {
        return status == ERC8183.JobStatus.Rejected || status == ERC8183.JobStatus.Expired;
    }

    function _isTerminal(ERC8183.JobStatus status) private pure returns (bool) {
        return status == ERC8183.JobStatus.Completed || _rewardIsHere(status);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Signatures} from "./Signatures.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ERC8183} from "./vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "./vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity} from "./vendor/erc8004/IERC8004.sol";

/// @dev What Holding needs from the evaluator: how long settlement can take after delivery, who is owed a reward
///      that a core refund put back into Holding, and the completion of an awarded contest entry.
interface ISettlementWindow {
    function settlementWindow() external view returns (uint48);
    function earnedByWorker(uint256 jobId) external view returns (bool);
    function workerPenaltyDue(uint256 jobId) external view returns (bool);
    function completeAward(uint256 jobId) external;
}

/// @title JobHolding
/// @notice The ERC-8183 *client* of every listed job (spec §4). Two assets: the reward in any ERC-20 the creator
///         names (ADR-0010: no allowlist), escrowed here at publish and moved into the core once the worker accepts; and
///         collateral in `$SIDE`, a creator bond pulled at publish and a worker bond pulled at accept, both
///         locked here through settlement. A hold requirement in SIDE gates publishing and claiming.
///
///         Two modes. Hire: the creator signs an EIP-712 `Selection` off-chain and the selected worker's own
///         `activate` transaction is the final confirmation: provider, bond, budget and funding in one step, so
///         nothing binds the worker before it acts and nobody else can start its bonded obligation (R114-01).
///         Contest: contests buy finished work. The prize is locked at publish; entrants submit finished
///         candidates off-chain with the authorisations needed to settle them; the approver's `award` pays the
///         chosen one in a single transaction before `selectionDeadline`, with the winner offline. A failed award
///         reverts everything and the contest stays open. With no award by the deadline anyone expires it and the
///         prize returns.
///
///         Money rules: one job's assets never mix with another's; a bond burns only on a finding the evaluator
///         made final (a ruling, an undisputed violation, a missed delivery); every other terminal path returns
///         both bonds; every refund the
///         core makes lands here as custody, not entitlement, and `settle` pays it to whoever the evaluator
///         says is owed it, exactly once (R114-03).
///
///         Arbitrary reward tokens (ADR-0010): the reward must arrive in full (a fee-on-transfer token is refused
///         at publish, as the core refuses one at `fund`); every entry point is non-reentrant, so a token's
///         transfer hook cannot re-enter; and a reward that cannot be sent at settlement (a blocklist, a paused
///         token) is owed to its recipient to `withdraw` later, so it never holds the bonds hostage. A token
///         that rebases down can leave the last listing in that token short; that risk is the creator's and the
///         worker's to judge from the token they chose.
contract JobHolding is EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice The creator's pick of one applicant for one listing. `termsHash` must equal the listing's
    ///         `policyHash`; `activateBy` bounds how long the pick stands and must precede the delivery deadline;
    ///         `nonce` is in the creator's own nonce space here (see `cancelSelection`).
    struct Selection {
        uint256 jobId;
        address worker;
        uint256 agentId;
        bytes32 termsHash;
        uint48 activateBy;
        uint256 nonce;
    }

    /// @notice A finished contest entry as the approver awards it: the entrant's registered agent wallet, the exact
    ///         deliverable, and the entrant's core authorisations (signed at entry) to set the budget to the prize
    ///         and to submit that deliverable.
    struct Candidate {
        address worker;
        uint256 agentId;
        bytes32 deliverable;
        ERC8183WithAuthorization.Authorization budgetAuth;
        ERC8183WithAuthorization.Authorization submitAuth;
    }

    bytes32 public constant SELECTION_TYPEHASH = keccak256(
        "Selection(uint256 jobId,address worker,uint256 agentId,bytes32 termsHash,uint48 activateBy,uint256 nonce)"
    );

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
        /// @dev Each bond's outcome once settled: burned, or returned to its owner.
        bool creatorBondBurned;
        bool workerBondBurned;
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

    ERC8183WithAuthorization public immutable core;
    /// @notice The bond token ("SIDE"): any plain ERC-20, e.g. our `FactoryToken` or a token launched elsewhere. A
    ///         fee-on-transfer token is refused at the first bond; a slashed bond is sent to `BURN_ADDRESS`, so the token
    ///         needs no `burn` function.
    IERC20 public immutable factory;
    /// @notice Where slashed bonds go. Tokens sent here are out of circulation for good.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @notice ERC-8004 Identity Registry: a worker participates with its registered agent wallet.
    IERC8004Identity public immutable identity;
    address public immutable admin;
    /// @notice Set exactly once after deploy (the evaluator needs this address in its constructor).
    address public evaluator;
    /// @notice SIDE a wallet must hold to publish, and to post a worker bond. Sybil resistance only.
    uint256 public minHoldToPublish;
    uint256 public minHoldToClaim;

    mapping(uint256 jobId => Listing) internal _listings;
    /// @notice Every `termsHash` ever listed. A retried publish of the same offer is refused rather than funding
    ///         a second escrow (R114-07).
    mapping(bytes32 policyHash => bool) public policyListed;
    /// @notice Selection nonces used by `activate` or burned by `cancelSelection`, per creator.
    mapping(address creator => mapping(uint256 nonce => bool)) public selectionNonceUsed;
    /// @notice Rewards `settle` could not send (the token refused the transfer), per token and recipient, for
    ///         the recipient to `withdraw` once the token lets it.
    mapping(IERC20 token => mapping(address to => uint256)) public owed;

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
    event Awarded(uint256 indexed jobId, address indexed worker, uint256 agentId, bytes32 deliverable);
    event Activated(uint256 indexed jobId, address indexed worker, uint256 agentId, uint256 selectionNonce);
    event SelectionCancelled(address indexed creator, uint256 nonce);
    event WorkerBondPosted(uint256 indexed jobId, address indexed worker, uint256 amount);
    event Funded(uint256 indexed jobId);
    event Cancelled(uint256 indexed jobId);
    event ContestExpired(uint256 indexed jobId);
    event RewardSettled(uint256 indexed jobId, address indexed to, uint256 amount);
    event RewardOwed(uint256 indexed jobId, address indexed to, address token, uint256 amount);
    event OwedWithdrawn(address indexed to, address indexed token, uint256 amount);
    event BondReturned(uint256 indexed jobId, Side side, address indexed to, uint256 amount);
    event BondBurned(uint256 indexed jobId, Side side, uint256 amount);
    event HoldRequirementsSet(uint256 minHoldToPublish, uint256 minHoldToClaim);

    error NotAdmin();
    error EvaluatorAlreadySet();
    error EvaluatorNotSet();
    error NotCreator();
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
    error BondTokenFeeOnTransfer(uint256 expected, uint256 received);
    error RewardTokenShortfall(uint256 expected, uint256 received);
    error NothingOwed();
    error AlreadyAwarded();
    error NotApprover();
    error SelectionWindowClosed();
    error SelectionWindowOpen();
    error UnknownJob();
    error NotSelectedWorker();
    error SelectionExpired();
    error SelectionInvalid();
    error SelectionNonceUsed();
    error TermsMismatch();
    error NotAgentWallet();
    error AlreadyActivated();
    error InvalidSignature();
    error NothingToSettle();
    error NotTerminal();

    constructor(
        ERC8183WithAuthorization core_,
        IERC20 factory_,
        IERC8004Identity identity_,
        uint256 minHoldToPublish_,
        uint256 minHoldToClaim_
    ) EIP712("SidequestHolding", "1") {
        core = core_;
        factory = factory_;
        identity = identity_;
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

    /// @notice Escrows the reward and the creator's SIDE bond and creates the core job with Holding as
    ///         client and no provider. The listing is the escrow.
    function publish(PublishParams calldata p) external nonReentrant returns (uint256 jobId) {
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
        uint256 before = p.token.balanceOf(address(this));
        p.token.safeTransferFrom(msg.sender, address(this), p.reward);
        uint256 received = p.token.balanceOf(address(this)) - before;
        if (received != p.reward) revert RewardTokenShortfall(p.reward, received);
        if (p.creatorBond > 0) _pullBond(msg.sender, p.creatorBond);

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

    /// @notice Burns one of the creator's selection nonces, so a signed but unactivated `Selection` can no longer
    ///         be used. Moves nothing.
    function cancelSelection(uint256 nonce) external {
        if (selectionNonceUsed[msg.sender][nonce]) revert SelectionNonceUsed();
        selectionNonceUsed[msg.sender][nonce] = true;
        emit SelectionCancelled(msg.sender, nonce);
    }

    /// @notice Cancels a hire listing before activation. Nothing was escrowed in the core; `settle` then
    ///         returns reward and creator bond. A published contest cannot be cancelled: entrants work against
    ///         the locked prize, so it ends only through `award` or `expireContest` (R16-02).
    function cancel(uint256 jobId) external nonReentrant onlyCreator(jobId) {
        if (_listings[jobId].mode != Mode.HireFirst) revert WrongMode();
        if (_listings[jobId].worker != address(0) || _listings[jobId].funded) revert AlreadyActivated();
        core.reject(jobId, "cancelled", "");
        emit Cancelled(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Approver actions
    // ---------------------------------------------------------------------------------------------

    /// @notice Buys a finished contest entry: in one transaction sets the entrant as provider, applies its budget
    ///         authorisation for exactly the prize, funds, applies its submit authorisation for exactly the named
    ///         deliverable, and has the evaluator complete it, paying the entrant and returning the creator bond.
    ///         The winner does nothing after entering. Any failure (a revoked, expired or foreign authorisation, a
    ///         changed registry wallet) reverts the whole award and the contest stays open. Allowed at
    ///         `selectionDeadline`, refused after. At most once.
    function award(uint256 jobId, Candidate calldata c) external nonReentrant {
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert UnknownJob();
        if (l.mode != Mode.Contest) revert WrongMode();
        if (msg.sender != l.approver) revert NotApprover();
        if (l.worker != address(0) || l.funded) revert AlreadyAwarded();
        if (block.timestamp > l.selectionDeadline) revert SelectionWindowClosed();
        if (c.agentId == 0) revert AgentIdRequired();
        if (identity.getAgentWallet(c.agentId) != c.worker) revert NotAgentWallet();

        l.worker = c.worker;
        l.funded = true;
        emit Awarded(jobId, c.worker, c.agentId, c.deliverable);

        core.setProvider(jobId, c.worker, c.agentId);
        core.setBudgetWithAuthorization(jobId, address(l.token), l.reward, "", c.budgetAuth);
        l.token.forceApprove(address(core), l.reward);
        core.fund(jobId, address(l.token), l.reward, "");
        emit Funded(jobId);
        core.submitWithAuthorization(jobId, c.deliverable, "", c.submitAuth);
        ISettlementWindow(evaluator).completeAward(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Worker actions
    // ---------------------------------------------------------------------------------------------

    /// @notice The selected worker's final confirmation of a hire, sent by the worker itself (never relayed,
    ///         R114-01). Checks the creator's `Selection` (signature, nonce, `activateBy`, `termsHash`), the
    ///         delivery deadline, the hold gate and that the sender is the agent's registered ERC-8004 wallet;
    ///         then sets the provider, pulls the worker bond, applies the worker's own `SetBudgetAuthorization`
    ///         for exactly the listed token and reward, and funds the core. All or nothing.
    /// @param budgetAuth The worker's signed core `SetBudgetAuthorization` for this job, token and reward; the
    ///        core's `setBudget` is provider-only and Holding is the caller, so the worker signs it.
    function activate(
        Selection calldata sel,
        bytes calldata creatorSig,
        ERC8183WithAuthorization.Authorization calldata budgetAuth
    ) external nonReentrant {
        uint256 jobId = sel.jobId;
        Listing storage l = _listings[jobId];
        if (l.creator == address(0)) revert UnknownJob();
        if (l.mode != Mode.HireFirst) revert WrongMode();
        if (l.worker != address(0) || l.funded) revert AlreadyActivated();
        if (msg.sender != sel.worker) revert NotSelectedWorker();
        // Allowed at its deadline, refused strictly after (the boundary convention).
        if (block.timestamp > sel.activateBy) revert SelectionExpired();
        if (sel.activateBy >= l.deliveryDeadline) revert SelectionInvalid();
        if (sel.termsHash != l.policyHash) revert TermsMismatch();
        if (selectionNonceUsed[l.creator][sel.nonce]) revert SelectionNonceUsed();
        if (!Signatures.isValid(l.creator, selectionDigest(sel), creatorSig)) {
            revert InvalidSignature();
        }
        if (sel.agentId == 0) revert AgentIdRequired();
        if (identity.getAgentWallet(sel.agentId) != msg.sender) revert NotAgentWallet();
        _requireHold(msg.sender, minHoldToClaim);

        selectionNonceUsed[l.creator][sel.nonce] = true;
        l.worker = msg.sender;
        l.workerBondPosted = true;
        l.funded = true;
        emit Activated(jobId, msg.sender, sel.agentId, sel.nonce);

        core.setProvider(jobId, msg.sender, sel.agentId);
        if (l.workerBond > 0) _pullBond(msg.sender, l.workerBond);
        emit WorkerBondPosted(jobId, msg.sender, l.workerBond);
        core.setBudgetWithAuthorization(jobId, address(l.token), l.reward, "", budgetAuth);
        l.token.forceApprove(address(core), l.reward);
        core.fund(jobId, address(l.token), l.reward, "");
        emit Funded(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------------------------------

    /// @notice Settles whatever of a terminal job is still in Holding, each amount once. The reward is here
    ///         after any rejection and after the core's permissionless `claimRefund`; it goes to the worker when
    ///         the evaluator says the worker earned it (a timely submission nobody rejected within the review
    ///         window), otherwise to the creator. The core status alone never decides who is paid (R114-03).
    ///         Bonds no evaluator path settled return to their owners, except a worker bond whose penalty is due
    ///         (a missed delivery, an undisputed violation), which burns: a terminal core status alone never
    ///         releases it. Anyone may call: the effect is fixed.
    function settle(uint256 jobId) external nonReentrant {
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
            if (ISettlementWindow(evaluator).workerPenaltyDue(jobId)) _burnBond(jobId, l, Side.Worker);
            else _returnBond(jobId, l, Side.Worker);
        }
        if (rewardTo == address(0) && !settled) revert NothingToSettle();
        if (rewardTo != address(0) && !l.token.trySafeTransfer(rewardTo, l.reward)) {
            owed[l.token][rewardTo] += l.reward;
            emit RewardOwed(jobId, rewardTo, address(l.token), l.reward);
        }
    }

    /// @notice Sends the caller what `settle` could not: every reward in `token` owed to it.
    function withdraw(IERC20 token) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[token][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit OwedWithdrawn(msg.sender, address(token), amount);
    }

    /// @notice A contest nobody was awarded by its selection deadline is over; the prize returns via `settle`.
    function expireContest(uint256 jobId) external nonReentrant {
        Listing storage l = _listings[jobId];
        if (l.mode != Mode.Contest) revert WrongMode();
        if (l.worker != address(0)) revert AlreadyAwarded();
        if (block.timestamp <= l.selectionDeadline) revert SelectionWindowOpen();
        core.reject(jobId, "contest-expired", "");
        emit ContestExpired(jobId);
    }

    // ---------------------------------------------------------------------------------------------
    // Evaluator-only collateral movements
    // ---------------------------------------------------------------------------------------------

    /// @notice Destroys one side's bond on a finding the evaluator made final: a ruling, an undisputed violation or
    ///         a missed delivery.
    function burnBond(uint256 jobId, Side side) external onlyEvaluator {
        Listing storage l = _listings[jobId];
        (, bool present) = _bondOf(l, side);
        if (!present) return;
        _burnBond(jobId, l, side);
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

    /// @notice The EIP-712 digest a creator signs for `sel` (domain "SidequestHolding", version "1").
    function selectionDigest(Selection calldata sel) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SELECTION_TYPEHASH, sel.jobId, sel.worker, sel.agentId, sel.termsHash, sel.activateBy, sel.nonce
                )
            )
        );
    }

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

    function _requireHold(address who, uint256 required) private view {
        uint256 held = factory.balanceOf(who);
        if (held < required) revert InsufficientFactoryHeld(held, required);
    }

    /// @dev Pulls a bond and checks the exact amount arrived: the holding pays bonds back 1:1, so a token that takes a
    ///      fee on transfer would leave settlements short.
    function _pullBond(address from, uint256 amount) private {
        uint256 before = factory.balanceOf(address(this));
        factory.safeTransferFrom(from, address(this), amount);
        uint256 received = factory.balanceOf(address(this)) - before;
        if (received != amount) revert BondTokenFeeOnTransfer(amount, received);
    }

    function _bondOf(Listing storage l, Side side) private view returns (uint256 amount, bool present) {
        if (side == Side.Creator) return (l.creatorBond, !l.creatorBondSettled);
        return (l.workerBond, l.workerBondPosted && !l.workerBondSettled);
    }

    function _markSettled(Listing storage l, Side side) private {
        if (side == Side.Creator) l.creatorBondSettled = true;
        else l.workerBondSettled = true;
    }

    function _burnBond(uint256 jobId, Listing storage l, Side side) private {
        (uint256 amount,) = _bondOf(l, side);
        _markSettled(l, side);
        if (side == Side.Creator) l.creatorBondBurned = true;
        else l.workerBondBurned = true;
        if (amount == 0) return;
        factory.safeTransfer(BURN_ADDRESS, amount);
        emit BondBurned(jobId, side, amount);
    }

    function _returnBond(uint256 jobId, Listing storage l, Side side) private {
        (uint256 amount,) = _bondOf(l, side);
        _markSettled(l, side);
        address to = side == Side.Creator ? l.creator : l.worker;
        if (amount > 0) factory.safeTransfer(to, amount);
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

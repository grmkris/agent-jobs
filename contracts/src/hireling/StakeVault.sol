// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IStakeVault} from "./interfaces/IStakeVault.sol";
import {HirelingConstants} from "./interfaces/HirelingConstants.sol";

/// @title StakeVault
/// @notice FACTORY staking and every Hireling bond (ADR-0011; the full contract is in `IStakeVault`). A bond is a
///         reservation of stake: no token moves when a bond is posted, a slash burns the reserved FACTORY, and a Holding
///         can only ever release or slash what it reserved itself. Holdings are authorized behind an 8-day timelock,
///         longer than the 7-day unstake cooldown, and revoked instantly; a revoked Holding still settles its live jobs.
///
///         This contract holds everyone's stake. Its only external calls are to the immutable FACTORY token, which has
///         no hooks, and every state-changing entry point is non-reentrant anyway.
contract StakeVault is IStakeVault, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IFactory;

    /// @dev FACTORY's whole supply is 1e27 wei, far below 2^128, so one slot holds both figures.
    struct Account {
        uint128 staked;
        uint128 reserved;
    }

    struct Cooldown {
        uint208 amount;
        uint48 unlockAt;
    }

    uint48 public constant UNSTAKE_DELAY = HirelingConstants.UNSTAKE_DELAY;
    uint48 public constant HOLDING_DELAY = HirelingConstants.HOLDING_DELAY;

    IFactory public immutable factory;

    uint256 public totalStaked;
    uint256 public totalReserved;
    uint256 public totalUnstaking;
    bool public bootstrapped;
    mapping(address holding => bool) public isHolding;
    mapping(address holding => mapping(address account => uint256)) public reservedBy;

    mapping(address account => Account) internal _accounts;
    mapping(address account => Cooldown) internal _cooldowns;
    address internal _pendingHolding;
    uint48 internal _pendingEta;

    constructor(IFactory factory_) Ownable(msg.sender) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    // ---------------------------------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant {
        _stake(msg.sender, msg.sender, amount);
    }

    function stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        // A permit someone already submitted (front-run) leaves the allowance in place; the transfer decides.
        try factory.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _stake(msg.sender, msg.sender, amount);
    }

    function stakeFor(address account, uint256 amount) external nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        _stake(msg.sender, account, amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[msg.sender];
        uint256 available = a.staked - a.reserved;
        if (amount > available) revert InsufficientAvailable(available, amount);
        a.staked -= uint128(amount);
        totalStaked -= amount;
        Cooldown storage c = _cooldowns[msg.sender];
        c.amount += uint208(amount);
        c.unlockAt = uint48(block.timestamp) + UNSTAKE_DELAY;
        totalUnstaking += amount;
        emit UnstakeRequested(msg.sender, amount, c.amount, c.unlockAt);
    }

    function cancelUnstake() external nonReentrant {
        uint256 amount = _cooldowns[msg.sender].amount;
        if (amount == 0) revert NothingUnstaking();
        delete _cooldowns[msg.sender];
        totalUnstaking -= amount;
        _accounts[msg.sender].staked += uint128(amount);
        totalStaked += amount;
        emit UnstakeCancelled(msg.sender, amount);
    }

    function withdraw() external nonReentrant {
        Cooldown memory c = _cooldowns[msg.sender];
        if (c.amount == 0) revert NothingUnstaking();
        if (block.timestamp < c.unlockAt) revert UnstakeLocked(c.unlockAt);
        delete _cooldowns[msg.sender];
        totalUnstaking -= c.amount;
        factory.safeTransfer(msg.sender, c.amount);
        emit Withdrawn(msg.sender, c.amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Bonds
    // ---------------------------------------------------------------------------------------------

    function reserve(address account, uint256 amount) external nonReentrant {
        if (!isHolding[msg.sender]) revert NotHolding();
        if (amount == 0) return;
        Account storage a = _accounts[account];
        uint256 available = a.staked - a.reserved;
        if (amount > available) revert InsufficientAvailable(available, amount);
        a.reserved += uint128(amount);
        reservedBy[msg.sender][account] += amount;
        totalReserved += amount;
        emit Reserved(msg.sender, account, amount);
    }

    function release(address account, uint256 amount) external nonReentrant returns (uint256 released) {
        released = _unreserve(account, amount);
        if (released == 0) return 0;
        emit Released(msg.sender, account, released);
    }

    function slash(address account, uint256 amount) external nonReentrant returns (uint256 burned) {
        burned = _unreserve(account, amount);
        if (burned == 0) return 0;
        _accounts[account].staked -= uint128(burned);
        totalStaked -= burned;
        factory.burn(burned);
        emit Slashed(msg.sender, account, burned);
    }

    // ---------------------------------------------------------------------------------------------
    // Holding authorization
    // ---------------------------------------------------------------------------------------------

    function proposeHolding(address holding) external onlyOwner {
        if (holding == address(0)) revert ZeroAddress();
        if (isHolding[holding]) revert HoldingAlreadyAuthorized();
        uint48 eta = uint48(block.timestamp) + HOLDING_DELAY;
        _pendingHolding = holding;
        _pendingEta = eta;
        emit HoldingProposed(holding, eta);
    }

    function cancelHoldingProposal() external onlyOwner {
        address holding = _pendingHolding;
        if (holding == address(0)) revert NoHoldingProposed();
        delete _pendingHolding;
        delete _pendingEta;
        emit HoldingProposalCancelled(holding);
    }

    function acceptHolding() external {
        address holding = _pendingHolding;
        if (holding == address(0)) revert NoHoldingProposed();
        if (block.timestamp < _pendingEta) revert HoldingTimelocked(_pendingEta);
        delete _pendingHolding;
        delete _pendingEta;
        isHolding[holding] = true;
        emit HoldingAuthorized(holding, false);
    }

    function revokeHolding(address holding) external onlyOwner {
        if (!isHolding[holding]) revert NotHolding();
        isHolding[holding] = false;
        emit HoldingRevoked(holding);
    }

    /// @dev Safe at launch because the recipe bootstraps before any FACTORY reaches a third party: until then only the
    ///      deployer and the Safe hold it, so nobody can stake first to block the bootstrap.
    function bootstrapHolding(address holding) external onlyOwner {
        if (bootstrapped || totalStaked != 0) revert BootstrapClosed();
        if (holding == address(0)) revert ZeroAddress();
        bootstrapped = true;
        isHolding[holding] = true;
        emit HoldingAuthorized(holding, true);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function stakeOf(address account) external view returns (uint256) {
        return _accounts[account].staked;
    }

    function reservedOf(address account) external view returns (uint256) {
        return _accounts[account].reserved;
    }

    function availableOf(address account) external view returns (uint256) {
        Account memory a = _accounts[account];
        return a.staked - a.reserved;
    }

    function unstakeOf(address account) external view returns (uint256 amount, uint48 unlockAt) {
        Cooldown memory c = _cooldowns[account];
        return (c.amount, c.unlockAt);
    }

    function pendingHolding() external view returns (address holding, uint48 eta) {
        return (_pendingHolding, _pendingEta);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _stake(address payer, address account, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        factory.safeTransferFrom(payer, address(this), amount);
        _accounts[account].staked += uint128(amount);
        totalStaked += amount;
        emit Staked(account, payer, amount);
    }

    /// @dev Removes up to `amount` of the caller's own reservation on `account`. Capped rather than reverting, so a
    ///      Holding's settlement can never be blocked here.
    function _unreserve(address account, uint256 amount) private returns (uint256 taken) {
        uint256 mine = reservedBy[msg.sender][account];
        taken = amount < mine ? amount : mine;
        if (taken == 0) return 0;
        reservedBy[msg.sender][account] = mine - taken;
        _accounts[account].reserved -= uint128(taken);
        totalReserved -= taken;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFactory} from "./IFactory.sol";

/// @title IStakeVault
/// @notice Where FACTORY is staked, and where every Hireling bond lives (ADR-0011). A bond is a *reservation* of
///         stake, not a transfer: publishing reserves the creator's bond, activating reserves the worker's, and
///         settlement releases a reservation or slashes it, which burns that FACTORY for good. No token moves when a
///         bond is posted.
///
///         Staking: `stake`, `stakeWithPermit`, or `stakeFor` (anyone may add stake to any account; the mining
///         distributor claims this way). Unstaking: `requestUnstake` moves unreserved stake into a 7-day cooldown, after
///         which `withdraw` pays it out; `cancelUnstake` puts it back. Stake in cooldown no longer counts for the fee
///         tier and cannot be reserved.
///
///         Holdings: only an authorized Holding can reserve. The owner (the Safe) proposes a Holding, anyone accepts it
///         after 8 days (longer than the 7-day cooldown, so every staker can leave first), and the owner can revoke one
///         instantly. A revoked Holding can no longer reserve, but it still releases and slashes the reservations it
///         made, so live jobs settle. `bootstrapHolding` authorizes the first Holding without the delay, once. Staking
///         stays closed until a first Holding is authorized (bootstrapped or accepted), so nobody can stake first to
///         force the launch onto the 8-day path. A Holding can only ever release or slash what it reserved itself
///         (`reservedBy`).
///
///         Invariants: `reservedOf(a) <= stakeOf(a)` for every account; `totalReserved <= totalStaked`; the vault's
///         FACTORY balance is at least `totalStaked + totalUnstaking`.
///
///         The implementation is `Ownable2Step`; the ownership functions come from OpenZeppelin and are not repeated.
interface IStakeVault {
    event Staked(address indexed account, address indexed payer, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint256 totalUnstaking, uint48 unlockAt);
    event UnstakeCancelled(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event Reserved(address indexed holding, address indexed account, uint256 amount);
    event Released(address indexed holding, address indexed account, uint256 amount);
    /// @dev The slashed FACTORY is burned in the same call.
    event Slashed(address indexed holding, address indexed account, uint256 amount);
    event HoldingProposed(address indexed holding, uint48 eta);
    event HoldingProposalCancelled(address indexed holding);
    event HoldingAuthorized(address indexed holding, bool bootstrap);
    event HoldingRevoked(address indexed holding);
    event HoldingDeniedSet(address indexed account, address indexed holding, bool denied);

    error ZeroAmount();
    error ZeroAddress();
    /// @dev Only unreserved stake can be reserved or unstaked.
    error InsufficientAvailable(uint256 available, uint256 requested);
    error NotHolding();
    error NothingUnstaking();
    error UnstakeLocked(uint48 unlockAt);
    error NoHoldingProposed();
    error HoldingTimelocked(uint48 eta);
    error HoldingAlreadyAuthorized();
    error BootstrapClosed();
    /// @dev Staking opens when the first Holding is authorized.
    error NotBootstrapped();
    /// @dev The account vetoed this Holding (`setHoldingDenied`).
    error HoldingDenied();
    /// @dev The proposal's acceptance window (`PROPOSAL_GRACE` after its eta) has passed.
    error HoldingProposalExpired();

    // ---------------------------------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------------------------------

    /// @notice Stakes `amount` of the caller's FACTORY (needs an allowance).
    function stake(uint256 amount) external;

    /// @notice Stakes with an EIP-2612 permit instead of an allowance, saving the `approve` transaction. The permit's
    ///         owner and the payer are both the caller, so a relay cannot submit it for an EOA (a sponsored 7702/4337
    ///         call from the holder's own account can). A permit that was already used (front-run) is tolerated as long
    ///         as the allowance is in place.
    function stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;

    /// @notice Stakes `amount` of the caller's FACTORY for `account`. Used by the mining distributor.
    function stakeFor(address account, uint256 amount) external;

    /// @notice Moves `amount` of the caller's unreserved stake into the cooldown. A second request adds to the first
    ///         and restarts the cooldown for the whole amount.
    function requestUnstake(uint256 amount) external;

    /// @notice Puts everything in the caller's cooldown back into stake.
    function cancelUnstake() external;

    /// @notice Pays out the caller's whole cooldown amount once `unlockAt` has passed.
    function withdraw() external;

    // ---------------------------------------------------------------------------------------------
    // Bonds (Holdings only)
    // ---------------------------------------------------------------------------------------------

    /// @notice An authorized Holding reserves `amount` of `account`'s unreserved stake as a bond. A zero amount
    ///         reserves nothing but still requires the caller to be authorized, so a revoked Holding stops publishing.
    ///         Refused for a Holding the account has denied.
    function reserve(address account, uint256 amount) external;

    /// @notice The caller vetoes (or re-allows) `holding` taking new bonds from its stake (C9 ACL-1). The 8-day delay
    ///         lets free stake leave before a new Holding goes live; this protects stake that is still bonded when
    ///         the Holding arrives and is released later, and mining rewards claimed for the caller. Existing
    ///         reservations still release and slash.
    function setHoldingDenied(address holding, bool denied) external;

    /// @notice Whether `account` has denied `holding`.
    function holdingDenied(address account, address holding) external view returns (bool);

    /// @notice Releases up to `amount` of the reservation the caller holds on `account` (any Holding, revoked or not).
    /// @return released The amount released: `min(amount, reservedBy(caller, account))`.
    function release(address account, uint256 amount) external returns (uint256 released);

    /// @notice Slashes up to `amount` of the reservation the caller holds on `account` and burns it.
    /// @return burned The amount burned: `min(amount, reservedBy(caller, account))`.
    function slash(address account, uint256 amount) external returns (uint256 burned);

    // ---------------------------------------------------------------------------------------------
    // Holding authorization (owner = the Safe)
    // ---------------------------------------------------------------------------------------------

    /// @notice Owner only. Proposes `holding`, replacing (and cancelling) any earlier proposal; it can be accepted
    ///         from `HOLDING_DELAY` until `PROPOSAL_GRACE` after that. An ownership transfer drops it.
    function proposeHolding(address holding) external;

    /// @notice Owner only. Drops the pending proposal.
    function cancelHoldingProposal() external;

    /// @notice Anyone, once the delay has passed: authorizes the pending Holding.
    function acceptHolding() external;

    /// @notice Owner only, instant. `holding` can no longer reserve; its existing reservations still release and slash.
    ///         A pending proposal for the same Holding is dropped, so it cannot be re-accepted.
    function revokeHolding(address holding) external;

    /// @notice Owner only, once, and only before any Holding was authorized and while none is proposed: authorizes
    ///         the first Holding without the delay and opens staking.
    function bootstrapHolding(address holding) external;

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function factory() external view returns (IFactory);

    /// @notice `account`'s stake, reservations included and the cooldown excluded. This is what sets the fee tier.
    function stakeOf(address account) external view returns (uint256);

    /// @notice The part of `account`'s stake that bonds on live jobs hold, over all Holdings.
    function reservedOf(address account) external view returns (uint256);

    /// @notice The part of `account`'s stake that `holding` has reserved.
    function reservedBy(address holding, address account) external view returns (uint256);

    /// @notice `stakeOf(account) - reservedOf(account)`: what can still be reserved or unstaked.
    function availableOf(address account) external view returns (uint256);

    /// @notice `account`'s cooldown: the amount and when it can be withdrawn (zero when nothing is unstaking).
    function unstakeOf(address account) external view returns (uint256 amount, uint48 unlockAt);

    function totalStaked() external view returns (uint256);
    function totalReserved() external view returns (uint256);
    function totalUnstaking() external view returns (uint256);

    /// @notice Whether `holding` may reserve stake now.
    function isHolding(address holding) external view returns (bool);

    /// @notice The proposed Holding and when it can be accepted; zero when none.
    function pendingHolding() external view returns (address holding, uint48 eta);

    /// @notice Whether a first Holding has been authorized (by `bootstrapHolding` or `acceptHolding`): staking is open
    ///         and `bootstrapHolding` is closed.
    function bootstrapped() external view returns (bool);

    /// @notice The unstake cooldown (7 days).
    function UNSTAKE_DELAY() external view returns (uint48);

    /// @notice The delay before a proposed Holding can be accepted (8 days).
    function HOLDING_DELAY() external view returns (uint48);

    /// @notice How long after its eta a Holding proposal can still be accepted (7 days).
    function PROPOSAL_GRACE() external view returns (uint48);
}

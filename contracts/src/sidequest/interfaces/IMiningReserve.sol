// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFactory} from "./IFactory.sol";

/// @title IMiningReserve
/// @notice Holds the 500M SIDE mining allocation and releases it to the `IEpochDistributor` one epoch at a time
///         (ADR-0011). The economic schedule is fixed: epoch 0 has budget W · 3/7, where
///         W = 500M / 52; epoch k ≥ 1 gets `W >> ((k - 1) / 26)`, halving every 26 epochs. Epoch lengths are
///         constructor immutables: production is 72 h from `genesis`, then one week.
///
///         `fund` is the owner's (the Safe's) only power: it sends SIDE to the distributor for an epoch that has
///         ended, capped so the total ever funded never exceeds the cumulative budget through that epoch. Unspent
///         budget therefore rolls over. A bad epoch root can drain at most what was funded for it. The α = 0.5 cap on
///         emissions against fee value is applied off-chain when the epoch total is computed.
///
///         The implementation is `Ownable2Step`; the ownership functions come from OpenZeppelin.
interface IMiningReserve {
    event EpochFunded(uint256 indexed epoch, uint256 amount, uint256 totalFunded);

    error ZeroAmount();
    error ZeroAddress();
    /// @dev Genesis must be given explicitly and be the same for the reserve and the distributor.
    error ZeroGenesis();
    error BeforeGenesis();
    error EpochNotEnded(uint256 epoch, uint256 endsAt);
    error ExceedsBudget(uint256 requested, uint256 available);

    /// @notice Owner only. Sends `amount` SIDE to the distributor for `epoch`, which must have ended. Reverts if
    ///         `totalFunded + amount` would exceed `cumulativeBudget(epoch)`.
    function fund(uint256 epoch, uint256 amount) external;

    function factory() external view returns (IFactory);
    function distributor() external view returns (address);

    /// @notice When epoch 0 starts.
    function genesis() external view returns (uint48);

    /// @notice SIDE sent to the distributor so far.
    function totalFunded() external view returns (uint256);

    /// @notice The epoch running now. Reverts `BeforeGenesis` before `genesis`.
    function currentEpoch() external view returns (uint256);

    function epochStart(uint256 epoch) external view returns (uint256);
    function epochEnd(uint256 epoch) external view returns (uint256);

    /// @notice The budget of one epoch: W · 3/7 for epoch 0, `W >> ((epoch - 1) / 26)` after, cut where the
    ///         cumulative budget reaches the 500M cap (epoch 181) and zero after it.
    function budget(uint256 epoch) external view returns (uint256);

    /// @notice The sum of `budget(0..epoch)`, capped at the 500M the reserve holds (the uncapped series reaches
    ///         500M + W · 3/7 after about seven halving eras).
    function cumulativeBudget(uint256 epoch) external view returns (uint256);

    /// @notice W = 500M / 52 SIDE.
    function WEEKLY_BUDGET() external view returns (uint256);
    function EPOCH_ZERO_DURATION() external view returns (uint48);
    function EPOCH_DURATION() external view returns (uint48);
    function HALVING_EPOCHS() external view returns (uint256);
}

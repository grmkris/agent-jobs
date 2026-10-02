// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HirelingConstants} from "./interfaces/HirelingConstants.sol";

/// @title MiningSchedule
/// @notice The fixed work-mining schedule (ADR-0011), shared by `MiningReserve` and `EpochDistributor` so both read
///         the same epoch boundaries from the same `genesis`. Epoch 0 runs 72 h and gets W · 3/7; epoch k ≥ 1 runs a
///         week and gets `W >> ((k - 1) / 26)`, where W = 500M / 52 FACTORY.
library MiningSchedule {
    uint256 internal constant W = HirelingConstants.WEEKLY_BUDGET;
    uint256 internal constant HALVING = HirelingConstants.HALVING_EPOCHS;

    function epochStart(uint48 genesis, uint256 epoch) internal pure returns (uint256) {
        if (epoch == 0) return genesis;
        return uint256(genesis) + HirelingConstants.EPOCH_ZERO_DURATION + (epoch - 1) * HirelingConstants.EPOCH_DURATION;
    }

    function epochEnd(uint48 genesis, uint256 epoch) internal pure returns (uint256) {
        return epochStart(genesis, epoch + 1);
    }

    /// @dev `t` must not be before `genesis`.
    function epochAt(uint48 genesis, uint256 t) internal pure returns (uint256) {
        uint256 zeroEnd = uint256(genesis) + HirelingConstants.EPOCH_ZERO_DURATION;
        if (t < zeroEnd) return 0;
        return 1 + (t - zeroEnd) / HirelingConstants.EPOCH_DURATION;
    }

    /// @dev What `fund` can actually add for `epoch`: the schedule's budget, cut at the 500M cap (C9 MATH-4), so the
    ///      budgets always sum to `cumulativeBudget` and are zero once the reserve is spoken for (epoch 182 on).
    function budget(uint256 epoch) internal pure returns (uint256) {
        if (epoch == 0) return cumulativeBudget(0);
        return cumulativeBudget(epoch) - cumulativeBudget(epoch - 1);
    }

    /// @dev Closed form per halving era, capped at the reserve: the uncapped series converges to 500M + W · 3/7 and
    ///      passes 500M after about seven eras, so the tail is what the reserve still holds.
    function cumulativeBudget(uint256 epoch) internal pure returns (uint256 total) {
        total = W * 3 / 7;
        if (epoch == 0) return total;
        uint256 eras = epoch / HALVING;
        uint256 rest = epoch % HALVING;
        for (uint256 j; j < eras; ++j) {
            uint256 weekly = W >> j;
            if (weekly == 0 || total >= HirelingConstants.MINING_RESERVE) break;
            total += HALVING * weekly;
        }
        if (eras < 256) total += rest * (W >> eras);
        if (total > HirelingConstants.MINING_RESERVE) total = HirelingConstants.MINING_RESERVE;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SidequestConstants} from "./interfaces/SidequestConstants.sol";

/// @title MiningSchedule
/// @notice The fixed work-mining schedule (ADR-0011), shared by `MiningReserve` and `EpochDistributor` so both read
///         the same epoch boundaries from the same `genesis`. Epoch lengths are constructor immutables (production: 72 h then a week). Epoch 0 gets W · 3/7;
///         epoch k ≥ 1 gets `W >> ((k - 1) / 26)`, where W = 500M / 52 SIDE.
library MiningSchedule {
    uint256 internal constant W = SidequestConstants.WEEKLY_BUDGET;
    uint256 internal constant HALVING = SidequestConstants.HALVING_EPOCHS;

    function epochStart(uint48 genesis, uint256 epoch, uint48 zeroDuration, uint48 duration)
        internal
        pure
        returns (uint256)
    {
        if (epoch == 0) return genesis;
        return uint256(genesis) + zeroDuration + (epoch - 1) * duration;
    }

    function epochEnd(uint48 genesis, uint256 epoch, uint48 zeroDuration, uint48 duration)
        internal
        pure
        returns (uint256)
    {
        return epochStart(genesis, epoch + 1, zeroDuration, duration);
    }

    /// @dev `t` must not be before `genesis`.
    function epochAt(uint48 genesis, uint256 t, uint48 zeroDuration, uint48 duration) internal pure returns (uint256) {
        uint256 zeroEnd = uint256(genesis) + zeroDuration;
        if (t < zeroEnd) return 0;
        return 1 + (t - zeroEnd) / duration;
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
            if (weekly == 0 || total >= SidequestConstants.MINING_RESERVE) break;
            total += HALVING * weekly;
        }
        if (eras < 256) total += rest * (W >> eras);
        if (total > SidequestConstants.MINING_RESERVE) total = SidequestConstants.MINING_RESERVE;
    }
}

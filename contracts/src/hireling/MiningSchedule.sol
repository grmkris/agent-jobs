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

    function budget(uint256 epoch) internal pure returns (uint256) {
        if (epoch == 0) return W * 3 / 7;
        uint256 era = (epoch - 1) / HALVING;
        return era >= 256 ? 0 : W >> era;
    }

    /// @dev Closed form per halving era; the loop ends once the budget has halved to zero (about 84 eras).
    function cumulativeBudget(uint256 epoch) internal pure returns (uint256 total) {
        total = W * 3 / 7;
        if (epoch == 0) return total;
        uint256 eras = epoch / HALVING;
        uint256 rest = epoch % HALVING;
        for (uint256 j; j < eras; ++j) {
            uint256 weekly = W >> j;
            if (weekly == 0) return total;
            total += HALVING * weekly;
        }
        if (eras < 256) total += rest * (W >> eras);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HirelingConstants as C} from "./interfaces/HirelingConstants.sol";

/// @notice Deploy-time clocks (D24). One compiled program, production-only values
/// on chain 143. Constructors copy their relevant fields into named immutables.
library HirelingClocks {
    struct Config {
        uint32 minReviewWindow;
        uint32 minDisputeWindow;
        uint32 minArbitrationWindow;
        uint48 unstakeDelay;
        uint48 holdingDelay;
        uint48 feeDelay;
        uint48 proposalGrace;
        uint48 epochZeroDuration;
        uint48 epochDuration;
    }

    error InvalidClock(bytes32 clock, uint256 value);

    function production() internal pure returns (Config memory) {
        return Config(
            C.MIN_REVIEW_WINDOW,
            C.MIN_DISPUTE_WINDOW,
            C.MIN_ARBITRATION_WINDOW,
            C.UNSTAKE_DELAY,
            C.HOLDING_DELAY,
            C.FEE_DELAY,
            C.PROPOSAL_GRACE,
            C.EPOCH_ZERO_DURATION,
            C.EPOCH_DURATION
        );
    }

    function validate(Config memory c) internal view {
        _check("minReviewWindow", c.minReviewWindow, 1, C.MAX_REVIEW_WINDOW, C.MIN_REVIEW_WINDOW);
        _check("minDisputeWindow", c.minDisputeWindow, 1, C.MAX_DISPUTE_WINDOW, C.MIN_DISPUTE_WINDOW);
        _check("minArbitrationWindow", c.minArbitrationWindow, 1, C.MAX_ARBITRATION_WINDOW, C.MIN_ARBITRATION_WINDOW);
        // Cap additions so uint48 timestamp arithmetic cannot wrap even near
        // the present timestamp. Holding notice must still outlast withdrawal.
        uint256 maxDelay = type(uint48).max - block.timestamp;
        _check("unstakeDelay", c.unstakeDelay, 60, maxDelay, C.UNSTAKE_DELAY);
        _check("holdingDelay", c.holdingDelay, 60, maxDelay, C.HOLDING_DELAY);
        _check("feeDelay", c.feeDelay, 60, maxDelay, C.FEE_DELAY);
        _check("proposalGrace", c.proposalGrace, 60, maxDelay, C.PROPOSAL_GRACE);
        if (c.holdingDelay <= c.unstakeDelay) revert InvalidClock("holdingDelay", c.holdingDelay);
        _check("epochZeroDuration", c.epochZeroDuration, 600, type(uint48).max, C.EPOCH_ZERO_DURATION);
        _check("epochDuration", c.epochDuration, 600, type(uint48).max, C.EPOCH_DURATION);
    }

    function _check(bytes32 name, uint256 value, uint256 min, uint256 max, uint256 prod) private view {
        if (value < min || value > max || (block.chainid == 143 && value != prod)) revert InvalidClock(name, value);
    }
}

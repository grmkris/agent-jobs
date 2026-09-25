// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title RewardToken
/// @notice Testnet-only ERC-20 with an open faucet. No yield, no liquidity, no admin. Rewards and bonds are
///         denominated in it so one asset backs both (spec §4).
contract RewardToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e18;

    constructor() ERC20("Agent Jobs Reward (testnet)", "AJR") {}

    /// @notice Mints FAUCET_AMOUNT to the caller. Testnet only.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Mints an arbitrary amount. Testnet only; the deployed token has no owner on purpose.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

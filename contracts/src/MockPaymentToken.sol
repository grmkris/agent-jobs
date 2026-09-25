// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockPaymentToken
/// @notice A 6-decimal, USDC-like faucet token for the demo's rewards. Any allowlisted ERC-20 works as a
///         reward; this one exists so the demo shows a payment asset that is visibly not `$FACTORY`.
contract MockPaymentToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    constructor() ERC20("Mock USD (testnet)", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

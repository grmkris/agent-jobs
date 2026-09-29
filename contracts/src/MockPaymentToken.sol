// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockPaymentToken
/// @notice **Testnet only, never deployed on mainnet.** A 6-decimal faucet reward token, deployed twice on Monad
///         testnet as `mUSD` and `mEUR` so a quote can name either. Anyone may mint: it has no value. Mainnet
///         rewards are real ERC-20s (any, ADR-0010; USDC listed first); `config/monad-mainnet.json` lists no faucet token.
contract MockPaymentToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

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

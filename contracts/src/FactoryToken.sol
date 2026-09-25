// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title FactoryToken
/// @notice Test `$FACTORY`: the collateral asset (spec §1 "Two assets"). Held to publish or claim, bonded per
///         job, burned by Holding on a ruling that finds a violation. Never a reward, never inside the core.
///         Testnet only: open faucet, no admin.
contract FactoryToken is ERC20Burnable {
    uint256 public constant FAUCET_AMOUNT = 1_000e18;

    constructor() ERC20("Factory (testnet)", "FACTORY") {}

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

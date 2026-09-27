// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title FactoryToken
/// @notice `$FACTORY`, 18 decimals: collateral only, never a reward, never in the ERC-8183 core. Holding burns a bond
///         only when its penalty is final. Two configurations, fixed at deploy and never switchable (R114-09):
///         testnet, with an open faucet and open mint; production, with no faucet and minting only by `minter`
///         (supply and mint authority are decided before mainnet).
contract FactoryToken is ERC20Burnable {
    uint256 public constant FAUCET_AMOUNT = 1_000e18;

    /// @notice True only on testnet. Immutable: a production deployment cannot enable it.
    bool public immutable faucetEnabled;
    /// @notice The only address that may mint when the faucet is off. Ignored on testnet.
    address public immutable minter;

    error FaucetDisabled();
    error NotMinter();

    constructor(string memory name_, string memory symbol_, bool faucetEnabled_, address minter_)
        ERC20(name_, symbol_)
    {
        faucetEnabled = faucetEnabled_;
        minter = minter_;
    }

    function faucet() external {
        if (!faucetEnabled) revert FaucetDisabled();
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        if (!faucetEnabled && msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title IFactory
/// @notice SIDE v2 (ADR-0011): a plain ERC-20 with 18 decimals, EIP-2612 `permit` and `burn`. The whole supply of
///         1e9 SIDE is minted once in the constructor to the genesis allocation; there is no owner, no mint, no
///         pause, no blocklist and no upgrade, so nobody can freeze stake or bonds. The staking vault burns slashed
///         bonds with `burn`.
interface IFactory is IERC20Metadata, IERC20Permit {
    /// @notice Destroys `amount` of the caller's tokens, reducing the total supply.
    function burn(uint256 amount) external;

    /// @notice Destroys `amount` of `account`'s tokens against the caller's allowance.
    function burnFrom(address account, uint256 amount) external;
}

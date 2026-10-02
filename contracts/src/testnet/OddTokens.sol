// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title BlocklistUSD
/// @notice Testnet only (C11): a 6-decimal stablecoin stand-in whose owner can block an address, like USDC's
///         blocklist. Live evidence for Hireling v1's M2 path: block the worker after activation and a payout is
///         deferred and then owed instead of blocking the decision. Not for mainnet; worth nothing.
contract BlocklistUSD is ERC20, Ownable {
    mapping(address account => bool) public blocked;

    event Blocked(address indexed account, bool blocked);

    error AccountBlocked(address account);

    constructor(address owner_) ERC20("Blocklist USD (testnet)", "bUSD") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external onlyOwner {
        blocked[account] = isBlocked;
        emit Blocked(account, isBlocked);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert AccountBlocked(from);
        if (blocked[to]) revert AccountBlocked(to);
        super._update(from, to, value);
    }
}

/// @title GasBurnerUSD
/// @notice Testnet only (C11): a 6-decimal token whose owner can make transfers *to* an address burn gas first,
///         `rounds` rounds of hashing, or every gas unit forwarded when `rounds` is `type(uint256).max`. Live evidence
///         for C9-001: a decision still lands (`CORE_GAS` caps the core call) and the payout is deferred, then owed.
///         Mints are never slowed. Not for mainnet; worth nothing.
contract GasBurnerUSD is ERC20, Ownable {
    mapping(address account => uint256) public rounds;
    uint256 public sink;

    event Hungry(address indexed account, uint256 rounds);

    constructor(address owner_) ERC20("Gas Burner USD (testnet)", "gUSD") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setHungry(address account, uint256 rounds_) external onlyOwner {
        rounds[account] = rounds_;
        emit Hungry(account, rounds_);
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 n = rounds[to];
        if (n != 0 && from != address(0)) {
            bytes32 h = bytes32(value);
            if (n == type(uint256).max) {
                while (true) {
                    h = keccak256(abi.encode(h));
                }
            }
            for (uint256 i; i < n; ++i) {
                h = keccak256(abi.encode(h));
            }
            if (h == bytes32(0)) sink = 1;
        }
        super._update(from, to, value);
    }
}

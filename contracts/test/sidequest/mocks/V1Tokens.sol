// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A token its issuer can freeze entirely: while paused every transfer reverts (both `complete` and `reject`
///      fail, the M2 worst case).
contract PausableToken is ERC20 {
    bool public paused;

    constructor() ERC20("Pausy", "PAU") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "paused");
        super._update(from, to, value);
    }
}

/// @dev Transfers to a flagged recipient burn a fixed amount of gas first (`iterations` rounds of hashing), or never
///      finish when `iterations` is max. Models a gas-bomb token and an honest but expensive one.
contract GasHungryToken is ERC20 {
    mapping(address => uint256) public iterations;
    uint256 public sink;

    constructor() ERC20("Hungry", "HGY") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHungry(address who, uint256 rounds) external {
        iterations[who] = rounds;
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 rounds = iterations[to];
        if (rounds != 0 && from != address(0)) {
            bytes32 h = bytes32(value);
            if (rounds == type(uint256).max) {
                while (true) {
                    h = keccak256(abi.encode(h));
                }
            }
            for (uint256 i; i < rounds; ++i) {
                h = keccak256(abi.encode(h));
            }
            if (h == bytes32(0)) sink = 1;
        }
        super._update(from, to, value);
    }
}

/// @dev Moves the balance on `transfer`, then reports failure for a flagged recipient: `false` (mode 1) or a 1-byte
///      return (mode 2). The C9-002 case: the move must not stick while Holding also records `owed`.
contract LyingToken is ERC20 {
    mapping(address => uint8) public mode;

    constructor() ERC20("Liar", "LIE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(address who, uint8 m) external {
        mode[who] = m;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _transfer(msg.sender, to, value);
        uint8 m = mode[to];
        if (m == 1) return false;
        if (m == 2) {
            assembly ("memory-safe") {
                mstore(0, shl(248, 1))
                return(0, 1)
            }
        }
        return true;
    }
}

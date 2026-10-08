// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Stands in for the ERC-8004 Reputation Registry in unit tests. `mode` selects success, a revert, or a
///      gas bomb, so the evaluator's bounded `try/catch` can be exercised without a fork.
contract MockReputation {
    enum Mode {
        Ok,
        Revert,
        BurnGas,
        /// @dev Costs ~250k gas, like a first feedback for an agent on the real registry.
        Expensive
    }
    mapping(uint256 => uint256) internal sink;

    Mode public mode;
    uint256 public calls;
    uint256 public lastAgentId;
    int128 public lastValue;
    string public lastTag2;
    address public lastClient;

    function setMode(Mode m) external {
        mode = m;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32
    ) external {
        if (mode == Mode.Revert) revert("registry down");
        if (mode == Mode.BurnGas) {
            while (true) {}
        }
        if (mode == Mode.Expensive) {
            for (uint256 i = 0; i < 6; i++) {
                sink[uint256(keccak256(abi.encode(calls, i)))] = i + 1;
            }
        }
        calls++;
        lastAgentId = agentId;
        lastValue = value;
        lastTag2 = tag2;
        lastClient = msg.sender;
    }
}

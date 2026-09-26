// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Stands in for the ERC-8004 Identity Registry in unit tests: only `getAgentWallet`, which admission
///      reads. The real registry is exercised by the fork tests.
contract MockIdentity {
    mapping(uint256 agentId => address) public getAgentWallet;

    function setAgentWallet(uint256 agentId, address wallet) external {
        getAgentWallet[agentId] = wallet;
    }
}

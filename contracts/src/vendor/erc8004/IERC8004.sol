// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// The subset of ERC-8004 we call, taken from https://github.com/erc-8004/erc-8004-contracts at
// commit b9e466c250744a7e06b13dff9d3c2844ed64f825 (2026-08-15) and verified against the Monad testnet
// deployments on 2026-09-25 (see contracts/abi/erc8004 and docs/erc-8004.md).

/// @dev Identity Registry: an ERC-721 whose token id is the agent id.
interface IERC8004Identity {
    function register() external returns (uint256 agentId);
    function register(string memory agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

/// @dev Reputation Registry: feedback keyed by (agentId, msg.sender, index). The caller is the client;
///      the agent's owner and operators are refused ("Self-feedback not allowed").
interface IERC8004Reputation {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);
    function getIdentityRegistry() external view returns (address);
}

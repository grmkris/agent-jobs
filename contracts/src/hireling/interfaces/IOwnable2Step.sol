// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IOwnable2Step
/// @notice The ownership surface every owned v1 contract gets from OpenZeppelin's `Ownable2Step` (owner: the Safe).
///         Not inherited by the implementations (OpenZeppelin provides it); `scripts/gen-abi.ts` merges it into the
///         provisional ABIs generated from the interfaces so the admin UI can be built before the implementations.
interface IOwnable2Step {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
    function renounceOwnership() external;
}

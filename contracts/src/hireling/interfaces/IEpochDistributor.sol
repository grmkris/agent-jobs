// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFactory} from "./IFactory.sol";
import {IStakeVault} from "./IStakeVault.sol";

/// @title IEpochDistributor
/// @notice Pays work-mining rewards (ADR-0011). After an epoch ends, the owner (the Safe) posts its Merkle root, the
///         total, and the hash of the published epoch data; the root must be backed by FACTORY already here and not
///         promised to an earlier root. Anyone may then claim for any account: the reward is staked straight into the
///         vault for that account (`IStakeVault.delegateFor`), never sent to a wallet.
///
///         Leaves use OpenZeppelin's double hash, `keccak256(bytes.concat(keccak256(abi.encode(epoch, account,
///         amount))))` (`StandardMerkleTree` with types `["uint256", "address", "uint256"]`). A root can be replaced
///         only while nothing has been claimed from it, so a wrong root can be corrected before it pays out.
///
///         The epoch boundaries are the same as `IMiningReserve`'s (same `genesis` and immutable epoch lengths).
///
///         The implementation is `Ownable2Step`; the ownership functions come from OpenZeppelin.
interface IEpochDistributor {
    struct EpochRoot {
        bytes32 root;
        /// @dev Sum of every leaf's amount.
        uint256 total;
        /// @dev Claimed so far.
        uint256 claimed;
        /// @dev keccak256 of the published epoch data (inputs, prices, leaves) so anyone can recompute the root.
        bytes32 dataHash;
    }

    event RootSet(uint256 indexed epoch, bytes32 root, uint256 total, bytes32 dataHash);
    event Claimed(uint256 indexed epoch, address indexed account, uint256 amount);
    event RootResized(uint256 indexed epoch, uint256 oldTotal, uint256 newTotal);

    error ZeroAddress();
    /// @dev Genesis must be given explicitly and be the same for the reserve and the distributor.
    error ZeroGenesis();
    error ZeroRoot();
    error BeforeGenesis();
    error EpochNotEnded(uint256 epoch, uint256 endsAt);
    error InsufficientFunds(uint256 available, uint256 required);
    /// @dev Something was already claimed from this epoch's root, so it can no longer be replaced.
    error RootLocked(uint256 epoch);
    error NoRoot(uint256 epoch);
    error AlreadyClaimed(uint256 epoch, address account);
    error InvalidProof();

    /// @notice Owner only. Posts `epoch`'s root after the epoch ended. `total` must be covered by `available()` (plus
    ///         the old total when a root that nothing was claimed from is replaced).
    function setRoot(uint256 epoch, bytes32 root, uint256 total, bytes32 dataHash) external;

    /// @notice Owner only. Corrects a posted root's `total` without touching its leaves (C9 MATH-5): never below what
    ///         was already claimed, and an increase only from funds no root has been promised. Releases what a root
    ///         over-promised (e.g. pro-rata rounding left its leaves short of the total) once claims have locked it.
    function resizeRoot(uint256 epoch, uint256 newTotal) external;

    /// @notice Anyone. Verifies `account`'s leaf for `epoch` and stakes `amount` for it in the vault. Once per account
    ///         and epoch.
    function claim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) external;

    function rootOf(uint256 epoch) external view returns (EpochRoot memory);
    function isClaimed(uint256 epoch, address account) external view returns (bool);

    /// @notice FACTORY promised to posted roots and not yet claimed.
    function outstanding() external view returns (uint256);

    /// @notice FACTORY here and not promised to any root: what the next root can use.
    function available() external view returns (uint256);

    /// @notice The leaf for (`epoch`, `account`, `amount`).
    function leaf(uint256 epoch, address account, uint256 amount) external pure returns (bytes32);

    function factory() external view returns (IFactory);
    function vault() external view returns (IStakeVault);
    function EPOCH_ZERO_DURATION() external view returns (uint48);
    function EPOCH_DURATION() external view returns (uint48);
    function genesis() external view returns (uint48);
    function epochEnd(uint256 epoch) external view returns (uint256);
}

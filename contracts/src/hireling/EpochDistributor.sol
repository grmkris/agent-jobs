// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IStakeVault} from "./interfaces/IStakeVault.sol";
import {IEpochDistributor} from "./interfaces/IEpochDistributor.sol";
import {MiningSchedule} from "./MiningSchedule.sol";

/// @title EpochDistributor
/// @notice Pays work mining as stake (ADR-0011; the full contract is in `IEpochDistributor`). Each root is backed by
///         FACTORY already here and not promised to another root, and pays out at most its own total, so a wrong root
///         can cost at most what was funded for it; until its first claim it can be replaced. Claims are permissionless
///         and always stake for the leaf's account.
contract EpochDistributor is IEpochDistributor, Ownable2Step, ReentrancyGuardTransient {
    IFactory public immutable factory;
    IStakeVault public immutable vault;
    uint48 public immutable genesis;
    uint256 public outstanding;

    mapping(uint256 epoch => EpochRoot) internal _roots;
    mapping(uint256 epoch => mapping(address account => bool)) public isClaimed;

    /// @param genesis_ Explicit, and equal to the reserve's (the recipe passes one value to both).
    constructor(IFactory factory_, IStakeVault vault_, uint48 genesis_) Ownable(msg.sender) {
        if (address(factory_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        if (genesis_ == 0) revert ZeroGenesis();
        factory = factory_;
        vault = vault_;
        genesis = genesis_;
        // The vault is immutable and pulls only inside `stakeFor`, which only `claim` calls.
        SafeERC20.forceApprove(factory_, address(vault_), type(uint256).max);
    }

    function setRoot(uint256 epoch, bytes32 root, uint256 total, bytes32 dataHash) external onlyOwner {
        if (root == bytes32(0)) revert ZeroRoot();
        uint256 end = MiningSchedule.epochEnd(genesis, epoch);
        if (block.timestamp < end) revert EpochNotEnded(epoch, end);
        EpochRoot storage r = _roots[epoch];
        if (r.claimed != 0) revert RootLocked(epoch);
        uint256 promised = outstanding - r.total;
        uint256 balance = factory.balanceOf(address(this));
        uint256 free = balance > promised ? balance - promised : 0;
        if (total > free) revert InsufficientFunds(free, total);
        outstanding = promised + total;
        r.root = root;
        r.total = total;
        r.dataHash = dataHash;
        emit RootSet(epoch, root, total, dataHash);
    }

    function claim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        EpochRoot storage r = _roots[epoch];
        if (r.root == bytes32(0)) revert NoRoot(epoch);
        if (isClaimed[epoch][account]) revert AlreadyClaimed(epoch, account);
        if (!MerkleProof.verifyCalldata(proof, r.root, leaf(epoch, account, amount))) revert InvalidProof();
        // A root whose leaves sum past its total pays out at most the total.
        uint256 left = r.total - r.claimed;
        if (amount > left) revert InsufficientFunds(left, amount);
        isClaimed[epoch][account] = true;
        r.claimed += amount;
        outstanding -= amount;
        vault.stakeFor(account, amount);
        emit Claimed(epoch, account, amount);
    }

    function rootOf(uint256 epoch) external view returns (EpochRoot memory) {
        return _roots[epoch];
    }

    function available() external view returns (uint256) {
        uint256 balance = factory.balanceOf(address(this));
        return balance > outstanding ? balance - outstanding : 0;
    }

    function leaf(uint256 epoch, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(epoch, account, amount))));
    }

    function epochEnd(uint256 epoch) external view returns (uint256) {
        return MiningSchedule.epochEnd(genesis, epoch);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {JobPool} from "./JobPool.sol";

/// @title JobPoolFactory
/// @notice Clones `JobPool` at an address anyone can predict from the creator and a salt, pulls the Holding's
///         SIDE hold from the creator into the pool (so the pool may publish), and initialises it. Permissionless.
contract JobPoolFactory {
    using SafeERC20 for IERC20;

    JobPool public immutable implementation;
    address[] public allPools;

    event PoolCreated(
        address indexed pool,
        address indexed creator,
        address indexed curator,
        address token,
        uint256 goal,
        uint48 pledgeDeadline,
        address holding,
        bytes32 policyHash
    );

    constructor() {
        implementation = new JobPool();
    }

    /// @notice The address `create(userSalt, …)` from `creator` will produce.
    function predict(address creator, bytes32 userSalt) public view returns (address) {
        return Clones.predictDeterministicAddress(address(implementation), _salt(creator, userSalt), address(this));
    }

    /// @notice Creates the pool. The creator must hold `holding.minHoldToPublish()` SIDE and have approved it to
    ///         this factory; it moves into the pool and returns to the creator (or `holdProvider`) via `reclaimHold`.
    function create(bytes32 userSalt, JobPool.Params calldata p) external returns (address pool) {
        pool = Clones.cloneDeterministic(address(implementation), _salt(msg.sender, userSalt));
        uint256 hold = p.holding.minHoldToPublish();
        if (hold > 0) p.holding.factory().safeTransferFrom(msg.sender, pool, hold);
        JobPool(pool).initialize(msg.sender, p, hold);
        allPools.push(pool);
        emit PoolCreated(
            pool, msg.sender, p.curator, address(p.token), p.goal, p.pledgeDeadline, address(p.holding), p.publish.policyHash
        );
    }

    function poolCount() external view returns (uint256) {
        return allPools.length;
    }

    function _salt(address creator, bytes32 userSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, userSalt));
    }
}

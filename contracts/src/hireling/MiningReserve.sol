// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFactory} from "./interfaces/IFactory.sol";
import {IMiningReserve} from "./interfaces/IMiningReserve.sol";
import {HirelingConstants} from "./interfaces/HirelingConstants.sol";
import {MiningSchedule} from "./MiningSchedule.sol";
import {HirelingClocks} from "./HirelingClocks.sol";

/// @title MiningReserve
/// @notice Holds the 500M FACTORY mining allocation and funds the distributor one ended epoch at a time, never past
///         the cumulative schedule (ADR-0011; the full contract is in `IMiningReserve`). Unspent budget rolls over. The
///         owner (the Safe) can do nothing else with the reserve.
contract MiningReserve is IMiningReserve, Ownable2Step {
    using SafeERC20 for IFactory;

    uint256 public constant WEEKLY_BUDGET = HirelingConstants.WEEKLY_BUDGET;
    uint48 public immutable EPOCH_ZERO_DURATION;
    uint48 public immutable EPOCH_DURATION;
    uint256 public constant HALVING_EPOCHS = HirelingConstants.HALVING_EPOCHS;

    IFactory public immutable factory;
    address public immutable distributor;
    uint48 public immutable genesis;
    uint256 public totalFunded;

    /// @param genesis_ When epoch 0 starts: explicit, and the distributor's own `genesis` (the recipe passes one value
    ///        to both), so the two contracts can never disagree on an epoch boundary.
    constructor(IFactory factory_, address distributor_, uint48 genesis_, HirelingClocks.Config memory clocks)
        Ownable(msg.sender)
    {
        if (address(factory_) == address(0) || distributor_ == address(0)) revert ZeroAddress();
        if (genesis_ == 0) revert ZeroGenesis();
        HirelingClocks.validate(clocks);
        EPOCH_ZERO_DURATION = clocks.epochZeroDuration;
        EPOCH_DURATION = clocks.epochDuration;
        factory = factory_;
        distributor = distributor_;
        genesis = genesis_;
    }

    function fund(uint256 epoch, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        uint256 end = MiningSchedule.epochEnd(genesis, epoch, EPOCH_ZERO_DURATION, EPOCH_DURATION);
        if (block.timestamp < end) revert EpochNotEnded(epoch, end);
        uint256 cap = MiningSchedule.cumulativeBudget(epoch);
        uint256 available = cap > totalFunded ? cap - totalFunded : 0;
        if (amount > available) revert ExceedsBudget(amount, available);
        uint256 total = totalFunded + amount;
        totalFunded = total;
        factory.safeTransfer(distributor, amount);
        emit EpochFunded(epoch, amount, total);
    }

    function currentEpoch() external view returns (uint256) {
        if (block.timestamp < genesis) revert BeforeGenesis();
        return MiningSchedule.epochAt(genesis, block.timestamp, EPOCH_ZERO_DURATION, EPOCH_DURATION);
    }

    function epochStart(uint256 epoch) external view returns (uint256) {
        return MiningSchedule.epochStart(genesis, epoch, EPOCH_ZERO_DURATION, EPOCH_DURATION);
    }

    function epochEnd(uint256 epoch) external view returns (uint256) {
        return MiningSchedule.epochEnd(genesis, epoch, EPOCH_ZERO_DURATION, EPOCH_DURATION);
    }

    function budget(uint256 epoch) external pure returns (uint256) {
        return MiningSchedule.budget(epoch);
    }

    function cumulativeBudget(uint256 epoch) external pure returns (uint256) {
        return MiningSchedule.cumulativeBudget(epoch);
    }
}

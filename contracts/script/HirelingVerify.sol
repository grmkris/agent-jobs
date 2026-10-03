// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {HirelingClocks} from "../src/hireling/HirelingClocks.sol";
import {BroadcastPath} from "./BroadcastPath.sol";
import {IFeeSchedule} from "../src/hireling/interfaces/IFeeSchedule.sol";
import {HirelingConstants} from "../src/hireling/interfaces/HirelingConstants.sol";

interface IOwnable2Step {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
}

/// @title HirelingVerify
/// @notice The promotion gate (review C8-001): live readbacks that prove a candidate deployment is complete before
///         `PromoteHireling` records it, and the deploy blocks taken from forge's broadcast receipts.
library HirelingVerify {
    error NotLive(string what);
    error BadBroadcast(string what);

    function _require(bool ok, string memory what) private pure {
        if (!ok) revert NotLive(what);
    }

    /// @notice Every check is against chain state, never against what the script believed it sent.
    function verify(HirelingRecipe.Config memory c, HirelingRecipe.Deployed memory d) internal view {
        _require(block.chainid == c.chainId, "chain");
        HirelingClocks.validate(c.clocks);
        _require(address(d.core).code.length != 0, "core code");
        _require(address(d.vesting).code.length != 0, "vesting code");
        _require(address(d.factory).code.length != 0, "factory code");
        _require(address(d.fees).code.length != 0, "feeSchedule code");
        _require(address(d.vault).code.length != 0, "vault code");
        _require(address(d.holding).code.length != 0, "holding code");
        _require(address(d.evaluator).code.length != 0, "evaluator code");
        _require(address(d.distributor).code.length != 0, "distributor code");
        _require(address(d.reserve).code.length != 0, "miningReserve code");
        _require(c.safe.code.length != 0, "safe code");

        // Core: the configured one, charging nothing; a fresh core's admin roles held by the Safe alone.
        _require(d.coreDeployed != c.reuseCore, "core reuse");
        if (!d.coreDeployed) _require(address(d.core) == c.existingCore, "reused core");
        _require(d.core.platformFeeBP() == 0 && d.core.evaluatorFeeBP() == 0, "core fees");
        if (d.coreDeployed) {
            _require(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.safe), "core admin role: safe");
            _require(d.core.hasRole(d.core.ADMIN_ROLE(), c.safe), "core pause role: safe");
            _require(!d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.admin), "core admin role: deployer");
            _require(!d.core.hasRole(d.core.ADMIN_ROLE(), c.admin), "core pause role: deployer");
        }

        // Wiring.
        _require(address(d.holding.core()) == address(d.core), "holding.core");
        _require(address(d.holding.vault()) == address(d.vault), "holding.vault");
        _require(address(d.holding.feeSchedule()) == address(d.fees), "holding.feeSchedule");
        _require(address(d.holding.identity()) == address(c.identity), "holding.identity");
        _require(d.holding.evaluator() == address(d.evaluator), "holding.evaluator");
        _require(d.holding.defaultArbitrator() == c.defaultArbitrator, "holding.defaultArbitrator");
        _require(d.holding.margin() == c.margin, "holding.margin");
        _require(address(d.evaluator.core()) == address(d.core), "evaluator.core");
        _require(address(d.evaluator.holding()) == address(d.holding), "evaluator.holding");
        _require(address(d.evaluator.reputation()) == address(c.reputation), "evaluator.reputation");
        _require(d.evaluator.verifiers(c.attester), "evaluator verifier");
        _require(address(d.vault.factory()) == address(d.factory), "vault.factory");
        _require(d.vault.bootstrapped() && d.vault.isHolding(address(d.holding)), "vault bootstrap");
        (address pendingHolding,) = d.vault.pendingHolding();
        _require(pendingHolding == address(0), "vault pending holding");
        _require(address(d.distributor.vault()) == address(d.vault), "distributor.vault");
        _require(address(d.distributor.factory()) == address(d.factory), "distributor.factory");
        _require(address(d.reserve.factory()) == address(d.factory), "miningReserve.factory");
        _require(d.reserve.distributor() == address(d.distributor), "miningReserve.distributor");

        // D24: promotion must prove the immutable clocks from live reads.
        _require(d.holding.MIN_REVIEW_WINDOW() == c.clocks.minReviewWindow, "holding.MIN_REVIEW_WINDOW");
        _require(d.holding.MIN_DISPUTE_WINDOW() == c.clocks.minDisputeWindow, "holding.MIN_DISPUTE_WINDOW");
        _require(d.holding.MIN_ARBITRATION_WINDOW() == c.clocks.minArbitrationWindow, "holding.MIN_ARBITRATION_WINDOW");
        _require(d.vault.UNSTAKE_DELAY() == c.clocks.unstakeDelay, "vault.UNSTAKE_DELAY");
        _require(d.vault.HOLDING_DELAY() == c.clocks.holdingDelay, "vault.HOLDING_DELAY");
        _require(d.vault.PROPOSAL_GRACE() == c.clocks.proposalGrace, "vault.PROPOSAL_GRACE");
        _require(d.fees.DELAY() == c.clocks.feeDelay, "fees.DELAY");
        _require(d.fees.PROPOSAL_GRACE() == c.clocks.proposalGrace, "fees.PROPOSAL_GRACE");
        _require(d.reserve.EPOCH_ZERO_DURATION() == c.clocks.epochZeroDuration, "reserve.EPOCH_ZERO_DURATION");
        _require(d.reserve.EPOCH_DURATION() == c.clocks.epochDuration, "reserve.EPOCH_DURATION");
        _require(d.distributor.EPOCH_ZERO_DURATION() == c.clocks.epochZeroDuration, "distributor.EPOCH_ZERO_DURATION");
        _require(d.distributor.EPOCH_DURATION() == c.clocks.epochDuration, "distributor.EPOCH_DURATION");

        // Fee schedule: the configured one, nothing queued.
        IFeeSchedule.Schedule memory s = d.fees.schedule();
        for (uint256 i; i < 4; ++i) {
            _require(s.thresholds[i] == c.thresholds[i] * 1e18 && s.bps[i] == c.bps[i], "fee schedule");
        }
        _require(s.treasury == c.feeTreasury, "fee treasury");
        (, uint48 feeEta) = d.fees.pending();
        _require(feeEta == 0, "fee schedule pending");

        // FACTORY and mining: the whole supply, the untouched reserve, one genesis, nothing promised yet.
        // The genesis supply is proven from the Factory's creation receipt (`blocks`), not from live `totalSupply`,
        // which any holder can lower with `burn` (review C8-002).
        // Lower bounds for balances anyone can donate to (review C8-002): dust must not block promotion. The exact
        // allocation is already proven by the run's successful receipts and the fixed, immutable supply.
        _require(d.factory.balanceOf(address(d.reserve)) >= HirelingConstants.MINING_RESERVE, "reserve balance");
        _require(d.reserve.totalFunded() == 0 && d.distributor.outstanding() == 0, "mining untouched");
        _require(d.reserve.genesis() == d.t0 && d.distributor.genesis() == d.t0, "mining genesis");
        if (c.genesis != 0) _require(d.t0 == c.genesis, "configured genesis");
        _require(d.vesting.owner() == c.vestingBeneficiary, "vesting beneficiary");
        _require(d.vesting.start() == uint256(d.t0) + c.vestingStartOffset, "vesting start");
        _require(d.vesting.duration() == c.vestingDuration, "vesting duration");
        _require(
            d.factory.balanceOf(address(d.vesting)) + d.vesting.released(address(d.factory))
                >= HirelingRecipe.TEAM_SHARE,
            "vesting allocation"
        );

        // Ownership: the Safe owns, or the handover to it is pending (the deployer still owns).
        _owned(address(d.vault), c, "vault owner");
        _owned(address(d.fees), c, "feeSchedule owner");
        _owned(address(d.holding), c, "holding owner");
        _owned(address(d.evaluator), c, "evaluator owner");
        _owned(address(d.distributor), c, "distributor owner");
        _owned(address(d.reserve), c, "miningReserve owner");
    }

    function _owned(address target, HirelingRecipe.Config memory c, string memory what) private view {
        address owner = IOwnable2Step(target).owner();
        address pending = IOwnable2Step(target).pendingOwner();
        _require(owner == c.safe || (owner == c.admin && pending == c.safe), what);
    }

    /// @notice Forge's broadcast log for the deploy: `<broadcast>/DeployHireling.s.sol/<chainId>/run-latest.json`.
    function runPath(Vm vm, uint256 chainId) internal view returns (string memory) {
        return string.concat(BroadcastPath.root(vm), "/DeployHireling.s.sol/", vm.toString(chainId), "/run-latest.json");
    }

    /// @notice Deploy blocks from the receipts, after checking the log is complete: every transaction has a successful
    ///         receipt, every candidate contract was created by one of them, and the Factory's creation receipt mints
    ///         exactly the 1e9 supply (review C8-002; FACTORY has no mint after its constructor). `hirelingBlock` is the
    ///         first block of the run; `coreBlock` is the core proxy's block (zero when the core was reused).
    function blocks(Vm vm, string memory path, HirelingRecipe.Deployed memory d)
        internal
        view
        returns (uint256 coreBlock, uint256 hirelingBlock)
    {
        string memory json = vm.readFile(path);
        if (vm.keyExistsJson(json, ".pending[0]")) revert BadBroadcast("pending transactions");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".transactions[", vm.toString(n), "]"))) ++n;
        if (n == 0) revert BadBroadcast("no transactions");

        address[] memory created = new address[](n);
        uint256[] memory blockOf = new uint256[](n);
        uint256[] memory receiptOf = new uint256[](n);
        hirelingBlock = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            string memory t = string.concat(".transactions[", vm.toString(i), "]");
            bytes32 hash = vm.parseJsonBytes32(json, string.concat(t, ".hash"));
            (bool found, uint256 blockNumber, uint256 r) = _receipt(vm, json, hash);
            if (!found) revert BadBroadcast("transaction without a successful receipt");
            blockOf[i] = blockNumber;
            receiptOf[i] = r;
            if (blockNumber < hirelingBlock) hirelingBlock = blockNumber;
            if (_eq(vm.parseJsonString(json, string.concat(t, ".transactionType")), "CREATE")) {
                created[i] = vm.parseJsonAddress(json, string.concat(t, ".contractAddress"));
            }
        }
        address[8] memory expected = [
            address(d.vesting),
            address(d.factory),
            address(d.fees),
            address(d.vault),
            address(d.holding),
            address(d.evaluator),
            address(d.distributor),
            address(d.reserve)
        ];
        for (uint256 k; k < expected.length; ++k) {
            if (!_contains(created, expected[k])) revert BadBroadcast("candidate contract not created by this run");
        }
        if (d.coreDeployed) {
            for (uint256 i; i < n; ++i) {
                if (created[i] == address(d.core)) coreBlock = blockOf[i];
            }
            if (coreBlock == 0) revert BadBroadcast("core proxy not created by this run");
        }
        for (uint256 i; i < n; ++i) {
            if (created[i] == address(d.factory)) {
                if (_minted(vm, json, receiptOf[i], address(d.factory)) != HirelingConstants.FACTORY_SUPPLY) {
                    revert BadBroadcast("factory genesis is not the 1e9 supply");
                }
            }
        }
    }

    function _receipt(Vm vm, string memory json, bytes32 hash)
        private
        view
        returns (bool found, uint256 blockNumber, uint256 index)
    {
        for (uint256 j;; ++j) {
            string memory r = string.concat(".receipts[", vm.toString(j), "]");
            if (!vm.keyExistsJson(json, r)) return (false, 0, 0);
            if (vm.parseJsonBytes32(json, string.concat(r, ".transactionHash")) != hash) continue;
            if (vm.parseJsonUint(json, string.concat(r, ".status")) != 1) return (false, 0, 0);
            return (true, vm.parseJsonUint(json, string.concat(r, ".blockNumber")), j);
        }
    }

    /// @dev The sum of `Transfer(0, …)` events `token` emitted in receipt `r`.
    function _minted(Vm vm, string memory json, uint256 r, address token) private view returns (uint256 total) {
        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        string memory base = string.concat(".receipts[", vm.toString(r), "].logs[");
        for (uint256 k;; ++k) {
            string memory l = string.concat(base, vm.toString(k), "]");
            if (!vm.keyExistsJson(json, l)) return total;
            if (vm.parseJsonAddress(json, string.concat(l, ".address")) != token) continue;
            bytes32[] memory topics = vm.parseJsonBytes32Array(json, string.concat(l, ".topics"));
            if (topics.length != 3 || topics[0] != transferTopic || topics[1] != bytes32(0)) continue;
            total += abi.decode(vm.parseJsonBytes(json, string.concat(l, ".data")), (uint256));
        }
    }

    function _contains(address[] memory list, address a) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == a) return true;
        }
        return false;
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}

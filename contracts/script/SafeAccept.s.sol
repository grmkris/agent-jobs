// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";

/// @dev The Safe (v1.4.1) functions the handover needs. `operation` 0 is a call.
interface ISafe {
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);
    function isOwner(address owner) external view returns (bool);
    function getThreshold() external view returns (uint256);
    function nonce() external view returns (uint256);
}

interface IOwnable2StepTarget {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function acceptOwnership() external;
}

/// @title HirelingSafeAccept
/// @notice Step 3 of the deploy (C10): the Safe accepts ownership of the six owned v1 contracts (vault, fee schedule,
///         Holding, evaluator, distributor, mining reserve), one `execTransaction` each, signed with a pre-validated
///         owner signature: `r` = the owner's address, `s` = 0, `v` = 1, which the Safe accepts because that owner is
///         the transaction's sender. Only for a threshold-1 Safe; a higher threshold needs collected signatures.
library HirelingSafeAccept {
    error NotSafeOwner(address account);
    error ThresholdNotOne(uint256 threshold);
    error NotPending(address target, address pendingOwner);
    error SafeTxFailed(address target);
    error NotOwned(address target, address owner);

    /// @notice The Safe and the six targets from the promoted record in `config/<network>.json`.
    function targets(Vm vm, string memory json) internal pure returns (address safe, address[6] memory t) {
        safe = vm.parseJsonAddress(json, ".deployment.hireling.safe");
        t[0] = vm.parseJsonAddress(json, ".deployment.hireling.vault");
        t[1] = vm.parseJsonAddress(json, ".deployment.hireling.feeSchedule");
        t[2] = vm.parseJsonAddress(json, ".deployment.main.holding");
        t[3] = vm.parseJsonAddress(json, ".deployment.main.evaluator");
        t[4] = vm.parseJsonAddress(json, ".deployment.hireling.distributor");
        t[5] = vm.parseJsonAddress(json, ".deployment.hireling.miningReserve");
    }

    /// @notice Accepts every handover still pending, as `sender` (who must be one of the Safe's owners and the one
    ///         sending these transactions). Contracts the Safe already owns are skipped, so it is safe to run again.
    function accept(ISafe safe, address[6] memory t, address sender) internal returns (uint256 accepted) {
        if (!safe.isOwner(sender)) revert NotSafeOwner(sender);
        uint256 threshold = safe.getThreshold();
        if (threshold != 1) revert ThresholdNotOne(threshold);
        bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(sender))), bytes32(0), uint8(1));
        bytes memory data = abi.encodeCall(IOwnable2StepTarget.acceptOwnership, ());
        for (uint256 i; i < 6; ++i) {
            IOwnable2StepTarget target = IOwnable2StepTarget(t[i]);
            if (target.owner() == address(safe)) continue;
            address pending = target.pendingOwner();
            if (pending != address(safe)) revert NotPending(t[i], pending);
            // safeTxGas and gasPrice 0: a failing inner call reverts the whole execTransaction (GS013).
            bool ok = safe.execTransaction(t[i], 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signature);
            if (!ok) revert SafeTxFailed(t[i]);
            ++accepted;
        }
    }

    /// @notice Reverts unless the Safe owns all six.
    function verify(address safe, address[6] memory t) internal view {
        for (uint256 i; i < 6; ++i) {
            address owner = IOwnable2StepTarget(t[i]).owner();
            if (owner != safe) revert NotOwned(t[i], owner);
        }
    }
}

/// @notice Run by the coordinator after `PromoteHireling`, with a Safe owner's key (testnet: the backup owner):
///
///         NETWORK=monad-testnet forge script script/SafeAccept.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $SAFE_BACKUP_TESTNET_PRIVATE_KEY --broadcast
///
///         Without `--broadcast` it is a dry run. `--sig "check()"` only reads back the six owners. Chain 143 also
///         needs MAINNET_GO=yes. Sends up to six transactions, from the owner, to the Safe.
contract SafeAccept is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory json = vm.readFile(HirelingRecipe.path(vm, network));
        HirelingRecipe.guardChain(vm, json, true);
        (address safe, address[6] memory t) = HirelingSafeAccept.targets(vm, json);
        vm.startBroadcast();
        uint256 accepted = HirelingSafeAccept.accept(ISafe(safe), t, msg.sender);
        vm.stopBroadcast();
        HirelingSafeAccept.verify(safe, t);
        console2.log("acceptOwnership sent through the Safe:", accepted);
        console2.log("owner() == safe on all six:", safe);
    }

    function check() external view {
        string memory json = vm.readFile(HirelingRecipe.path(vm, vm.envString("NETWORK")));
        HirelingRecipe.guardChain(vm, json, false);
        (address safe, address[6] memory t) = HirelingSafeAccept.targets(vm, json);
        HirelingSafeAccept.verify(safe, t);
        console2.log("owner() == safe on all six:", safe);
    }
}

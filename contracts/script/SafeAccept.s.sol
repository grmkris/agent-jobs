// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {HirelingSafeAccept, ISafe} from "./HirelingSafeAccept.sol";

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

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {JobPoolFactory} from "../src/JobPoolFactory.sol";
import {Recipe} from "./Recipe.sol";

/// @notice Deploys `JobPoolFactory` (which deploys the `JobPool` implementation) and records it as
///         `.deployment.poolFactory` in the network's config. The factory is permissionless and unowned; any
///         Holding of the deployment may be named by a pool. Rerunnable only after removing the key.
///
///         NETWORK=monad-testnet forge script script/DeployPoolFactory.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify
contract DeployPoolFactory is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        Recipe.Config memory c = Recipe.load(vm, network);
        string memory json = vm.readFile(Recipe.path(vm, network));
        require(!vm.keyExistsJson(json, ".deployment.poolFactory"), "pool factory already deployed");

        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        JobPoolFactory f = new JobPoolFactory();
        vm.stopBroadcast();

        console2.log("JobPoolFactory", address(f));
        console2.log("JobPool implementation", address(f.implementation()));
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(vm.toString(address(f)), Recipe.path(vm, network), ".deployment.poolFactory");
            console2.log("wrote .deployment.poolFactory");
        } else {
            console2.log("dry run: config not written");
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Recipe} from "./Recipe.sol";

/// @notice Broadcasts the recipe for one network and writes the addresses into `config/<network>.json`
///         (".deployment"). Run deliberately, never as a cached task:
///
///         NETWORK=monad-testnet forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
///         Mainnet (chain 143) additionally requires MAINNET_GO=yes, set only on Kris's explicit go.
contract Deploy is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        Recipe.Config memory c = Recipe.load(vm, network);
        if (c.chainId == Recipe.MAINNET) {
            require(keccak256(bytes(vm.envOr("MAINNET_GO", string("")))) == keccak256("yes"), "mainnet needs MAINNET_GO=yes");
        }
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        Recipe.Deployed memory d = Recipe.deploy(c);
        vm.stopBroadcast();
        // A dry run (no --broadcast) must not record addresses that were never deployed.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _write(network, c, d);
        } else {
            console2.log("dry run: config not written");
        }
    }

    function _write(string memory network, Recipe.Config memory c, Recipe.Deployed memory d) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "block", block.number);
        vm.serializeAddress(o, "core", address(d.core));
        vm.serializeAddress(o, "factory", address(d.factory));
        vm.serializeAddress(o, "rewardTokens", d.rewardTokens);
        for (uint256 i; i < d.holdings.length; ++i) {
            string memory s = c.stackNames[i];
            vm.serializeAddress(s, "holding", address(d.holdings[i]));
            string memory stack = vm.serializeAddress(s, "evaluator", address(d.evaluators[i]));
            vm.serializeString(o, s, stack);
        }
        string memory out = vm.serializeString(o, "network", network);
        vm.writeJson(out, Recipe.path(vm, network), ".deployment");
        console2.log("wrote", Recipe.path(vm, network));
    }
}

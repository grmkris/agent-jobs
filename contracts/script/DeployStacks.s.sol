// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {Recipe} from "./Recipe.sol";

/// @notice Replaces the `JobHolding` + `JobsEvaluator` pairs of an existing deployment with the current code, against
///         the same core, bond token and reward tokens. Jobs already published stay on their old pair (their frozen
///         terms name it); the old pairs are recorded under `.deployment.legacy` as `<stack>-v<n>`, so the board, the
///         indexer and Explore keep serving them. Testnet only; run deliberately, never as a cached task:
///
///         NETWORK=monad-testnet forge script script/DeployStacks.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract DeployStacks is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        Recipe.Config memory c = Recipe.load(vm, network);
        require(c.chainId != Recipe.MAINNET, "stacks-only redeploy is for testnet");
        string memory json = vm.readFile(Recipe.path(vm, network));
        ERC8183WithAuthorization core = ERC8183WithAuthorization(vm.parseJsonAddress(json, ".deployment.core"));
        IERC20 factory = IERC20(vm.parseJsonAddress(json, ".deployment.factory"));
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        (JobHolding[] memory holdings, JobsEvaluator[] memory evaluators) = Recipe.deployStacks(c, core, factory);
        vm.stopBroadcast();
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _write(network, json, c, holdings, evaluators);
        } else {
            for (uint256 i; i < holdings.length; ++i) {
                console2.log(c.stackNames[i], address(holdings[i]), address(evaluators[i]));
            }
            console2.log("dry run: config not written");
        }
    }

    function _pair(string memory key, address holding, address evaluator) internal returns (string memory) {
        vm.serializeAddress(key, "holding", holding);
        return vm.serializeAddress(key, "evaluator", evaluator);
    }

    function _write(
        string memory network,
        string memory json,
        Recipe.Config memory c,
        JobHolding[] memory holdings,
        JobsEvaluator[] memory evaluators
    ) internal {
        // Earlier legacy pairs stay; each current pair becomes `<stack>-v<n>`.
        string memory legacy = "legacy";
        uint256 kept;
        if (vm.keyExistsJson(json, ".deployment.legacy")) {
            string[] memory names = vm.parseJsonKeys(json, ".deployment.legacy");
            kept = names.length;
            for (uint256 i; i < names.length; ++i) {
                string memory at = string.concat(".deployment.legacy.", names[i]);
                string memory pair = _pair(
                    names[i],
                    vm.parseJsonAddress(json, string.concat(at, ".holding")),
                    vm.parseJsonAddress(json, string.concat(at, ".evaluator"))
                );
                legacy = vm.serializeString("legacy", names[i], pair);
            }
        }
        for (uint256 i; i < c.stackNames.length; ++i) {
            string memory s = c.stackNames[i];
            string memory at = string.concat(".deployment.", s);
            string memory name = string.concat(s, "-v", vm.toString(kept / c.stackNames.length + 1));
            string memory pair = _pair(
                name, vm.parseJsonAddress(json, string.concat(at, ".holding")), vm.parseJsonAddress(json, string.concat(at, ".evaluator"))
            );
            legacy = vm.serializeString("legacy", name, pair);
        }

        string memory o = "deployment";
        vm.serializeUint(o, "block", vm.parseJsonUint(json, ".deployment.block"));
        vm.serializeUint(o, "stacksBlock", block.number);
        vm.serializeAddress(o, "core", vm.parseJsonAddress(json, ".deployment.core"));
        vm.serializeAddress(o, "factory", vm.parseJsonAddress(json, ".deployment.factory"));
        vm.serializeAddress(o, "rewardTokens", vm.parseJsonAddressArray(json, ".deployment.rewardTokens"));
        vm.serializeString(o, "legacy", legacy);
        for (uint256 i; i < holdings.length; ++i) {
            vm.serializeString(o, c.stackNames[i], _pair(string.concat("new-", c.stackNames[i]), address(holdings[i]), address(evaluators[i])));
        }
        string memory out = vm.serializeString(o, "network", network);
        vm.writeJson(out, Recipe.path(vm, network), ".deployment");
        console2.log("wrote", Recipe.path(vm, network));
    }
}

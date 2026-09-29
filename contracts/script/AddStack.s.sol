// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {Recipe} from "./Recipe.sol";

/// @notice Adds ONE more `JobHolding` + `JobsEvaluator` pair (a stack with its own windows) to an existing
///         deployment, against the same core and bond token, leaving every other pair untouched: the entry for
///         `STACK` in `.stacks.*` of the config names its windows, and `.deployment.<STACK>` must not exist yet.
///         Tenant boards pick a stack per offer (ADR-0008). Testnet only; run deliberately, never as a cached task:
///
///         NETWORK=monad-testnet STACK=fast forge script script/AddStack.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify
contract AddStack is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory stack = vm.envString("STACK");
        Recipe.Config memory c = Recipe.load(vm, network);
        require(c.chainId != Recipe.MAINNET, "adding a stack this way is for testnet");
        string memory json = vm.readFile(Recipe.path(vm, network));
        require(!vm.keyExistsJson(json, string.concat(".deployment.", stack)), "stack already deployed");

        uint256 index = type(uint256).max;
        for (uint256 i; i < c.stackNames.length; ++i) {
            if (keccak256(bytes(c.stackNames[i])) == keccak256(bytes(stack))) index = i;
        }
        require(index != type(uint256).max, "STACK is not in .stacks.names");

        // A one-element config: the same everything, one window set. `one` aliases `c` in memory, so the windows are
        // read before the arrays are replaced.
        uint256 review = c.reviewWindows[index];
        uint256 dispute = c.disputeWindows[index];
        uint256 arbitration = c.arbitrationWindows[index];
        uint256 margin = c.margins[index];
        Recipe.Config memory one = c;
        one.stackNames = new string[](1);
        one.reviewWindows = new uint256[](1);
        one.disputeWindows = new uint256[](1);
        one.arbitrationWindows = new uint256[](1);
        one.margins = new uint256[](1);
        one.stackNames[0] = stack;
        one.reviewWindows[0] = review;
        one.disputeWindows[0] = dispute;
        one.arbitrationWindows[0] = arbitration;
        one.margins[0] = margin;

        ERC8183WithAuthorization core = ERC8183WithAuthorization(vm.parseJsonAddress(json, ".deployment.core"));
        IERC20 factory = IERC20(vm.parseJsonAddress(json, ".deployment.factory"));
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        (JobHolding[] memory holdings, JobsEvaluator[] memory evaluators) = Recipe.deployStacks(one, core, factory);
        vm.stopBroadcast();

        console2.log(stack, address(holdings[0]), address(evaluators[0]));
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            string memory pair = "pair";
            vm.serializeAddress(pair, "holding", address(holdings[0]));
            string memory out = vm.serializeAddress(pair, "evaluator", address(evaluators[0]));
            vm.writeJson(out, Recipe.path(vm, network), string.concat(".deployment.", stack));
            console2.log("wrote .deployment.", stack);
        } else {
            console2.log("dry run: config not written");
        }
    }
}

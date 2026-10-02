// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {OddTokensRecipe} from "./OddTokensRecipe.sol";

/// @notice NETWORK=monad-testnet forge script script/DeployOddTokens.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///         Refuses chain 143. Afterwards the owner arms them per test: `setBlocked(worker, true)` on bUSD,
///         `setHungry(worker, type(uint256).max)` on gUSD.
contract DeployOddTokens is Script {
    function run() external {
        string memory json = vm.readFile(HirelingRecipe.path(vm, vm.envString("NETWORK")));
        HirelingRecipe.guardChain(vm, json, true);
        (address[] memory wallets, uint256 amount) = OddTokensRecipe.load(vm, json);
        vm.startBroadcast();
        OddTokensRecipe.Deployed memory d = OddTokensRecipe.deploy(msg.sender, wallets, amount);
        vm.stopBroadcast();
        console2.log("record under .deployment.oddTokens (block = the deploy receipt's):");
        console2.log("  blocklist", address(d.blocklist));
        console2.log("  gasBurner", address(d.gasBurner));
    }
}

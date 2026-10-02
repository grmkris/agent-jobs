// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {SeedPoolRecipe} from "./SeedPoolRecipe.sol";

/// @notice Run by the coordinator, from the account holding the liquidity allocation and the USDC:
///
///         NETWORK=monad-mainnet MAINNET_GO=yes forge script script/SeedPool.s.sol --rpc-url $MONAD_MAINNET_RPC_URL \
///           --private-key $LIQUIDITY_PRIVATE_KEY --broadcast
///
///         Without `--broadcast` it is a dry run. Rehearsed on a mainnet fork (`test/fork/SeedPoolRehearsal.t.sol`).
contract SeedPool is Script {
    function run() external {
        string memory json = vm.readFile(HirelingRecipe.path(vm, vm.envString("NETWORK")));
        HirelingRecipe.guardChain(vm, json, true);
        SeedPoolRecipe.Config memory c = SeedPoolRecipe.load(vm, json);
        SeedPoolRecipe.check(c);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        vm.startBroadcast();
        uint256 tokenId = SeedPoolRecipe.seed(c, p);
        vm.stopBroadcast();
        SeedPoolRecipe.verify(c, p, tokenId);
        console2.log("pool id");
        console2.logBytes32(p.poolId);
        console2.log("position token id", tokenId);
        console2.log("liquidity", p.liquidity);
    }
}

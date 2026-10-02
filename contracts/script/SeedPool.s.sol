// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {SeedPoolRecipe} from "./SeedPoolRecipe.sol";
import {SeedHelper} from "../src/hireling/SeedHelper.sol";

/// @notice Run by the coordinator, from the account holding the liquidity allocation and the USDC (seed amounts plus
///         the repair cap of each, which come back unless a repair spends them):
///
///         NETWORK=monad-mainnet MAINNET_GO=yes forge script script/SeedPool.s.sol --rpc-url $MONAD_MAINNET_RPC_URL \
///           --private-key $LIQUIDITY_PRIVATE_KEY --broadcast --slow
///
///         Three transactions: deploy the `SeedHelper`, approve it both tokens, `seed()`. Without `--broadcast` it is
///         a dry run (the simulated `Repaired` event shows what a repair would cost). Then, the authoritative check:
///
///         NETWORK=monad-mainnet forge script script/SeedPool.s.sol --sig "verify()" --rpc-url $MONAD_MAINNET_RPC_URL
///
///         It reads the token id from the broadcast's receipts, not from the simulation (review C12-001). Rehearsed on
///         a mainnet fork (`test/fork/SeedPoolRehearsal.t.sol`).
contract SeedPool is Script {
    function run() external {
        (SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p) = _prepare(true);
        SeedPoolRecipe.refusePriorSeed(vm, c, p, SeedPoolRecipe.runPath(vm, block.chainid));
        (uint160 current,,,) = c.stateView.getSlot0(p.poolId);
        console2.log("pool state now (0 = uninitialized; repaired up to the cap if not the target):", current);
        console2.log("target sqrtPriceX96:", p.sqrtPriceX96);
        vm.startBroadcast();
        (SeedHelper helper, uint256 tokenId) = SeedPoolRecipe.seed(c, p);
        vm.stopBroadcast();
        console2.log("helper", address(helper));
        console2.log("simulated token id (not authoritative; run --sig verify() after the broadcast):", tokenId);
    }

    function verify() external view {
        (SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p) = _prepare(false);
        VmSafe.Log[] memory logs = SeedPoolRecipe.runLogs(vm, SeedPoolRecipe.runPath(vm, block.chainid), true);
        (uint256 tokenId, address helper) = SeedPoolRecipe.fromLogs(c, p, logs);
        SeedPoolRecipe.verifyPosition(c, p, tokenId, helper);
        console2.log("seeded: position token id", tokenId);
        console2.log("owner (the Safe)", c.safe);
        console2.log("liquidity", p.liquidity);
        console2.log("pool id");
        console2.logBytes32(p.poolId);
    }

    function _prepare(bool sends) internal view returns (SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p) {
        string memory json = vm.readFile(HirelingRecipe.path(vm, vm.envString("NETWORK")));
        HirelingRecipe.guardChain(vm, json, sends);
        c = SeedPoolRecipe.load(vm, json);
        SeedPoolRecipe.check(c);
        p = SeedPoolRecipe.plan(c);
    }
}

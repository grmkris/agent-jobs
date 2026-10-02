// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {HirelingOutput} from "./HirelingOutput.sol";
import {HirelingVerify} from "./HirelingVerify.sol";

/// @notice Step 2 of 2 (review C8-001): records a broadcast Hireling v1 deployment in `config/<network>.json`, in the
///         D1/D5 shape, only after proving it on-chain. Sends no transaction; run it without `--broadcast`:
///
///         NETWORK=monad-testnet forge script script/PromoteHireling.s.sol --rpc-url $MONAD_TESTNET_RPC_URL
///
///         It reads the candidate `DeployHireling` wrote and forge's receipts
///         (`broadcast/DeployHireling.s.sol/<chainId>/run-latest.json`), and refuses unless every transaction of the
///         run has a successful receipt and `HirelingVerify.verify` passes against live state: code everywhere,
///         wiring, bootstrap, the untouched 500M reserve, one genesis, the configured fee schedule, every owner the
///         Safe or pending to it, and on a fresh core both admin roles held by the Safe and renounced by the deployer.
///         Block numbers come from the receipts. Running it again after success changes nothing.
contract PromoteHireling is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        HirelingRecipe.guardChain(vm, vm.readFile(HirelingRecipe.path(vm, network)), false);
        HirelingRecipe.Config memory c = HirelingRecipe.load(vm, network);
        (HirelingRecipe.Deployed memory d, address safe, uint256 chainId) =
            HirelingOutput.readCandidate(vm, HirelingOutput.candidatePath(vm, network));
        require(chainId == c.chainId && block.chainid == c.chainId, "candidate is for another chain");
        require(safe == c.safe, "candidate names another Safe");

        string memory path = HirelingRecipe.path(vm, network);
        if (HirelingOutput.isPromoted(vm, vm.readFile(path), d, safe)) {
            console2.log("already promoted; config unchanged:", path);
            return;
        }
        HirelingVerify.verify(c, d);
        (uint256 coreBlock, uint256 hirelingBlock) = HirelingVerify.blocks(vm, HirelingVerify.runPath(vm, chainId), d);
        HirelingOutput.write(vm, path, d, safe, coreBlock, hirelingBlock);
        console2.log("promoted:", path);
        console2.log("hireling.block", hirelingBlock);
    }
}

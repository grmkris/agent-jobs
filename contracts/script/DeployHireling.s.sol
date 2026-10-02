// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {HirelingOutput} from "./HirelingOutput.sol";

/// @notice Step 1 of 2: broadcasts the Hireling v1 recipe for one network. It never touches `config/<network>.json`:
///         forge runs this function locally *before* it broadcasts anything, so whatever it writes is only what it
///         intends to send (review C8-001). It writes that as a candidate, `broadcast/hireling/<network>.candidate.json`
///         (gitignored), and only on a `--broadcast` run. Step 2, `PromoteHireling`, verifies the candidate on-chain
///         and records it. Run deliberately, by the coordinator only:
///
///         NETWORK=monad-testnet forge script script/DeployHireling.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
///
///         If the broadcast stops part way, finish it with the same command plus `--resume` (forge replays the saved
///         sequence; this function does not run again, so the candidate stays the one for that sequence). Mainnet
///         (chain 143) additionally requires MAINNET_GO=yes, set only on Kris's explicit go.
contract DeployHireling is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        HirelingRecipe.Config memory c = HirelingRecipe.load(vm, network);
        if (c.chainId == HirelingRecipe.MAINNET) {
            require(
                keccak256(bytes(vm.envOr("MAINNET_GO", string("")))) == keccak256("yes"), "mainnet needs MAINNET_GO=yes"
            );
        }
        // Refuse before broadcasting anything if the record could not be written afterwards.
        HirelingOutput.preflight(vm, vm.readFile(HirelingRecipe.path(vm, network)));
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        HirelingRecipe.Deployed memory d = HirelingRecipe.deploy(c);
        vm.stopBroadcast();
        // A dry run writes nothing: its addresses were never sent.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory candidate = HirelingOutput.candidatePath(vm, network);
            HirelingOutput.writeCandidate(vm, candidate, c.chainId, d, c.safe);
            console2.log("candidate (not yet verified):", candidate);
            console2.log("after the broadcast completes, run script/PromoteHireling.s.sol");
        } else {
            console2.log("dry run: nothing written");
        }
    }
}

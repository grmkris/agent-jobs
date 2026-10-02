// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {HirelingOutput} from "./HirelingOutput.sol";

/// @notice Broadcasts the Hireling v1 recipe for one network and records it in `config/<network>.json` under
///         `.deployment` in the shape of decisions D1. Run deliberately, by the coordinator only:
///
///         NETWORK=monad-testnet forge script script/DeployHireling.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///
///         Mainnet (chain 143) additionally requires MAINNET_GO=yes, set only on Kris's explicit go. After the
///         broadcast the Safe must `acceptOwnership` on all six owned contracts; until then the deployer stays owner.
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
        string memory path = HirelingRecipe.path(vm, network);
        HirelingOutput.preflight(vm, vm.readFile(path));
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        HirelingRecipe.Deployed memory d = HirelingRecipe.deploy(c);
        vm.stopBroadcast();
        // A dry run (no --broadcast) must not record addresses that were never deployed.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            HirelingOutput.write(vm, path, d, c.safe, block.number);
            console2.log("wrote", path);
        } else {
            console2.log("dry run: config not written");
        }
    }
}

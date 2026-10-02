// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {BlocklistUSD, GasBurnerUSD} from "../src/testnet/OddTokens.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";

/// @title OddTokensRecipe
/// @notice Testnet only (C11). Input, written by the coordinator in `config/<network>.json`:
///
///         "oddTokens": { "wallets": ["0x…", …], "mint": 10000 }   // whole tokens (6 decimals) per wallet
///
///         Output, printed for the coordinator to record (the script writes no config):
///
///         "deployment": { …, "oddTokens": { "blocklist": "0x…", "gasBurner": "0x…", "block": 123 } }
library OddTokensRecipe {
    struct Deployed {
        BlocklistUSD blocklist;
        GasBurnerUSD gasBurner;
    }

    error MainnetRefused();

    function load(Vm vm, string memory json) internal pure returns (address[] memory wallets, uint256 amount) {
        wallets = vm.parseJsonAddressArray(json, ".oddTokens.wallets");
        amount = vm.parseJsonUint(json, ".oddTokens.mint") * 1e6;
    }

    /// @dev Both tokens owned by the deployer (the caller's broadcaster), and `amount` of each minted to every wallet.
    function deploy(address owner, address[] memory wallets, uint256 amount) internal returns (Deployed memory d) {
        if (block.chainid == HirelingRecipe.MAINNET) revert MainnetRefused();
        d.blocklist = new BlocklistUSD(owner);
        d.gasBurner = new GasBurnerUSD(owner);
        for (uint256 i; i < wallets.length; ++i) {
            d.blocklist.mint(wallets[i], amount);
            d.gasBurner.mint(wallets[i], amount);
        }
    }
}

/// @notice NETWORK=monad-testnet forge script script/DeployOddTokens.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///         Refuses chain 143. Afterwards the owner arms them per test: `setBlocked(worker, true)` on bUSD,
///         `setHungry(worker, type(uint256).max)` on gUSD.
contract DeployOddTokens is Script {
    function run() external {
        string memory json = vm.readFile(HirelingRecipe.path(vm, vm.envString("NETWORK")));
        (address[] memory wallets, uint256 amount) = OddTokensRecipe.load(vm, json);
        vm.startBroadcast();
        OddTokensRecipe.Deployed memory d = OddTokensRecipe.deploy(msg.sender, wallets, amount);
        vm.stopBroadcast();
        console2.log("record under .deployment.oddTokens (block = the deploy receipt's):");
        console2.log("  blocklist", address(d.blocklist));
        console2.log("  gasBurner", address(d.gasBurner));
    }
}

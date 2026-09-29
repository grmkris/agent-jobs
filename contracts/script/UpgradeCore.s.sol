// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {Recipe} from "./Recipe.sol";

/// @notice Points the deployed core proxy at a new implementation of the vendored core (UUPS, admin only). The
///         proxy, its jobs and its escrow stay; only the code changes. The implementation must keep the storage
///         layout (ADR-0010's allowlist retirement keeps the slot). Testnet only; run deliberately:
///
///         NETWORK=monad-testnet forge script script/UpgradeCore.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract UpgradeCore is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        Recipe.Config memory c = Recipe.load(vm, network);
        require(c.chainId != Recipe.MAINNET, "core upgrades on mainnet wait for Kris's go");
        ERC8183WithAuthorization core =
            ERC8183WithAuthorization(vm.parseJsonAddress(vm.readFile(Recipe.path(vm, network)), ".deployment.core"));
        uint256 jobs = core.jobCounter();
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        core.upgradeToAndCall(address(impl), "");
        vm.stopBroadcast();
        require(core.jobCounter() == jobs, "storage moved: the job counter changed across the upgrade");
        console2.log("core", address(core));
        console2.log("implementation", address(impl));
        console2.log("jobs", jobs);
    }
}

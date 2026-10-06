// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @dev Promotion tests need a pre-v1 record even after the shipped config has
///      been promoted. Keep the real inputs/core metadata, but replace the
///      deployment with a synthetic legacy main/demo pair and legacy history.
///      No production record is changed and no promoted v1 pair becomes legacy.
library UnpromotedTestnet {
    function write(Vm vm, string memory path, string memory shipped) internal returns (string memory fixture) {
        vm.writeFile(path, shipped);
        string memory object = string.concat("unpromoted:", path);
        vm.serializeJson(object, "{}");
        vm.serializeAddress(object, "core", vm.parseJsonAddress(shipped, ".deployment.core"));
        vm.serializeUint(object, "block", vm.parseJsonUint(shipped, ".deployment.block"));
        vm.serializeString(object, "network", "monad-testnet");
        vm.serializeAddress(object, "factory", address(0x101));
        if (vm.keyExistsJson(shipped, ".deployment.poolFactory")) {
            vm.serializeAddress(object, "poolFactory", vm.parseJsonAddress(shipped, ".deployment.poolFactory"));
        }
        if (vm.keyExistsJson(shipped, ".deployment.stacksBlock")) {
            vm.serializeUint(object, "stacksBlock", vm.parseJsonUint(shipped, ".deployment.stacksBlock"));
        }
        vm.serializeAddress(object, "rewardTokens", vm.parseJsonAddressArray(shipped, ".deployment.rewardTokens"));
        vm.serializeString(
            object,
            "main",
            '{"holding":"0x0000000000000000000000000000000000000201","evaluator":"0x0000000000000000000000000000000000000202","openTokens":true}'
        );
        vm.serializeString(
            object,
            "demo",
            '{"holding":"0x0000000000000000000000000000000000000301","evaluator":"0x0000000000000000000000000000000000000302"}'
        );
        string memory deployment = vm.serializeString(
            object,
            "legacy",
            '{"main-v1":{"holding":"0x0000000000000000000000000000000000000401","evaluator":"0x0000000000000000000000000000000000000402"},"main-v2":{"holding":"0x0000000000000000000000000000000000000501","evaluator":"0x0000000000000000000000000000000000000502"},"demo-v1":{"holding":"0x0000000000000000000000000000000000000601","evaluator":"0x0000000000000000000000000000000000000602"}}'
        );
        vm.writeJson(deployment, path, ".deployment");
        fixture = vm.readFile(path);
        require(!vm.keyExistsJson(fixture, ".deployment.sidequest"), "fixture still promoted");
    }
}

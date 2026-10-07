// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @dev Promotion tests retain the real launch inputs and reward tokens while replacing deployment outputs with a
///      fresh input record. No production record is changed.
library UnpromotedTestnet {
    function write(Vm vm, string memory path, string memory shipped) internal returns (string memory fixture) {
        vm.writeFile(path, shipped);
        string memory object = string.concat("unpromoted:", path);
        vm.serializeJson(object, "{}");
        string memory deployment =
            vm.serializeAddress(object, "rewardTokens", vm.parseJsonAddressArray(shipped, ".deployment.rewardTokens"));
        vm.writeJson(deployment, path, ".deployment");
        fixture = vm.readFile(path);
        require(!vm.keyExistsJson(fixture, ".deployment.sidequest"), "fixture still promoted");
    }
}

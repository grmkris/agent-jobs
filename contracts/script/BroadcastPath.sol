// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Where forge writes this run's broadcast logs: `FOUNDRY_BROADCAST` when set (a fork rehearsal's own
///         `broadcast/rehearsal-<id>`, so it never touches a real launch's logs), else `broadcast`. The scripts that read
///         those logs back (PromoteHireling, SeedPool's verify, the candidate) read them from here.
library BroadcastPath {
    function root(Vm vm) internal view returns (string memory) {
        string memory dir = vm.envOr("FOUNDRY_BROADCAST", string("broadcast"));
        if (bytes(dir).length > 0 && bytes(dir)[0] == "/") return dir;
        return string.concat(vm.projectRoot(), "/", dir);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {Recipe} from "./Recipe.sol";

/// @notice Replaces the `JobHolding` + `JobsEvaluator` pairs of an existing deployment with the current code, against
///         the same core, bond token and reward tokens. Jobs already published stay on their old pair (their frozen
///         terms name it); each replaced pair is recorded under `.deployment.legacy` as `<stack>-v<n>`, so the board,
///         the indexer and Explore keep serving them. `STACKS=main,demo` limits it to those stacks (default: every
///         deployed one; a configured stack never deployed is left for the full recipe); the others keep their
///         entries. New pairs carry `openTokens: true`: their Holding is safe with any ERC-20 (ADR-0010). Testnet
///         only; run deliberately, never as a cached task:
///
///         NETWORK=monad-testnet STACKS=main forge script script/DeployStacks.s.sol --rpc-url $MONAD_TESTNET_RPC_URL \
///           --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract DeployStacks is Script {
    function run() external {
        string memory network = vm.envString("NETWORK");
        Recipe.Config memory all = Recipe.load(vm, network);
        require(all.chainId != Recipe.MAINNET, "stacks-only redeploy is for testnet");
        string memory json = vm.readFile(Recipe.path(vm, network));
        // `_selected` rewrites the arrays of the struct it is given; `all` must stay whole for `_write`.
        Recipe.Config memory c = _selected(Recipe.load(vm, network), json, vm.envOr("STACKS", string("")));
        require(c.stackNames.length > 0, "no deployed stack selected");
        ERC8183WithAuthorization core = ERC8183WithAuthorization(vm.parseJsonAddress(json, ".deployment.core"));
        IERC20 factory = IERC20(vm.parseJsonAddress(json, ".deployment.factory"));
        vm.startBroadcast();
        require(msg.sender == c.admin, "broadcaster must be the configured admin");
        (JobHolding[] memory holdings, JobsEvaluator[] memory evaluators) = Recipe.deployStacks(c, core, factory);
        vm.stopBroadcast();
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _write(network, json, all, c, holdings, evaluators);
        } else {
            for (uint256 i; i < holdings.length; ++i) {
                console2.log(c.stackNames[i], address(holdings[i]), address(evaluators[i]));
            }
            console2.log("dry run: config not written");
        }
    }

    function _deployed(string memory json, string memory stack) internal view returns (bool) {
        return vm.keyExistsJson(json, string.concat(".deployment.", stack));
    }

    function _wanted(string memory list, string memory stack) internal pure returns (bool) {
        if (bytes(list).length == 0) return true;
        return _contains(string.concat(",", list, ","), string.concat(",", stack, ","));
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool same = true;
            for (uint256 j; j < n.length && same; ++j) {
                same = h[i + j] == n[j];
            }
            if (same) return true;
        }
        return false;
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (p.length > a.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (a[i] != p[i]) return false;
        }
        return true;
    }

    /// @dev The configured stacks that are deployed and named in `list` (all deployed ones when `list` is empty).
    function _selected(Recipe.Config memory c, string memory json, string memory list)
        internal
        view
        returns (Recipe.Config memory)
    {
        uint256 n;
        for (uint256 i; i < c.stackNames.length; ++i) {
            if (_deployed(json, c.stackNames[i]) && _wanted(list, c.stackNames[i])) ++n;
        }
        string[] memory names = new string[](n);
        uint256[] memory review = new uint256[](n);
        uint256[] memory dispute = new uint256[](n);
        uint256[] memory arbitration = new uint256[](n);
        uint256[] memory margins = new uint256[](n);
        uint256 j;
        for (uint256 i; i < c.stackNames.length; ++i) {
            if (!_deployed(json, c.stackNames[i]) || !_wanted(list, c.stackNames[i])) continue;
            names[j] = c.stackNames[i];
            review[j] = c.reviewWindows[i];
            dispute[j] = c.disputeWindows[i];
            arbitration[j] = c.arbitrationWindows[i];
            margins[j] = c.margins[i];
            ++j;
        }
        c.stackNames = names;
        c.reviewWindows = review;
        c.disputeWindows = dispute;
        c.arbitrationWindows = arbitration;
        c.margins = margins;
        return c;
    }

    function _pair(string memory key, address holding, address evaluator) internal returns (string memory) {
        vm.serializeAddress(key, "holding", holding);
        return vm.serializeAddress(key, "evaluator", evaluator);
    }

    /// @dev A stack's entry as the config has it, `openTokens` included when set.
    function _copy(string memory json, string memory key, string memory at) internal returns (string memory) {
        vm.serializeAddress(key, "holding", vm.parseJsonAddress(json, string.concat(at, ".holding")));
        if (vm.keyExistsJson(json, string.concat(at, ".openTokens"))) {
            vm.serializeBool(key, "openTokens", vm.parseJsonBool(json, string.concat(at, ".openTokens")));
        }
        return vm.serializeAddress(key, "evaluator", vm.parseJsonAddress(json, string.concat(at, ".evaluator")));
    }

    function _write(
        string memory network,
        string memory json,
        Recipe.Config memory all,
        Recipe.Config memory c,
        JobHolding[] memory holdings,
        JobsEvaluator[] memory evaluators
    ) internal {
        // Earlier legacy pairs stay; each replaced pair becomes `<stack>-v<n>`, n one past that stack's last.
        string memory legacy = "legacy";
        string[] memory old = vm.keyExistsJson(json, ".deployment.legacy") ? vm.parseJsonKeys(json, ".deployment.legacy") : new string[](0);
        for (uint256 i; i < old.length; ++i) {
            legacy = vm.serializeString("legacy", old[i], _copy(json, old[i], string.concat(".deployment.legacy.", old[i])));
        }
        for (uint256 i; i < c.stackNames.length; ++i) {
            string memory s = c.stackNames[i];
            uint256 versions;
            for (uint256 k; k < old.length; ++k) {
                if (_startsWith(old[k], string.concat(s, "-v"))) ++versions;
            }
            string memory name = string.concat(s, "-v", vm.toString(versions + 1));
            legacy = vm.serializeString("legacy", name, _copy(json, name, string.concat(".deployment.", s)));
        }

        string memory o = "deployment";
        vm.serializeUint(o, "block", vm.parseJsonUint(json, ".deployment.block"));
        vm.serializeUint(o, "stacksBlock", block.number);
        vm.serializeAddress(o, "core", vm.parseJsonAddress(json, ".deployment.core"));
        vm.serializeAddress(o, "factory", vm.parseJsonAddress(json, ".deployment.factory"));
        vm.serializeAddress(o, "rewardTokens", vm.parseJsonAddressArray(json, ".deployment.rewardTokens"));
        if (vm.keyExistsJson(json, ".deployment.poolFactory")) {
            vm.serializeAddress(o, "poolFactory", vm.parseJsonAddress(json, ".deployment.poolFactory"));
        }
        vm.serializeString(o, "legacy", legacy);
        // Deployed stacks this run left alone keep their entries.
        for (uint256 i; i < all.stackNames.length; ++i) {
            string memory s = all.stackNames[i];
            if (!_deployed(json, s) || _wanted(_joined(c.stackNames), s)) continue;
            vm.serializeString(o, s, _copy(json, string.concat("kept-", s), string.concat(".deployment.", s)));
        }
        for (uint256 i; i < holdings.length; ++i) {
            string memory key = string.concat("new-", c.stackNames[i]);
            vm.serializeBool(key, "openTokens", true);
            vm.serializeString(o, c.stackNames[i], _pair(key, address(holdings[i]), address(evaluators[i])));
        }
        string memory out = vm.serializeString(o, "network", network);
        vm.writeJson(out, Recipe.path(vm, network), ".deployment");
        console2.log("wrote", Recipe.path(vm, network));
    }

    function _joined(string[] memory names) internal pure returns (string memory list) {
        for (uint256 i; i < names.length; ++i) {
            list = i == 0 ? names[i] : string.concat(list, ",", names[i]);
        }
    }
}

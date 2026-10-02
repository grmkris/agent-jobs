// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {TeamVesting} from "../src/hireling/TeamVesting.sol";
import {Factory} from "../src/hireling/Factory.sol";
import {FeeSchedule} from "../src/hireling/FeeSchedule.sol";
import {StakeVault} from "../src/hireling/StakeVault.sol";
import {HirelingHolding} from "../src/hireling/HirelingHolding.sol";
import {HirelingEvaluator} from "../src/hireling/HirelingEvaluator.sol";
import {EpochDistributor} from "../src/hireling/EpochDistributor.sol";
import {MiningReserve} from "../src/hireling/MiningReserve.sol";

/// @title HirelingOutput
/// @notice Rewrites `.deployment` in a network config after the Hireling v1 deploy has been verified on-chain
///         (`PromoteHireling`), in the shape of decisions D1:
///         `factory` becomes FACTORY v2; `hireling` lists the owner Safe (D5), the protocol contracts and `t0`; `main` is the v1 pair
///         (`kind: "hireling-v1"`); the previous `main` and `demo` move into `legacy` as the next free `main-vN` and
///         `demo-vN`; every legacy pair gets an explicit `kind` and `factory`. Every other key is copied. An unknown key,
///         or a config that already records a v1 deployment, refuses instead of dropping anything. On mainnet
///         (LAUNCH-AUDIT-004) `rewardTokens` is kept or, when absent, derived from the single `knownTokens` entry, and must
///         contain `x402.usdc`: the SDK and Explore read their reward tokens from it.
library HirelingOutput {
    error UnknownKey(string where, string key);
    error AlreadyDeployed();
    /// @dev Mainnet: no `rewardTokens` and not exactly one `knownTokens` entry, or a reward list without `x402.usdc`.
    error MainnetRewardTokens();

    uint256 private constant MAINNET = 143;

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _has(string[] memory keys, string memory key) private pure returns (bool) {
        for (uint256 i; i < keys.length; ++i) {
            if (_eq(keys[i], key)) return true;
        }
        return false;
    }

    function _keys(Vm vm, string memory json, string memory at) private view returns (string[] memory) {
        if (!vm.keyExistsJson(json, at)) return new string[](0);
        return vm.parseJsonKeys(json, at);
    }

    /// @notice Refuses a config this writer could not rewrite faithfully, before anything is broadcast.
    function preflight(Vm vm, string memory json) internal view {
        string[] memory keys = _keys(vm, json, ".deployment");
        string[8] memory known =
            ["block", "core", "network", "factory", "poolFactory", "rewardTokens", "stacksBlock", "legacy"];
        for (uint256 i; i < keys.length; ++i) {
            string memory k = keys[i];
            if (_eq(k, "hireling")) revert AlreadyDeployed();
            if (_eq(k, "main") || _eq(k, "demo")) {
                _checkPair(vm, json, string.concat(".deployment.", k), k);
                continue;
            }
            bool ok;
            for (uint256 j; j < known.length; ++j) {
                if (_eq(k, known[j])) ok = true;
            }
            if (!ok) revert UnknownKey("deployment", k);
        }
        string[] memory legacy = _keys(vm, json, ".deployment.legacy");
        for (uint256 i; i < legacy.length; ++i) {
            _checkPair(vm, json, string.concat(".deployment.legacy.", legacy[i]), legacy[i]);
        }
        if (_mainnet(vm, json)) rewardTokens(vm, json);
    }

    /// @notice The reward tokens the record will carry: `.deployment.rewardTokens` if present, else on mainnet the single
    ///         `knownTokens` entry (USDC). On mainnet the list must contain `x402.usdc`.
    function rewardTokens(Vm vm, string memory json) internal view returns (address[] memory tokens) {
        bool mainnet = _mainnet(vm, json);
        if (vm.keyExistsJson(json, ".deployment.rewardTokens")) {
            tokens = vm.parseJsonAddressArray(json, ".deployment.rewardTokens");
        } else if (mainnet) {
            tokens = vm.parseJsonAddressArray(json, ".knownTokens");
            if (tokens.length != 1) revert MainnetRewardTokens();
        }
        if (!mainnet) return tokens;
        address usdc = vm.parseJsonAddress(json, ".x402.usdc");
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == usdc) return tokens;
        }
        revert MainnetRewardTokens();
    }

    function _mainnet(Vm vm, string memory json) private view returns (bool) {
        return vm.keyExistsJson(json, ".chainId") && vm.parseJsonUint(json, ".chainId") == MAINNET;
    }

    function _checkPair(Vm vm, string memory json, string memory at, string memory name) private pure {
        string[] memory keys = vm.parseJsonKeys(json, at);
        for (uint256 i; i < keys.length; ++i) {
            string memory k = keys[i];
            if (!(_eq(k, "holding") || _eq(k, "evaluator") || _eq(k, "openTokens") || _eq(k, "kind")
                        || _eq(k, "factory"))) {
                revert UnknownKey(name, k);
            }
        }
    }

    /// @notice Writes the D1/D5 record. `coreBlock` is the fresh core's deploy block (ignored for a reused core) and
    ///         `hirelingBlock` the first block of the v1 deploy; `PromoteHireling` takes both from the receipts.
    function write(
        Vm vm,
        string memory path,
        HirelingRecipe.Deployed memory d,
        address safe,
        uint256 coreBlock,
        uint256 hirelingBlock
    ) internal {
        string memory json = vm.readFile(path);
        preflight(vm, json);
        string memory o = "deployment";
        string[] memory keys = _keys(vm, json, ".deployment");

        if (d.coreDeployed) {
            vm.serializeAddress(o, "core", address(d.core));
            vm.serializeUint(o, "block", coreBlock);
        } else {
            vm.serializeAddress(o, "core", vm.parseJsonAddress(json, ".deployment.core"));
            vm.serializeUint(o, "block", vm.parseJsonUint(json, ".deployment.block"));
        }
        if (_has(keys, "poolFactory")) {
            vm.serializeAddress(o, "poolFactory", vm.parseJsonAddress(json, ".deployment.poolFactory"));
        }
        address[] memory rewards = rewardTokens(vm, json);
        if (_has(keys, "rewardTokens") || rewards.length > 0) vm.serializeAddress(o, "rewardTokens", rewards);
        if (_has(keys, "stacksBlock")) {
            vm.serializeUint(o, "stacksBlock", vm.parseJsonUint(json, ".deployment.stacksBlock"));
        }
        address oldFactory = _has(keys, "factory") ? vm.parseJsonAddress(json, ".deployment.factory") : address(0);
        vm.serializeAddress(o, "factory", address(d.factory));

        string memory h = "deployment.hireling";
        vm.serializeUint(h, "block", hirelingBlock);
        vm.serializeAddress(h, "safe", safe);
        vm.serializeAddress(h, "factory", address(d.factory));
        vm.serializeAddress(h, "vault", address(d.vault));
        vm.serializeAddress(h, "feeSchedule", address(d.fees));
        vm.serializeAddress(h, "distributor", address(d.distributor));
        vm.serializeAddress(h, "miningReserve", address(d.reserve));
        vm.serializeAddress(h, "teamVesting", address(d.vesting));
        vm.serializeString(o, "hireling", vm.serializeUint(h, "t0", d.t0));

        string memory m = "deployment.main";
        vm.serializeString(m, "kind", "hireling-v1");
        vm.serializeAddress(m, "factory", address(d.factory));
        vm.serializeAddress(m, "holding", address(d.holding));
        vm.serializeAddress(m, "evaluator", address(d.evaluator));
        vm.serializeString(o, "main", vm.serializeBool(m, "openTokens", true));

        string[] memory legacy = _keys(vm, json, ".deployment.legacy");
        bool moveMain = _has(keys, "main");
        bool moveDemo = _has(keys, "demo");
        if (legacy.length > 0 || moveMain || moveDemo) {
            string memory l = "deployment.legacy";
            string memory out;
            for (uint256 i; i < legacy.length; ++i) {
                out = _pair(vm, json, l, string.concat(".deployment.legacy.", legacy[i]), legacy[i], oldFactory);
            }
            if (moveMain) out = _pair(vm, json, l, ".deployment.main", _next(legacy, "main-v"), oldFactory);
            if (moveDemo) out = _pair(vm, json, l, ".deployment.demo", _next(legacy, "demo-v"), oldFactory);
            vm.serializeString(o, "legacy", out);
        }

        string memory result = vm.serializeString(o, "network", vm.parseJsonString(json, ".network"));
        vm.writeJson(result, path, ".deployment");
    }

    /// @notice True when the config already records exactly this deployment (promotion ran before); reverts
    ///         `AlreadyDeployed` when it records a different one.
    function isPromoted(Vm vm, string memory json, HirelingRecipe.Deployed memory d, address safe)
        internal
        view
        returns (bool)
    {
        if (!vm.keyExistsJson(json, ".deployment.hireling")) return false;
        string memory h = ".deployment.hireling.";
        bool same = vm.parseJsonAddress(json, string.concat(h, "safe")) == safe
            && vm.parseJsonAddress(json, string.concat(h, "factory")) == address(d.factory)
            && vm.parseJsonAddress(json, string.concat(h, "vault")) == address(d.vault)
            && vm.parseJsonAddress(json, string.concat(h, "feeSchedule")) == address(d.fees)
            && vm.parseJsonAddress(json, string.concat(h, "distributor")) == address(d.distributor)
            && vm.parseJsonAddress(json, string.concat(h, "miningReserve")) == address(d.reserve)
            && vm.parseJsonAddress(json, string.concat(h, "teamVesting")) == address(d.vesting)
            && vm.parseJsonUint(json, string.concat(h, "t0")) == d.t0
            && vm.parseJsonAddress(json, ".deployment.main.holding") == address(d.holding)
            && vm.parseJsonAddress(json, ".deployment.main.evaluator") == address(d.evaluator)
            && vm.parseJsonAddress(json, ".deployment.core") == address(d.core);
        if (!same) revert AlreadyDeployed();
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // The candidate record (review C8-001): what the deploy script believes it sent. Never authoritative;
    // `PromoteHireling` verifies it on-chain before anything reaches `config/<network>.json`.
    // ---------------------------------------------------------------------------------------------

    function candidateDir(Vm vm) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/broadcast/hireling");
    }

    function candidatePath(Vm vm, string memory network) internal view returns (string memory) {
        return string.concat(candidateDir(vm), "/", network, ".candidate.json");
    }

    function writeCandidate(Vm vm, string memory path, uint256 chainId, HirelingRecipe.Deployed memory d, address safe)
        internal
    {
        // broadcast/ is gitignored, so the directory may not exist yet.
        vm.createDir(candidateDir(vm), true);
        string memory k = "candidate";
        vm.serializeUint(k, "chainId", chainId);
        vm.serializeAddress(k, "safe", safe);
        vm.serializeBool(k, "coreDeployed", d.coreDeployed);
        vm.serializeUint(k, "t0", d.t0);
        vm.serializeAddress(k, "core", address(d.core));
        vm.serializeAddress(k, "teamVesting", address(d.vesting));
        vm.serializeAddress(k, "factory", address(d.factory));
        vm.serializeAddress(k, "feeSchedule", address(d.fees));
        vm.serializeAddress(k, "vault", address(d.vault));
        vm.serializeAddress(k, "holding", address(d.holding));
        vm.serializeAddress(k, "evaluator", address(d.evaluator));
        vm.serializeAddress(k, "distributor", address(d.distributor));
        vm.writeJson(vm.serializeAddress(k, "miningReserve", address(d.reserve)), path);
    }

    function readCandidate(Vm vm, string memory path)
        internal
        view
        returns (HirelingRecipe.Deployed memory d, address safe, uint256 chainId)
    {
        string memory json = vm.readFile(path);
        chainId = vm.parseJsonUint(json, ".chainId");
        safe = vm.parseJsonAddress(json, ".safe");
        d.coreDeployed = vm.parseJsonBool(json, ".coreDeployed");
        d.t0 = uint48(vm.parseJsonUint(json, ".t0"));
        d.core = ERC8183WithAuthorization(vm.parseJsonAddress(json, ".core"));
        d.vesting = TeamVesting(payable(vm.parseJsonAddress(json, ".teamVesting")));
        d.factory = Factory(vm.parseJsonAddress(json, ".factory"));
        d.fees = FeeSchedule(vm.parseJsonAddress(json, ".feeSchedule"));
        d.vault = StakeVault(vm.parseJsonAddress(json, ".vault"));
        d.holding = HirelingHolding(vm.parseJsonAddress(json, ".holding"));
        d.evaluator = HirelingEvaluator(vm.parseJsonAddress(json, ".evaluator"));
        d.distributor = EpochDistributor(vm.parseJsonAddress(json, ".distributor"));
        d.reserve = MiningReserve(vm.parseJsonAddress(json, ".miningReserve"));
    }

    /// @dev One legacy pair with an explicit `kind` and `factory`, added to the legacy object under `name`.
    function _pair(
        Vm vm,
        string memory json,
        string memory parent,
        string memory at,
        string memory name,
        address oldFactory
    ) private returns (string memory) {
        string memory p = string.concat(parent, ".", name);
        vm.serializeString(p, "kind", "legacy");
        address factory = vm.keyExistsJson(json, string.concat(at, ".factory"))
            ? vm.parseJsonAddress(json, string.concat(at, ".factory"))
            : oldFactory;
        vm.serializeAddress(p, "factory", factory);
        if (vm.keyExistsJson(json, string.concat(at, ".openTokens"))) {
            vm.serializeBool(p, "openTokens", vm.parseJsonBool(json, string.concat(at, ".openTokens")));
        }
        vm.serializeAddress(p, "holding", vm.parseJsonAddress(json, string.concat(at, ".holding")));
        string memory pair =
            vm.serializeAddress(p, "evaluator", vm.parseJsonAddress(json, string.concat(at, ".evaluator")));
        return vm.serializeString(parent, name, pair);
    }

    /// @dev The first `prefix<N>` (N from 1) not already in `legacy`.
    function _next(string[] memory legacy, string memory prefix) private pure returns (string memory name) {
        for (uint256 n = 1;; ++n) {
            name = string.concat(prefix, Strings.toString(n));
            if (!_has(legacy, name)) return name;
        }
    }
}

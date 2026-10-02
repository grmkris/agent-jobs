// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BroadcastPath} from "./BroadcastPath.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PoolKey, IV4PositionManager, IV4Permit2, IV4StateView, SeedHelper} from "../src/hireling/SeedHelper.sol";

/// @title SeedPoolRecipe
/// @notice C12: one full-range Uniswap v4 FACTORY/USDC position on Monad mainnet, owned by the protocol Safe, created
///         in one transaction by a `SeedHelper` (review C12-002): set the price (initialize, or repair a pool someone
///         initialized at another price, trading through what is in the way up to `maxRepairCost`), mint, clean up.
///         Input: the `liquidity` block of `config/monad-mainnet.json` (protocol addresses checked with `cast code`;
///         amounts, cap and owner are the coordinator's); FACTORY and the Safe from `deployment.hireling`. The price is
///         `quoteAmount / factoryAmount` (3M FACTORY for $300 = $0.0001). Liquidity is computed from 99.99% of each
///         amount with the amounts as the caps, so the mint refuses a pool whose price is off by more than that.
///
///         After the broadcast, `verifyRun` is the authoritative check (review C12-001): it takes the token id from the
///         PositionManager's `Transfer(0 → Safe)` in the run's receipts and reads the position back live.
library SeedPoolRecipe {
    int24 internal constant MAX_TICK = 887272;
    /// @dev The sqrt prices at ticks ±887272. Full-range ticks rounded to the spacing lie inside them, so liquidity
    ///      computed against these bounds never asks for more than the amounts.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 1 << 96;
    /// @dev `liquidity.maxRepairCost` when the config leaves it out: 5 quote units (USDC).
    uint256 internal constant DEFAULT_MAX_REPAIR_COST = 5;
    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant SEEDED_TOPIC =
        keccak256("Seeded(uint256,address,bytes32,uint160,uint128,uint256,uint256)");

    struct Config {
        address poolManager;
        IV4PositionManager positionManager;
        address permit2;
        IV4StateView stateView;
        IERC20 factory;
        IERC20 quote;
        uint24 fee;
        int24 tickSpacing;
        uint256 factoryAmount; // raw units
        uint256 quoteAmount; // raw units
        uint256 maxRepairCost; // raw quote units
        address positionOwner;
        address safe; // deployment.hireling.safe
    }

    struct Plan {
        PoolKey key;
        bytes32 poolId;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        uint256 repairMax0;
        uint256 repairMax1;
        uint128 liquidity;
    }

    error BadConfig(string what);
    error BadRun(string what);
    /// @dev The previous broadcast of this script already seeded; check it with `--sig "verify()"`.
    error AlreadySeeded(uint256 tokenId);

    function load(Vm vm, string memory json) internal view returns (Config memory c) {
        c.poolManager = vm.parseJsonAddress(json, ".liquidity.uniswapV4.poolManager");
        c.positionManager = IV4PositionManager(vm.parseJsonAddress(json, ".liquidity.uniswapV4.positionManager"));
        c.permit2 = vm.parseJsonAddress(json, ".liquidity.uniswapV4.permit2");
        c.stateView = IV4StateView(vm.parseJsonAddress(json, ".liquidity.uniswapV4.stateView"));
        c.factory = IERC20(vm.parseJsonAddress(json, ".deployment.hireling.factory"));
        c.safe = vm.parseJsonAddress(json, ".deployment.hireling.safe");
        c.quote = IERC20(vm.parseJsonAddress(json, ".liquidity.quote"));
        c.fee = SafeCast.toUint24(vm.parseJsonUint(json, ".liquidity.fee"));
        c.tickSpacing = SafeCast.toInt24(SafeCast.toInt256(vm.parseJsonUint(json, ".liquidity.tickSpacing")));
        uint256 quoteUnit = 10 ** IERC20Metadata(address(c.quote)).decimals();
        c.factoryAmount = vm.parseJsonUint(json, ".liquidity.factoryAmount") * 1e18;
        c.quoteAmount = vm.parseJsonUint(json, ".liquidity.quoteAmount") * quoteUnit;
        c.maxRepairCost =
            (vm.keyExistsJson(json, ".liquidity.maxRepairCost")
                        ? vm.parseJsonUint(json, ".liquidity.maxRepairCost")
                        : DEFAULT_MAX_REPAIR_COST) * quoteUnit;
        c.positionOwner = vm.parseJsonAddress(json, ".liquidity.positionOwner");
    }

    /// @notice Everything that must hold before the seeder approves anything.
    function check(Config memory c) internal view {
        if (c.positionOwner == address(0)) revert BadConfig("positionOwner unset");
        // Review C12-003: the position goes to the deployed protocol Safe, not to whatever the field says.
        if (c.positionOwner != c.safe) revert BadConfig("positionOwner is not deployment.hireling.safe");
        if (c.safe.code.length == 0) revert BadConfig("no code at the Safe");
        if (c.factoryAmount == 0 || c.quoteAmount == 0) revert BadConfig("zero amount");
        if (c.maxRepairCost == 0) revert BadConfig("zero maxRepairCost");
        if (c.maxRepairCost > c.quoteAmount) revert BadConfig("maxRepairCost above quoteAmount");
        if (c.tickSpacing <= 0 || c.fee > 1_000_000) revert BadConfig("fee or tickSpacing");
        address[5] memory needCode =
            [c.poolManager, address(c.positionManager), c.permit2, address(c.stateView), address(c.factory)];
        for (uint256 i; i < needCode.length; ++i) {
            if (needCode[i].code.length == 0) revert BadConfig("no code at a configured address");
        }
        if (address(c.quote).code.length == 0) revert BadConfig("no code at the quote token");
        if (c.positionManager.poolManager() != c.poolManager) revert BadConfig("positionManager.poolManager");
        if (c.positionManager.permit2() != c.permit2) revert BadConfig("positionManager.permit2");
        if (c.stateView.poolManager() != c.poolManager) revert BadConfig("stateView.poolManager");
        if (IERC20Metadata(address(c.factory)).decimals() != 18) revert BadConfig("factory decimals");
    }

    function plan(Config memory c) internal pure returns (Plan memory p) {
        bool factoryFirst = address(c.factory) < address(c.quote);
        (address c0, address c1) =
            factoryFirst ? (address(c.factory), address(c.quote)) : (address(c.quote), address(c.factory));
        (p.amount0, p.amount1) = factoryFirst ? (c.factoryAmount, c.quoteAmount) : (c.quoteAmount, c.factoryAmount);
        // The repair cap in each token: maxRepairCost in quote, and its FACTORY value at the target price.
        uint256 factoryCap = Math.mulDiv(c.maxRepairCost, c.factoryAmount, c.quoteAmount);
        (p.repairMax0, p.repairMax1) = factoryFirst ? (factoryCap, c.maxRepairCost) : (c.maxRepairCost, factoryCap);
        p.key = PoolKey(c0, c1, c.fee, c.tickSpacing, address(0));
        p.poolId = keccak256(abi.encode(p.key));
        // price = amount1 / amount0 in raw units; sqrtPriceX96 = sqrt(price) * 2^96.
        p.sqrtPriceX96 = SafeCast.toUint160(Math.sqrt(Math.mulDiv(p.amount1, 1 << 192, p.amount0)));
        p.tickUpper = (MAX_TICK / c.tickSpacing) * c.tickSpacing;
        p.tickLower = -p.tickUpper;
        uint256 a0 = p.amount0 * 9999 / 10_000;
        uint256 a1 = p.amount1 * 9999 / 10_000;
        uint256 l0 =
            Math.mulDiv(a0, Math.mulDiv(p.sqrtPriceX96, MAX_SQRT_PRICE, Q96), uint256(MAX_SQRT_PRICE) - p.sqrtPriceX96);
        uint256 l1 = Math.mulDiv(a1, Q96, uint256(p.sqrtPriceX96) - MIN_SQRT_PRICE);
        p.liquidity = SafeCast.toUint128(Math.min(l0, l1));
    }

    function helperPlan(Config memory c, Plan memory p) internal pure returns (SeedHelper.Plan memory) {
        return SeedHelper.Plan({
            key: p.key,
            sqrtPriceX96: p.sqrtPriceX96,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: p.liquidity,
            amount0: SafeCast.toUint128(p.amount0),
            amount1: SafeCast.toUint128(p.amount1),
            repairMax0: SafeCast.toUint128(p.repairMax0),
            repairMax1: SafeCast.toUint128(p.repairMax1),
            owner: c.positionOwner
        });
    }

    /// @notice The three steps the broadcaster (the seeder, holding both tokens) sends: deploy the helper, approve it
    ///         seed amount + repair cap of each token, `seed()`. Split so the fork tests can race between them.
    function deployHelper(Config memory c, Plan memory p) internal returns (SeedHelper) {
        return new SeedHelper(c.positionManager, c.stateView, helperPlan(c, p));
    }

    function approveHelper(Plan memory p, SeedHelper helper) internal {
        IERC20(p.key.currency0).approve(address(helper), p.amount0 + p.repairMax0);
        IERC20(p.key.currency1).approve(address(helper), p.amount1 + p.repairMax1);
    }

    function seed(Config memory c, Plan memory p) internal returns (SeedHelper helper, uint256 tokenId) {
        helper = deployHelper(c, p);
        approveHelper(p, helper);
        tokenId = helper.seed();
    }

    /// @notice The token id the seed minted, from the logs of the seed transaction: exactly one PositionManager
    ///         `Transfer(0 → Safe)`, matched by a helper `Seeded` event for that id, at the planned pool, price and
    ///         liquidity. Returns the helper that emitted it.
    function fromLogs(Config memory c, Plan memory p, VmSafe.Log[] memory logs)
        internal
        pure
        returns (uint256 tokenId, address helper)
    {
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            VmSafe.Log memory l = logs[i];
            if (l.emitter != address(c.positionManager) || l.topics.length != 4 || l.topics[0] != TRANSFER_TOPIC) {
                continue;
            }
            if (l.topics[1] != bytes32(0) || l.topics[2] != bytes32(uint256(uint160(c.safe)))) continue;
            tokenId = uint256(l.topics[3]);
            ++found;
        }
        if (found != 1) revert BadRun("expected exactly one PositionManager mint to the Safe");
        for (uint256 i; i < logs.length; ++i) {
            VmSafe.Log memory l = logs[i];
            if (l.topics.length != 4 || l.topics[0] != SEEDED_TOPIC || uint256(l.topics[1]) != tokenId) continue;
            if (l.topics[2] != bytes32(uint256(uint160(c.safe))) || l.topics[3] != p.poolId) {
                revert BadRun("Seeded: owner or pool");
            }
            (uint160 price, uint128 liquidity,,) = abi.decode(l.data, (uint160, uint128, uint256, uint256));
            if (price != p.sqrtPriceX96) revert BadRun("Seeded: price after the seed");
            if (liquidity != p.liquidity) revert BadRun("Seeded: liquidity");
            return (tokenId, l.emitter);
        }
        revert BadRun("no Seeded event for the minted token");
    }

    /// @notice Post-broadcast: the position as it is now: owned by the Safe, the planned liquidity, the planned pool
    ///         key and full-range ticks; the helper spent (`seeded`) with no allowance left from it or to it. Its token
    ///         balances are not checked: `seed()` returns everything it holds, and anyone can send it dust afterwards
    ///         (review C12-004), which must not block this check.
    function verifyPosition(Config memory c, Plan memory p, uint256 tokenId, address helper) internal view {
        if (c.positionManager.ownerOf(tokenId) != c.safe) revert BadRun("position owner is not the Safe");
        if (c.positionManager.getPositionLiquidity(tokenId) != p.liquidity) revert BadRun("position liquidity");
        (PoolKey memory key, uint256 info) = c.positionManager.getPoolAndPositionInfo(tokenId);
        if (keccak256(abi.encode(key)) != p.poolId) revert BadRun("position pool key");
        if (int24(uint24(info >> 8)) != p.tickLower || int24(uint24(info >> 32)) != p.tickUpper) {
            revert BadRun("position ticks");
        }
        if (!SeedHelper(helper).seeded()) revert BadRun("helper not seeded");
        address seeder = SeedHelper(helper).seeder();
        address[2] memory tokens = [p.key.currency0, p.key.currency1];
        for (uint256 i; i < 2; ++i) {
            IERC20 t = IERC20(tokens[i]);
            if (t.allowance(helper, c.permit2) != 0 || t.allowance(seeder, helper) != 0) {
                revert BadRun("allowance left");
            }
            (uint160 permitted,,) = IV4Permit2(c.permit2).allowance(helper, tokens[i], address(c.positionManager));
            if (permitted != 0) revert BadRun("Permit2 allowance left");
        }
    }

    // ---- the broadcast log (`<broadcast>/SeedPool.s.sol/<chainId>/run-latest.json`, BroadcastPath) ----

    function runPath(Vm vm, uint256 chainId) internal view returns (string memory) {
        return string.concat(BroadcastPath.root(vm), "/SeedPool.s.sol/", vm.toString(chainId), "/run-latest.json");
    }

    /// @notice The logs of the run's successful receipts. `strict` (the verification) also refuses a pending
    ///         transaction or a failed receipt; the retry guard only skips them.
    function runLogs(Vm vm, string memory path, bool strict) internal view returns (VmSafe.Log[] memory logs) {
        string memory json = vm.readFile(path);
        if (strict && vm.keyExistsJson(json, ".pending[0]")) revert BadRun("pending transactions");
        uint256 receipts;
        while (vm.keyExistsJson(json, string.concat(".receipts[", vm.toString(receipts), "]"))) ++receipts;
        if (strict && receipts == 0) revert BadRun("no receipts");
        bool[] memory ok = new bool[](receipts);
        uint256 total;
        for (uint256 j; j < receipts; ++j) {
            ok[j] = vm.parseJsonUint(json, string.concat(".receipts[", vm.toString(j), "].status")) == 1;
            if (!ok[j] && strict) revert BadRun("failed receipt");
            if (ok[j]) total += _logCount(vm, json, j);
        }
        logs = new VmSafe.Log[](total);
        uint256 n;
        for (uint256 j; j < receipts; ++j) {
            if (!ok[j]) continue;
            uint256 count = _logCount(vm, json, j);
            for (uint256 k; k < count; ++k) {
                string memory l = string.concat(".receipts[", vm.toString(j), "].logs[", vm.toString(k), "]");
                logs[n++] = VmSafe.Log({
                    topics: vm.parseJsonBytes32Array(json, string.concat(l, ".topics")),
                    data: vm.parseJsonBytes(json, string.concat(l, ".data")),
                    emitter: vm.parseJsonAddress(json, string.concat(l, ".address"))
                });
            }
        }
    }

    function _logCount(Vm vm, string memory json, uint256 receipt) private view returns (uint256 k) {
        while (vm.keyExistsJson(
                json, string.concat(".receipts[", vm.toString(receipt), "].logs[", vm.toString(k), "]")
            )) {
            ++k;
        }
    }

    /// @notice Refuses a second seed (review C12-001: a retry after a seed that did land): reverts when the last
    ///         broadcast log for this chain holds a mint of the planned position to the Safe.
    function refusePriorSeed(Vm vm, Config memory c, Plan memory p, string memory path) internal view {
        if (!vm.exists(path)) return;
        VmSafe.Log[] memory logs = runLogs(vm, path, false);
        for (uint256 i; i < logs.length; ++i) {
            VmSafe.Log memory l = logs[i];
            if (l.topics.length == 4 && l.topics[0] == SEEDED_TOPIC && l.topics[3] == p.poolId) {
                if (l.topics[2] == bytes32(uint256(uint160(c.safe)))) revert AlreadySeeded(uint256(l.topics[1]));
            }
        }
    }
}

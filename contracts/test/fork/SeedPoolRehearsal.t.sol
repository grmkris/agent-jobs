// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HirelingRecipe} from "../../script/HirelingRecipe.sol";
import {HirelingOutput} from "../../script/HirelingOutput.sol";
import {SeedPoolRecipe} from "../../script/SeedPoolRecipe.sol";
import {PoolKey, IV4PoolManager, IV4PositionManager, IV4Permit2, SeedHelper} from "../../src/hireling/SeedHelper.sol";
import {RecipeDriver} from "../hireling/Recipe.t.sol";

/// @dev C12 rehearsal on a local fork of Monad mainnet (nothing is sent): a fresh v1 deploy gives FACTORY and the Safe,
///      the proposed `liquidity` block (SURFACE, "Liquidity seed") goes into a scratch config, and the seeder creates
///      the full-range FACTORY/USDC position on the live Uniswap v4 contracts through a `SeedHelper`. The races of
///      review C12-001/002 are played between the helper's deployment and its `seed()`. Skipped unless
///      MONAD_MAINNET_RPC_URL is set.
contract SeedPoolRehearsalForkTest is Test {
    address safe = makeAddr("pool-safe");
    address seeder = makeAddr("seeder");
    address stranger = makeAddr("stranger");
    uint24 scratchFee = 1001;

    /// @dev The block proposed for config/monad-mainnet.json (the coordinator commits it), with the test's owner.
    ///      `maxRepairCost` is left out: the default, 5 USDC, applies.
    function _liquidityBlock(address owner) internal pure returns (string memory) {
        return string.concat(
            '{"uniswapV4":{"poolManager":"0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e",',
            '"positionManager":"0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016",',
            '"permit2":"0x000000000022D473030F116dDEE9F6B43aC78BA3",',
            '"stateView":"0x77395F3b2E73aE90843717371294fa97cC419D64"},',
            '"quote":"0x754704Bc059F8C67012fEd69BC8A327a5aafb603","fee":3000,"tickSpacing":60,',
            '"factoryAmount":3000000,"quoteAmount":300,"positionOwner":"',
            vm.toString(owner),
            '"}'
        );
    }

    function _setUp(string memory name) internal returns (bool, SeedPoolRecipe.Config memory c) {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return (false, c);
        vm.createSelectFork(rpc);
        vm.etch(safe, hex"00");
        HirelingRecipe.Config memory r = HirelingRecipe.loadBase(vm, "monad-mainnet");
        r.safe = safe;
        r.defaultArbitrator = makeAddr("arbiter");
        r.margin = 1 days;
        r.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        r.bps = [uint16(3000), 1000, 300, 100];
        r.feeTreasury = safe;
        r.treasury = safe;
        r.ecosystem = safe;
        r.liquidity = seeder;
        r.vestingBeneficiary = makeAddr("team");
        r.vestingStartOffset = 365 days;
        r.vestingDuration = 3 * 365 days;
        RecipeDriver driver = new RecipeDriver();
        driver.configure(r);
        for (uint256 i; i < 13; ++i) {
            driver.step(i);
        }
        HirelingRecipe.Deployed memory d = driver.deployed();

        // One scratch file per test: tests run in parallel.
        string memory path = string.concat(vm.projectRoot(), "/config/.test-seedpool-", name, ".json");
        vm.writeFile(path, vm.readFile(HirelingRecipe.path(vm, "monad-mainnet")));
        HirelingOutput.write(vm, path, d, safe, block.number, block.number);
        vm.writeJson(_liquidityBlock(safe), path, ".liquidity");
        c = SeedPoolRecipe.load(vm, vm.readFile(path));
        vm.removeFile(path);
        assertEq(address(c.factory), address(d.factory));
        assertEq(c.safe, safe, "the Safe from deployment.hireling");
        assertEq(c.factoryAmount, 3_000_000e18);
        assertEq(c.quoteAmount, 300e6);
        assertEq(c.maxRepairCost, 5e6, "default repair cap: 5 USDC");
        deal(address(c.quote), seeder, 1_000e6);
        return (true, c);
    }

    // ---- the seed, step by step as the script broadcasts it ----

    function _helper(SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p) internal returns (SeedHelper h) {
        vm.startPrank(seeder, seeder);
        h = SeedPoolRecipe.deployHelper(c, p);
        SeedPoolRecipe.approveHelper(p, h);
        vm.stopPrank();
    }

    function _seed(SeedHelper h) internal returns (uint256 tokenId, VmSafe.Log[] memory logs) {
        vm.recordLogs();
        vm.prank(seeder, seeder);
        tokenId = h.seed();
        logs = vm.getRecordedLogs();
    }

    /// @dev The authoritative check, from the seed's logs; asserts it agrees with the helper.
    function _verify(
        SeedPoolRecipe.Config memory c,
        SeedPoolRecipe.Plan memory p,
        VmSafe.Log[] memory logs,
        SeedHelper h
    ) internal view returns (uint256 tokenId) {
        address emitter;
        (tokenId, emitter) = SeedPoolRecipe.fromLogs(c, p, logs);
        assertEq(emitter, address(h));
        SeedPoolRecipe.verifyPosition(c, p, tokenId, address(h));
    }

    function _repairOf(VmSafe.Log[] memory logs) internal pure returns (bool found, int256 d0, int256 d1) {
        bytes32 topic = keccak256("Repaired(uint160,uint160,int256,int256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                (,, d0, d1) = abi.decode(logs[i].data, (uint160, uint160, int256, int256));
                return (true, d0, d1);
            }
        }
    }

    function _balances(SeedPoolRecipe.Config memory c) internal view returns (uint256 f, uint256 q) {
        return (c.factory.balanceOf(seeder), c.quote.balanceOf(seeder));
    }

    // ---- the plain seed ----

    function test_fork_mainnet_seedsTheFullRangePosition() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("seed");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.check(c);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        assertEq(p.tickUpper, 887220);
        assertEq(p.tickLower, -887220);
        (uint256 f0, uint256 q0) = _balances(c);

        SeedHelper h = _helper(c, p);
        (uint256 returned, VmSafe.Log[] memory logs) = _seed(h);
        uint256 tokenId = _verify(c, p, logs, h);
        assertEq(tokenId, returned);
        (bool repaired,,) = _repairOf(logs);
        assertFalse(repaired, "a fresh pool is initialized, not repaired");

        (uint256 f1, uint256 q1) = _balances(c);
        uint256 factorySpent = f0 - f1;
        uint256 usdcSpent = q0 - q1;
        assertApproxEqRel(factorySpent, 3_000_000e18, 2e14, "about 3M FACTORY (within 0.02%)");
        assertApproxEqRel(usdcSpent, 300e6, 2e14, "about $300");
        assertLe(factorySpent, 3_000_000e18, "the repair caps came back");
        assertLe(usdcSpent, 300e6);
        // $0.0001 per FACTORY: spent USDC per FACTORY, in raw units, ~= 100 / 1e18.
        assertApproxEqRel(usdcSpent * 1e18 / factorySpent, 100, 1e15);
        assertEq(c.positionManager.ownerOf(tokenId), safe);
        assertTrue(h.seeded());
    }

    // ---- C12-002: a pool initialized at a junk price before the seed ----

    /// @dev Someone initializes the pool at a junk price after the helper is deployed and approved, and adds nothing:
    ///      the seed moves the empty pool's price for free inside the same transaction, then mints at the target.
    function test_fork_mainnet_repairsAnEmptyPoolInitializedAboveTheTarget() public {
        _repairEmpty("junk-up", 4);
    }

    function test_fork_mainnet_repairsAnEmptyPoolInitializedBelowTheTarget() public {
        _repairEmpty("junk-down", 0);
    }

    function _repairEmpty(string memory name, uint256 factor) internal {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp(name);
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        uint160 junk = factor == 0 ? p.sqrtPriceX96 / 1000 : p.sqrtPriceX96 * uint160(factor);
        vm.prank(stranger);
        c.positionManager.initializePool(p.key, junk);
        (uint256 f0, uint256 q0) = _balances(c);
        (, VmSafe.Log[] memory logs) = _seed(h);
        _verify(c, p, logs, h);
        (bool repaired, int256 d0, int256 d1) = _repairOf(logs);
        assertTrue(repaired);
        assertEq(d0, 0, "an empty pool moves for free");
        assertEq(d1, 0);
        (uint256 f1, uint256 q1) = _balances(c);
        assertApproxEqRel(f0 - f1, 3_000_000e18, 2e14);
        assertApproxEqRel(q0 - q1, 300e6, 2e14);
    }

    /// @dev Review addendum: one-sided dust between the target and a junk price is out of range, so `getLiquidity()`
    ///      reads zero, yet a zero-delta repair would hit it. The repair trades through it within the cap.
    function test_fork_mainnet_repairTradesThroughOutOfRangeDustWithinTheCap() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("dust-out");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        _junkWithDustBelow(c, p, 1); // $1 of dust
        assertEq(c.stateView.getLiquidity(p.poolId), 0, "the dust is out of range");
        (, VmSafe.Log[] memory logs) = _seed(h);
        _verify(c, p, logs, h);
        _assertRepairWithinCap(p, logs);
    }

    /// @dev Dust in range at the junk price (here below the target) is bought through cheaply as well.
    function test_fork_mainnet_repairBuysInRangeDustWithinTheCap() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("dust-in");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        uint160 junk = p.sqrtPriceX96 / 2;
        vm.prank(stranger);
        c.positionManager.initializePool(p.key, junk);
        // In range at the junk price: [0.8, 1.25] × junk. Above the junk price it holds currency0 worth ~$1.
        (int24 lower, int24 upper) = _ticksBetween(c, p, junk * 4 / 5, junk * 5 / 4);
        uint256 amount0 = _dollars(c, p.key.currency0, 1);
        uint256 L = Math.mulDiv(Math.mulDiv(amount0, junk, 1 << 96), uint256(junk) * 5 / 4, uint256(junk) / 4);
        _mintAs(c, p.key, lower, upper, L);
        assertGt(c.stateView.getLiquidity(p.poolId), 0, "the dust is in range");
        (, VmSafe.Log[] memory logs) = _seed(h);
        _verify(c, p, logs, h);
        _assertRepairWithinCap(p, logs);
    }

    /// @dev Dust worth more than the cap blocks the repair: the seed reverts and nothing moves. The coordinator then
    ///      seeds the documented fallback key (fee 10000, tickSpacing 200), which works.
    function test_fork_mainnet_refusesARepairAboveTheCapThenSeedsTheFallbackKey() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("over-cap");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        _junkWithDustBelow(c, p, 100); // $100 of liquidity in the way, cap $5
        (uint256 f0, uint256 q0) = _balances(c);
        vm.prank(seeder, seeder);
        vm.expectPartialRevert(SeedHelper.PriceNotSet.selector);
        h.seed();
        (uint256 f1, uint256 q1) = _balances(c);
        assertEq(f1, f0, "nothing moved");
        assertEq(q1, q0, "nothing moved");
        assertFalse(h.seeded());

        c.fee = 10_000;
        c.tickSpacing = 200;
        SeedPoolRecipe.Plan memory fp = SeedPoolRecipe.plan(c);
        assertTrue(fp.poolId != p.poolId);
        assertEq(fp.tickUpper, 887200);
        SeedHelper fh = _helper(c, fp);
        (, VmSafe.Log[] memory logs) = _seed(fh);
        _verify(c, fp, logs, fh);
    }

    // ---- C12-001: the token id comes from the seed's own receipt ----

    /// @dev Someone mints an unrelated position between the script's start and the seed. A pre-read `nextTokenId`
    ///      would now name their position; the receipt-based check finds the Safe's.
    function test_fork_mainnet_unrelatedMintBeforeTheSeedDoesNotConfuseTheReadback() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("race-mint");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        uint256 stale = c.positionManager.nextTokenId();
        PoolKey memory other = _scratchKey(c, p);
        IV4PoolManager(c.poolManager).initialize(other, p.sqrtPriceX96);
        _mintAs(c, other, -600, 600, 1e12);
        assertEq(c.positionManager.ownerOf(stale), stranger);

        (, VmSafe.Log[] memory logs) = _seed(h);
        uint256 tokenId = _verify(c, p, logs, h);
        assertEq(tokenId, stale + 1);
        assertEq(c.positionManager.ownerOf(tokenId), safe);
    }

    /// @dev After a seed that landed: the broadcast log round-trips through the script's parser, a later mint in the
    ///      same pool does not change what it verifies, and a second run of the script is refused before it sends
    ///      anything. The helper itself seeds once.
    function test_fork_mainnet_verifiesFromTheRunLogAndRefusesARetry() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("retry");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        (uint256 tokenId, VmSafe.Log[] memory logs) = _seed(h);
        _mintAs(c, p.key, -6000, 6000, 1e12); // someone else adds liquidity right after

        vm.createDir(string.concat(vm.projectRoot(), "/broadcast/hireling"), true);
        string memory path = string.concat(vm.projectRoot(), "/broadcast/hireling/.test-seedpool-run.json");
        vm.writeFile(path, _runJson(logs));
        VmSafe.Log[] memory parsed = SeedPoolRecipe.runLogs(vm, path, true);
        (uint256 fromRun, address helper) = SeedPoolRecipe.fromLogs(c, p, parsed);
        assertEq(fromRun, tokenId);
        SeedPoolRecipe.verifyPosition(c, p, fromRun, helper);
        vm.expectRevert(abi.encodeWithSelector(SeedPoolRecipe.AlreadySeeded.selector, tokenId));
        this.refusePriorSeedExt(c, p, path);
        vm.removeFile(path);
        // No previous log: nothing to refuse.
        this.refusePriorSeedExt(c, p, path);

        vm.prank(seeder, seeder);
        vm.expectRevert(SeedHelper.AlreadySeeded.selector);
        h.seed();
    }

    function refusePriorSeedExt(SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p, string memory path)
        external
        view
    {
        SeedPoolRecipe.refusePriorSeed(vm, c, p, path);
    }

    function test_fork_helperGuards() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("guards");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        SeedHelper h = _helper(c, p);
        vm.prank(stranger);
        vm.expectRevert(SeedHelper.NotSeeder.selector);
        h.seed();
        vm.expectRevert(SeedHelper.NotPoolManager.selector);
        h.unlockCallback("");
        SeedHelper.Plan memory hp = SeedPoolRecipe.helperPlan(c, p);
        hp.owner = makeAddr("codeless");
        vm.expectRevert(abi.encodeWithSelector(SeedHelper.BadPlan.selector, "owner without code"));
        new SeedHelper(c.positionManager, c.stateView, hp);
    }

    // ---- C12-003: the owner is the deployed Safe ----

    function test_check_positionOwnerMustBeTheDeployedSafe() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("owner");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.check(c);
        c.positionOwner = stranger;
        vm.expectRevert(
            abi.encodeWithSelector(SeedPoolRecipe.BadConfig.selector, "positionOwner is not deployment.hireling.safe")
        );
        this.checkExt(c);
        c.positionOwner = address(0);
        vm.expectRevert(abi.encodeWithSelector(SeedPoolRecipe.BadConfig.selector, "positionOwner unset"));
        this.checkExt(c);
        c.safe = makeAddr("codeless");
        c.positionOwner = c.safe;
        vm.expectRevert(abi.encodeWithSelector(SeedPoolRecipe.BadConfig.selector, "no code at the Safe"));
        this.checkExt(c);
    }

    function checkExt(SeedPoolRecipe.Config memory c) external view {
        SeedPoolRecipe.check(c);
    }

    // ---- fixtures ----

    /// @dev The pool initialized at twice the target sqrt price, and a one-sided position strictly between the target
    ///      and that price (below the current price, so it holds currency1 only) worth `usd` at the target price.
    function _junkWithDustBelow(SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p, uint256 usd) internal {
        uint160 junk = p.sqrtPriceX96 * 2;
        vm.prank(stranger);
        c.positionManager.initializePool(p.key, junk);
        uint160 lo = p.sqrtPriceX96 * 6 / 5;
        uint160 hi = p.sqrtPriceX96 * 9 / 5;
        (int24 lower, int24 upper) = _ticksBetween(c, p, lo, hi);
        uint256 amount1 = _dollars(c, p.key.currency1, usd);
        _mintAs(c, p.key, lower, upper, Math.mulDiv(amount1, 1 << 96, hi - lo));
    }

    function _assertRepairWithinCap(SeedPoolRecipe.Plan memory p, VmSafe.Log[] memory logs) internal pure {
        (bool repaired, int256 d0, int256 d1) = _repairOf(logs);
        assertTrue(repaired);
        // The helper pays the input token (negative) and receives the other.
        (int256 paid, uint256 cap) = d0 < 0 ? (-d0, p.repairMax0) : (-d1, p.repairMax1);
        assertGt(paid, 0, "the repair traded through the dust");
        assertLe(uint256(paid), cap, "within the cap");
    }

    /// @dev `usd` dollars of `token` at the target price ($0.0001 per FACTORY).
    function _dollars(SeedPoolRecipe.Config memory c, address token, uint256 usd) internal pure returns (uint256) {
        return token == address(c.quote) ? usd * 1e6 : usd * 10_000e18;
    }

    /// @dev Ticks on the pool's spacing strictly inside [lo, hi] (sqrt prices), read from scratch pools.
    function _ticksBetween(SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p, uint160 lo, uint160 hi)
        internal
        returns (int24 lower, int24 upper)
    {
        int24 s = p.key.tickSpacing;
        lower = _ceil(_tickAt(c, p, lo) + 1, s);
        upper = _floor(_tickAt(c, p, hi), s);
        assertLt(lower, upper);
    }

    function _tickAt(SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p, uint160 sqrtPriceX96)
        internal
        returns (int24)
    {
        return IV4PoolManager(c.poolManager).initialize(_scratchKey(c, p), sqrtPriceX96);
    }

    function _scratchKey(SeedPoolRecipe.Config memory, SeedPoolRecipe.Plan memory p) internal returns (PoolKey memory) {
        return PoolKey(p.key.currency0, p.key.currency1, scratchFee++, 60, address(0));
    }

    function _floor(int24 t, int24 s) internal pure returns (int24) {
        int24 q = t / s;
        if (t < 0 && q * s != t) --q;
        return q * s;
    }

    function _ceil(int24 t, int24 s) internal pure returns (int24) {
        int24 f = _floor(t, s);
        return f == t ? t : f + s;
    }

    /// @dev The stranger mints `liquidity` in [lower, upper] directly through the PositionManager.
    function _mintAs(SeedPoolRecipe.Config memory c, PoolKey memory key, int24 lower, int24 upper, uint256 liquidity)
        internal
    {
        deal(key.currency0, stranger, IERC20(key.currency0).balanceOf(stranger) + 1e30);
        deal(key.currency1, stranger, IERC20(key.currency1).balanceOf(stranger) + 1e30);
        vm.startPrank(stranger);
        IERC20(key.currency0).approve(c.permit2, type(uint256).max);
        IERC20(key.currency1).approve(c.permit2, type(uint256).max);
        IV4Permit2(c.permit2).approve(key.currency0, address(c.positionManager), type(uint160).max, type(uint48).max);
        IV4Permit2(c.permit2).approve(key.currency1, address(c.positionManager), type(uint160).max, type(uint48).max);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, lower, upper, liquidity, type(uint128).max, type(uint128).max, stranger, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        c.positionManager
            .modifyLiquidities(abi.encode(abi.encodePacked(uint8(0x02), uint8(0x0d)), params), block.timestamp);
        vm.stopPrank();
    }

    /// @dev A broadcast log in forge's shape, holding one successful receipt with `logs`.
    function _runJson(VmSafe.Log[] memory logs) internal pure returns (string memory) {
        string memory items;
        for (uint256 i; i < logs.length; ++i) {
            string memory topics;
            for (uint256 t; t < logs[i].topics.length; ++t) {
                topics = string.concat(topics, t == 0 ? "" : ",", '"', vm.toString(logs[i].topics[t]), '"');
            }
            items = string.concat(
                items,
                i == 0 ? "" : ",",
                '{"address":"',
                vm.toString(logs[i].emitter),
                '","topics":[',
                topics,
                '],"data":"',
                vm.toString(logs[i].data),
                '"}'
            );
        }
        return string.concat('{"transactions":[],"receipts":[{"status":"0x1","logs":[', items, ']}],"pending":[]}');
    }
}

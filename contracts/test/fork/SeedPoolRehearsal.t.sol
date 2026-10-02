// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HirelingRecipe} from "../../script/HirelingRecipe.sol";
import {HirelingOutput} from "../../script/HirelingOutput.sol";
import {SeedPoolRecipe, IV4PositionManager, IV4PoolManager, V4PriceSetter} from "../../script/SeedPool.s.sol";
import {RecipeDriver} from "../hireling/Recipe.t.sol";

/// @dev C12 rehearsal on a local fork of Monad mainnet (nothing is sent): a fresh v1 deploy gives FACTORY, the
///      proposed `liquidity` block (SURFACE, "Liquidity seed") goes into a scratch config, and the seeder creates the
///      full-range FACTORY/USDC position on the live Uniswap v4 contracts. Skipped unless MONAD_MAINNET_RPC_URL is set.
contract SeedPoolRehearsalForkTest is Test {
    address safe = makeAddr("pool-safe");
    address seeder = makeAddr("seeder");
    address stranger = makeAddr("stranger");

    /// @dev The block proposed for config/monad-mainnet.json (the coordinator commits it), with the test's owner.
    function _liquidityBlock(address owner) internal pure returns (string memory) {
        return string.concat(
            '{"uniswapV4":{"poolManager":"0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e",',
            '"positionManager":"0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016",',
            '"permit2":"0x000000000022D473030F116dDEE9F6B43aC78BA3",',
            '"stateView":"0x77395F3b2E73aE90843717371294fa97cC419D64"},',
            '"quote":"0x754704Bc059F8C67012fEd69BC8A327a5aafb603","fee":3000,"tickSpacing":60,',
            '"factoryAmount":3000000,"quoteAmount":300,"positionOwner":"', vm.toString(owner), '"}'
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
        assertEq(c.factoryAmount, 3_000_000e18);
        assertEq(c.quoteAmount, 300e6);
        deal(address(c.quote), seeder, 300e6);
        return (true, c);
    }

    function test_fork_mainnet_seedsTheFullRangePosition() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("seed");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.check(c);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        assertEq(p.tickUpper, 887220);
        assertEq(p.tickLower, -887220);
        uint256 factoryBefore = c.factory.balanceOf(seeder);

        vm.startPrank(seeder, seeder);
        uint256 tokenId = SeedPoolRecipe.seed(c, p);
        vm.stopPrank();
        SeedPoolRecipe.verify(c, p, tokenId);

        uint256 factorySpent = factoryBefore - c.factory.balanceOf(seeder);
        uint256 usdcSpent = 300e6 - c.quote.balanceOf(seeder);
        assertApproxEqRel(factorySpent, 3_000_000e18, 2e14, "about 3M FACTORY (within 0.02%)");
        assertApproxEqRel(usdcSpent, 300e6, 2e14, "about $300");
        assertLe(factorySpent, 3_000_000e18);
        assertLe(usdcSpent, 300e6);
        // $0.0001 per FACTORY: spent USDC per FACTORY, in raw units, ~= 100 / 1e18.
        assertApproxEqRel(usdcSpent * 1e18 / factorySpent, 100, 1e15);
        assertEq(IV4PositionManager(address(c.positionManager)).ownerOf(tokenId), safe);
    }

    /// @dev Someone initializes the same pool at a junk price first (above or below the target) and adds nothing:
    ///      the seed moves the empty pool's price back for free, then mints at the target.
    function test_fork_mainnet_recoversAnEmptyPoolInitializedAtAJunkPrice() public {
        _recoverFrom("junk-up", 4);
    }

    function test_fork_mainnet_recoversAnEmptyPoolInitializedBelowTheTarget() public {
        _recoverFrom("junk-down", 0);
    }

    function _recoverFrom(string memory name, uint256 factor) internal {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp(name);
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        uint160 junk = factor == 0 ? p.sqrtPriceX96 / 1000 : p.sqrtPriceX96 * uint160(factor);
        vm.prank(stranger);
        c.positionManager.initializePool(p.key, junk);
        (uint160 current,,,) = c.stateView.getSlot0(p.poolId);
        assertEq(current, junk);
        vm.startPrank(seeder, seeder);
        uint256 tokenId = SeedPoolRecipe.seed(c, p);
        vm.stopPrank();
        SeedPoolRecipe.verify(c, p, tokenId);
        uint256 factorySpent = 50_000_000e18 - c.factory.balanceOf(seeder);
        assertApproxEqRel(factorySpent, 3_000_000e18, 2e14);
        assertApproxEqRel(300e6 - c.quote.balanceOf(seeder), 300e6, 2e14);
    }

    /// @dev A junk-priced pool that already holds liquidity is refused: moving it would trade against its owner.
    function test_fork_mainnet_refusesAJunkPoolWithLiquidity() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("junk-liquid");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        uint160 junk = p.sqrtPriceX96 * 2;
        // The stranger initializes at twice the target sqrt price and seeds a small position there.
        vm.prank(seeder);
        c.factory.transfer(stranger, 1_000e18);
        deal(address(c.quote), stranger, 10e6);
        SeedPoolRecipe.Config memory sc = c;
        sc.factoryAmount = 1_000e18;
        sc.quoteAmount = 10e6;
        sc.positionOwner = stranger;
        vm.prank(stranger);
        c.positionManager.initializePool(p.key, junk);
        SeedPoolRecipe.Plan memory sp = SeedPoolRecipe.plan(sc);
        sp.sqrtPriceX96 = junk;
        sp.liquidity = 1e9;
        vm.startPrank(stranger, stranger);
        SeedPoolRecipe.seed(sc, sp);
        vm.stopPrank();
        uint128 liquidity = c.stateView.getLiquidity(p.poolId);
        assertGt(liquidity, 0);

        vm.startPrank(seeder, seeder);
        vm.expectRevert(abi.encodeWithSelector(SeedPoolRecipe.PoolNotEmpty.selector, junk, liquidity));
        this.seedExt(c, p);
        vm.stopPrank();
        assertEq(c.factory.balanceOf(seeder), 50_000_000e18 - 1_000e18, "nothing moved");
    }

    function test_fork_priceSetterCannotTrade() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("setter");
        if (!forked) return vm.skip(true);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        vm.startPrank(seeder, seeder);
        SeedPoolRecipe.seed(c, p);
        vm.stopPrank();
        V4PriceSetter setter = new V4PriceSetter(IV4PoolManager(c.poolManager));
        vm.expectRevert();
        setter.setPrice(p.key, p.sqrtPriceX96 / 2, true);
        vm.expectRevert(V4PriceSetter.NotPoolManager.selector);
        setter.unlockCallback("");
    }

    function seedExt(SeedPoolRecipe.Config memory c, SeedPoolRecipe.Plan memory p) external returns (uint256) {
        return SeedPoolRecipe.seed(c, p);
    }

    function test_check_positionOwnerUnsetFailsClosed() public {
        (bool forked, SeedPoolRecipe.Config memory c) = _setUp("owner");
        if (!forked) return vm.skip(true);
        c.positionOwner = address(0);
        vm.expectRevert(abi.encodeWithSelector(SeedPoolRecipe.BadConfig.selector, "positionOwner unset"));
        this.checkExt(c);
    }

    function checkExt(SeedPoolRecipe.Config memory c) external view {
        SeedPoolRecipe.check(c);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SeedPoolRecipe} from "../../script/SeedPoolRecipe.sol";
import {PoolKey, IV4PoolManager, IV4PositionManager, IV4StateView} from "../../src/sidequest/SeedHelper.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {V4SwapHelper} from "../../src/testnet/V4SwapHelper.sol";

contract ForkSide is ERC20 {
    constructor(address to) ERC20("Fork SIDE", "SIDE") {
        _mint(to, 100_000_000e18);
    }
}

/// @dev The testnet Buy path on a local fork of Monad testnet (nothing is sent): seed a fresh SIDE/mUSD pool on the
///      live Uniswap v4 contracts with the launch recipe at $0.0001, then quote and swap both ways through
///      `V4SwapHelper`. Skipped unless MONAD_TESTNET_RPC_URL is set.
contract V4SwapHelperForkTest is Test {
    address constant POOL_MANAGER = 0x451D64ab3b650040d2aE1886602b97ed6eDc643d;
    address constant POSITION_MANAGER = 0x3Bb14E3D0Cd50aBe3EdACa06d06c29C78676C31A;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant STATE_VIEW = 0xB639209539c61BaF67AC04876315786F8D0b153c;
    address safe = makeAddr("pool-safe");
    address seeder = makeAddr("seeder");
    address buyer = makeAddr("buyer");
    ForkSide side;
    MockPaymentToken usd;
    V4SwapHelper helper;
    SeedPoolRecipe.Plan p;
    bool sideIs0;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        vm.etch(safe, hex"00");
        side = new ForkSide(seeder);
        usd = new MockPaymentToken("Fork USD", "mUSD");
        usd.mint(seeder, 2_000e6);
        SeedPoolRecipe.Config memory c = SeedPoolRecipe.Config({
            poolManager: POOL_MANAGER,
            positionManager: IV4PositionManager(POSITION_MANAGER),
            permit2: PERMIT2,
            stateView: IV4StateView(STATE_VIEW),
            factory: IERC20(address(side)),
            quote: IERC20(address(usd)),
            fee: 3000,
            tickSpacing: 60,
            factoryAmount: 10_000_000e18,
            quoteAmount: 1_000e6,
            maxRepairCost: 5e6,
            positionOwner: safe,
            safe: safe
        });
        SeedPoolRecipe.check(c);
        p = SeedPoolRecipe.plan(c);
        vm.startPrank(seeder);
        SeedPoolRecipe.seed(c, p);
        vm.stopPrank();
        sideIs0 = p.key.currency0 == address(side);
        helper = new V4SwapHelper(IV4PoolManager(POOL_MANAGER));
        usd.mint(buyer, 100e6);
    }

    modifier forked() {
        if (address(helper) == address(0)) return;
        _;
    }

    function test_buySide_withMusd_atTheSeedPrice_matchingTheQuote() public forked {
        bool zeroForOne = !sideIs0; // mUSD in
        (uint256 quotedIn, uint256 quotedOut) = helper.quoteExactIn(p.key, zeroForOne, 10e6);
        assertEq(quotedIn, 10e6);
        // 10 mUSD at $0.0001 is 100,000 SIDE, less the 0.3% fee and a little impact on a $1,000 pool.
        assertGt(quotedOut, 98_000e18);
        assertLt(quotedOut, 99_700e18);
        vm.startPrank(buyer);
        usd.approve(address(helper), 10e6);
        uint256 out = helper.swapExactIn(p.key, zeroForOne, 10e6, quotedOut, buyer, block.timestamp);
        vm.stopPrank();
        assertEq(out, quotedOut);
        assertEq(side.balanceOf(buyer), out);
        assertEq(usd.balanceOf(buyer), 90e6);
        assertEq(usd.balanceOf(address(helper)), 0);
        assertEq(side.balanceOf(address(helper)), 0);
    }

    function test_sellSide_backToMusd() public forked {
        vm.prank(seeder);
        side.transfer(buyer, 50_000e18);
        (, uint256 quotedOut) = helper.quoteExactIn(p.key, sideIs0, 50_000e18);
        assertGt(quotedOut, 4.9e6);
        vm.startPrank(buyer);
        side.approve(address(helper), 50_000e18);
        helper.swapExactIn(p.key, sideIs0, 50_000e18, quotedOut, buyer, block.timestamp);
        vm.stopPrank();
        assertEq(usd.balanceOf(buyer), 100e6 + quotedOut);
    }

    function test_refuses_slippage_deadline_andUnapprovedInput() public forked {
        bool zeroForOne = !sideIs0;
        (, uint256 quotedOut) = helper.quoteExactIn(p.key, zeroForOne, 10e6);
        vm.startPrank(buyer);
        usd.approve(address(helper), 10e6);
        vm.expectRevert(abi.encodeWithSelector(V4SwapHelper.TooLittleReceived.selector, quotedOut, quotedOut + 1));
        helper.swapExactIn(p.key, zeroForOne, 10e6, quotedOut + 1, buyer, block.timestamp);
        vm.expectRevert(V4SwapHelper.Expired.selector);
        helper.swapExactIn(p.key, zeroForOne, 10e6, 0, buyer, block.timestamp - 1);
        usd.approve(address(helper), 0);
        vm.expectRevert();
        helper.swapExactIn(p.key, zeroForOne, 10e6, 0, buyer, block.timestamp);
        vm.stopPrank();
        vm.expectRevert(V4SwapHelper.NotPoolManager.selector);
        helper.unlockCallback("");
    }

    function test_constructor_refusesMainnet() public {
        vm.chainId(143);
        vm.expectRevert(V4SwapHelper.MainnetRefused.selector);
        new V4SwapHelper(IV4PoolManager(POOL_MANAGER));
    }
}

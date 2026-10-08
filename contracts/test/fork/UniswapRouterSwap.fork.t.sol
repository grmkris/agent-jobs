// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SeedPoolRecipe} from "../../script/SeedPoolRecipe.sol";
import {PoolKey, IV4PositionManager, IV4StateView, IV4Permit2} from "../../src/sidequest/SeedHelper.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

/// @dev The original v4-periphery ExactInputSingleParams (Monad mainnet's UniversalRouter).
struct ExactInputSingle {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/// @dev The newer layout with a per-hop price floor (Monad testnet's UniversalRouter).
struct ExactInputSingleMinHop {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

contract ForkStake is ERC20 {
    constructor(address to) ERC20("Fork SIDE", "SIDE") {
        _mint(to, 100_000_000e18);
    }
}

/// @dev Explore's Buy (packages/sdk/src/market.ts) swaps through Uniswap's own UniversalRouter: approve Permit2,
///      Permit2 allowance to the router, execute(V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL). The two Monad
///      routers are different builds and take different ExactInputSingleParams; this pins which layout each takes
///      (config `liquidity.uniswapV4.minHopPrice`). Local forks only, nothing is sent; skipped without the RPC URLs.
contract UniswapRouterSwapForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address buyer = makeAddr("buyer");

    function _swap(
        address router,
        PoolKey memory key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minOut,
        bytes memory single
    ) internal returns (bool ok) {
        (address currencyIn, address currencyOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes[] memory params = new bytes[](3);
        params[0] = single;
        params[1] = abi.encode(currencyIn, uint256(amountIn));
        params[2] = abi.encode(currencyOut, uint256(minOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        vm.startPrank(buyer);
        IERC20(currencyIn).approve(PERMIT2, amountIn);
        IV4Permit2(PERMIT2).approve(currencyIn, router, amountIn, uint48(block.timestamp + 1800));
        (ok,) = router.call(abi.encodeCall(IUniversalRouter.execute, (hex"10", inputs, block.timestamp + 600)));
        vm.stopPrank();
    }

    function _quote(address quoter, PoolKey memory key, bool zeroForOne, uint128 amountIn)
        internal
        returns (uint256 out)
    {
        (out,) = IV4Quoter(quoter)
            .quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, zeroForOne, amountIn, ""));
    }

    /// @dev The live seeded SIDE/mUSD pool (position #78) through the testnet router: only the min-hop layout works.
    function test_fork_testnet_routerTakesMinHopLayout() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return vm.skip(true);
        vm.createSelectFork(rpc);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        address router = vm.parseJsonAddress(json, ".liquidity.uniswapV4.universalRouter");
        address quoter = vm.parseJsonAddress(json, ".liquidity.uniswapV4.quoter");
        assertTrue(vm.parseJsonBool(json, ".liquidity.uniswapV4.minHopPrice"));
        address side = vm.parseJsonAddress(json, ".deployment.factory");
        address usd = vm.parseJsonAddress(json, ".liquidity.quote");
        PoolKey memory key = PoolKey(usd < side ? usd : side, usd < side ? side : usd, 3000, 60, address(0));
        bool zeroForOne = key.currency0 == usd;
        deal(usd, buyer, 10e6);
        uint256 quoted = _quote(quoter, key, zeroForOne, 2e6);
        assertFalse(
            _swap(router, key, zeroForOne, 2e6, 1, abi.encode(ExactInputSingle(key, zeroForOne, 2e6, 1, ""))),
            "the original layout is refused"
        );
        assertTrue(
            _swap(
                router,
                key,
                zeroForOne,
                2e6,
                uint128(quoted),
                abi.encode(ExactInputSingleMinHop(key, zeroForOne, 2e6, uint128(quoted), 0, ""))
            )
        );
        assertEq(IERC20(side).balanceOf(buyer), quoted);
        assertEq(IERC20(usd).balanceOf(buyer), 8e6);
    }

    /// @dev Mainnet's router on a SIDE/USDC pool seeded like the launch ($0.0001), with a stand-in SIDE: the original
    ///      layout swaps exactly the quote and enforces minOut; the min-hop layout does not swap.
    function test_fork_mainnet_routerTakesOriginalLayout() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return vm.skip(true);
        vm.createSelectFork(rpc);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        address safe = makeAddr("pool-safe");
        address seeder = makeAddr("seeder");
        vm.etch(safe, hex"00");
        ForkStake side = new ForkStake(seeder);
        address usdc = vm.parseJsonAddress(json, ".liquidity.quote");
        deal(usdc, seeder, 1_000e6);
        SeedPoolRecipe.Config memory c = SeedPoolRecipe.Config({
            poolManager: vm.parseJsonAddress(json, ".liquidity.uniswapV4.poolManager"),
            positionManager: IV4PositionManager(vm.parseJsonAddress(json, ".liquidity.uniswapV4.positionManager")),
            permit2: PERMIT2,
            stateView: IV4StateView(vm.parseJsonAddress(json, ".liquidity.uniswapV4.stateView")),
            factory: IERC20(address(side)),
            quote: IERC20(usdc),
            fee: 3000,
            tickSpacing: 60,
            factoryAmount: 3_000_000e18,
            quoteAmount: 300e6,
            maxRepairCost: 5e6,
            positionOwner: safe,
            safe: safe
        });
        SeedPoolRecipe.check(c);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        vm.startPrank(seeder, seeder);
        SeedPoolRecipe.seed(c, p);
        vm.stopPrank();
        address router = 0x0D97Dc33264bfC1c226207428A79b26757fb9dc3;
        address quoter = 0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891;
        bool zeroForOne = p.key.currency0 == usdc;
        deal(usdc, buyer, 10e6);
        uint256 quoted = _quote(quoter, p.key, zeroForOne, 2e6);
        // 2 USDC at $0.0001 is 20,000 SIDE, less the 0.3% fee and impact on a $300 pool.
        assertGt(quoted, 19_500e18);
        assertLt(quoted, 19_940e18);
        assertFalse(
            _swap(
                router, p.key, zeroForOne, 2e6, 1, abi.encode(ExactInputSingleMinHop(p.key, zeroForOne, 2e6, 1, 0, ""))
            ),
            "the min-hop layout is refused"
        );
        assertFalse(
            _swap(
                router,
                p.key,
                zeroForOne,
                2e6,
                uint128(quoted + 1),
                abi.encode(ExactInputSingle(p.key, zeroForOne, 2e6, uint128(quoted + 1), ""))
            ),
            "minOut above the quote is refused"
        );
        assertTrue(
            _swap(
                router,
                p.key,
                zeroForOne,
                2e6,
                uint128(quoted),
                abi.encode(ExactInputSingle(p.key, zeroForOne, 2e6, uint128(quoted), ""))
            )
        );
        assertEq(side.balanceOf(buyer), quoted);
        assertEq(IERC20(usdc).balanceOf(buyer), 8e6);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";

/// @dev Uniswap v4's pool key; `Currency` and `IHooks` are addresses in the ABI.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IV4PositionManager {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IV4Permit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IV4StateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    /// @dev Returns a `BalanceDelta` (two int128 packed in an int256).
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
}

/// @title V4PriceSetter
/// @notice C12 recovery, deployed by `SeedPoolRecipe.seed` only when needed: moves an *empty* pool's price to a target
///         with a 1-unit exact-input swap limited at that price. With no liquidity in the way nothing is exchanged, so
///         the swap must return a zero delta, or it reverts: it can move a price, never trade.
contract V4PriceSetter {
    IV4PoolManager public immutable poolManager;

    error NotPoolManager();
    error PoolNotEmpty(int256 delta);

    constructor(IV4PoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function setPrice(PoolKey calldata key, uint160 target, bool zeroForOne) external {
        poolManager.unlock(abi.encode(key, target, zeroForOne));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint160 target, bool zeroForOne) = abi.decode(data, (PoolKey, uint160, bool));
        int256 delta = poolManager.swap(key, SwapParams(zeroForOne, -1, target), "");
        if (delta != 0) revert PoolNotEmpty(delta);
        return "";
    }
}

/// @title SeedPoolRecipe
/// @notice C12: one full-range Uniswap v4 FACTORY/USDC position on Monad mainnet, created and funded in a single
///         PositionManager `multicall` (initialize the pool at the configured price, mint, settle through Permit2),
///         so nobody can initialize the pool at another price in between. Input: the `liquidity` block of
///         `config/monad-mainnet.json` (protocol addresses verified with `cast code`; amounts and owner are the
///         coordinator's); FACTORY from `deployment.hireling.factory`. The price is `quoteAmount / factoryAmount`
///         (3M FACTORY for $300 = $0.0001). The liquidity is computed from 99.99% of each amount with the amounts as
///         the caps, so the mint reverts if the pool's price differs from the configured one by more than that.
library SeedPoolRecipe {
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;
    int24 internal constant MAX_TICK = 887272;
    /// @dev The sqrt prices at ticks ±887272. Full-range ticks rounded to the spacing lie inside them, so liquidity
    ///      computed against these bounds never asks for more than the amounts.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 1 << 96;

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
        address positionOwner;
    }

    struct Plan {
        PoolKey key;
        bytes32 poolId;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0;
        uint256 amount1;
        uint256 liquidity;
    }

    error BadConfig(string what);
    error PoolPriceMismatch(uint160 current, uint160 expected);
    /// @dev The pool sits at another price and holds liquidity: moving it would trade against someone.
    error PoolNotEmpty(uint160 current, uint128 liquidity);

    function load(Vm vm, string memory json) internal view returns (Config memory c) {
        c.poolManager = vm.parseJsonAddress(json, ".liquidity.uniswapV4.poolManager");
        c.positionManager = IV4PositionManager(vm.parseJsonAddress(json, ".liquidity.uniswapV4.positionManager"));
        c.permit2 = vm.parseJsonAddress(json, ".liquidity.uniswapV4.permit2");
        c.stateView = IV4StateView(vm.parseJsonAddress(json, ".liquidity.uniswapV4.stateView"));
        c.factory = IERC20(vm.parseJsonAddress(json, ".deployment.hireling.factory"));
        c.quote = IERC20(vm.parseJsonAddress(json, ".liquidity.quote"));
        c.fee = uint24(vm.parseJsonUint(json, ".liquidity.fee"));
        c.tickSpacing = int24(int256(vm.parseJsonUint(json, ".liquidity.tickSpacing")));
        c.factoryAmount = vm.parseJsonUint(json, ".liquidity.factoryAmount") * 1e18;
        c.quoteAmount = vm.parseJsonUint(json, ".liquidity.quoteAmount") * 10 ** IERC20Metadata(address(c.quote)).decimals();
        c.positionOwner = vm.parseJsonAddress(json, ".liquidity.positionOwner");
    }

    function check(Config memory c) internal view {
        if (c.positionOwner == address(0)) revert BadConfig("positionOwner unset");
        if (c.factoryAmount == 0 || c.quoteAmount == 0) revert BadConfig("zero amount");
        if (c.tickSpacing <= 0 || c.fee > 1_000_000) revert BadConfig("fee or tickSpacing");
        address[5] memory needCode = [
            c.poolManager, address(c.positionManager), c.permit2, address(c.stateView), address(c.factory)
        ];
        for (uint256 i; i < needCode.length; ++i) {
            if (needCode[i].code.length == 0) revert BadConfig("no code at a configured address");
        }
        if (address(c.quote).code.length == 0) revert BadConfig("no code at the quote token");
        if (c.positionManager.poolManager() != c.poolManager) revert BadConfig("positionManager.poolManager");
        if (c.positionManager.permit2() != c.permit2) revert BadConfig("positionManager.permit2");
        if (IERC20Metadata(address(c.factory)).decimals() != 18) revert BadConfig("factory decimals");
    }

    function plan(Config memory c) internal pure returns (Plan memory p) {
        bool factoryFirst = address(c.factory) < address(c.quote);
        (address c0, address c1) =
            factoryFirst ? (address(c.factory), address(c.quote)) : (address(c.quote), address(c.factory));
        (p.amount0, p.amount1) = factoryFirst ? (c.factoryAmount, c.quoteAmount) : (c.quoteAmount, c.factoryAmount);
        p.key = PoolKey(c0, c1, c.fee, c.tickSpacing, address(0));
        p.poolId = keccak256(abi.encode(p.key));
        // price = amount1 / amount0 in raw units; sqrtPriceX96 = sqrt(price) * 2^96.
        p.sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(p.amount1, 1 << 192, p.amount0)));
        p.tickUpper = (MAX_TICK / c.tickSpacing) * c.tickSpacing;
        p.tickLower = -p.tickUpper;
        uint256 a0 = p.amount0 * 9999 / 10_000;
        uint256 a1 = p.amount1 * 9999 / 10_000;
        uint256 l0 = Math.mulDiv(
            a0, Math.mulDiv(p.sqrtPriceX96, MAX_SQRT_PRICE, Q96), uint256(MAX_SQRT_PRICE) - p.sqrtPriceX96
        );
        uint256 l1 = Math.mulDiv(a1, Q96, uint256(p.sqrtPriceX96) - MIN_SQRT_PRICE);
        p.liquidity = Math.min(l0, l1);
    }

    /// @notice Approves exactly the two amounts through Permit2 and sends the one `multicall`, from the caller's
    ///         context (the broadcaster, who holds both tokens). Returns the position's token id.
    ///
    ///         Recovery: anyone can initialize this pool at a junk price before the seed. If it holds no liquidity, a
    ///         `V4PriceSetter` moves its price to the target first, for free; if it holds liquidity it is refused.
    ///         Between the two transactions the mint caps still refuse any other price; re-run if that happens.
    function seed(Config memory c, Plan memory p) internal returns (uint256 tokenId) {
        (uint160 current,,,) = c.stateView.getSlot0(p.poolId);
        if (current != 0 && current != p.sqrtPriceX96) {
            uint128 liquidity = c.stateView.getLiquidity(p.poolId);
            if (liquidity != 0) revert PoolNotEmpty(current, liquidity);
            V4PriceSetter setter = new V4PriceSetter(IV4PoolManager(c.poolManager));
            setter.setPrice(p.key, p.sqrtPriceX96, p.sqrtPriceX96 < current);
            (current,,,) = c.stateView.getSlot0(p.poolId);
            if (current != p.sqrtPriceX96) revert PoolPriceMismatch(current, p.sqrtPriceX96);
        }
        uint48 expiration = uint48(block.timestamp + 1 hours);
        IERC20(p.key.currency0).approve(c.permit2, p.amount0);
        IERC20(p.key.currency1).approve(c.permit2, p.amount1);
        IV4Permit2(c.permit2).approve(p.key.currency0, address(c.positionManager), uint160(p.amount0), expiration);
        IV4Permit2(c.permit2).approve(p.key.currency1, address(c.positionManager), uint160(p.amount1), expiration);

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            p.key, p.tickLower, p.tickUpper, p.liquidity, uint128(p.amount0), uint128(p.amount1), c.positionOwner, ""
        );
        params[1] = abi.encode(p.key.currency0, p.key.currency1);
        bytes memory unlockData = abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IV4PositionManager.initializePool, (p.key, p.sqrtPriceX96));
        calls[1] = abi.encodeCall(IV4PositionManager.modifyLiquidities, (unlockData, block.timestamp + 1 hours));
        tokenId = c.positionManager.nextTokenId();
        c.positionManager.multicall(calls);
    }

    function verify(Config memory c, Plan memory p, uint256 tokenId) internal view {
        (uint160 current,,,) = c.stateView.getSlot0(p.poolId);
        if (current != p.sqrtPriceX96) revert PoolPriceMismatch(current, p.sqrtPriceX96);
        if (c.positionManager.ownerOf(tokenId) != c.positionOwner) revert BadConfig("position owner");
        if (c.positionManager.getPositionLiquidity(tokenId) != p.liquidity) revert BadConfig("position liquidity");
    }
}

/// @notice Run by the coordinator, from the account holding the liquidity allocation and the USDC:
///
///         NETWORK=monad-mainnet MAINNET_GO=yes forge script script/SeedPool.s.sol --rpc-url $MONAD_MAINNET_RPC_URL \
///           --private-key $LIQUIDITY_PRIVATE_KEY --broadcast
///
///         Without `--broadcast` it is a dry run. Rehearsed on a mainnet fork (`test/fork/SeedPoolRehearsal.t.sol`).
contract SeedPool is Script {
    function run() external {
        string memory json = vm.readFile(HirelingRecipe.path(vm, vm.envString("NETWORK")));
        HirelingRecipe.guardChain(vm, json, true);
        SeedPoolRecipe.Config memory c = SeedPoolRecipe.load(vm, json);
        SeedPoolRecipe.check(c);
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        vm.startBroadcast();
        uint256 tokenId = SeedPoolRecipe.seed(c, p);
        vm.stopBroadcast();
        SeedPoolRecipe.verify(c, p, tokenId);
        console2.log("pool id");
        console2.logBytes32(p.poolId);
        console2.log("position token id", tokenId);
        console2.log("liquidity", p.liquidity);
    }
}

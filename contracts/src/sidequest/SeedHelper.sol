// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Uniswap v4's pool key; `Currency` and `IHooks` are addresses in the ABI.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IV4PoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    /// @dev Returns a `BalanceDelta` (two int128 packed in an int256).
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
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
    /// @dev `info` packs `poolId (200 bits) | tickUpper (24) | tickLower (24) | hasSubscriber (8)`.
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory key, uint256 info);
}

interface IV4Permit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IV4StateView {
    function poolManager() external view returns (address);
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity);
}

/// @title SeedHelper
/// @notice The launch's liquidity seed (C12, review C12-002) as one transaction. The seeder deploys it with the plan,
///         approves it the exact amounts (seed amount + repair cap, per token), and calls `seed()`, which in that call:
///         1. pulls both approvals in full;
///         2. puts the pool at the target price: initializes it if nobody has; if someone initialized it at another
///            price, swaps it to the target (exact input, limited at the target). An empty pool moves for free.
///            Liquidity in the way, in range or out of range, is traded through, up to the repair cap of the input
///            token: `maxRepairCost` quote units, or the same value in SIDE at the target price. Every such trade
///            buys below the target price or sells above it, so the attacker pays for it. If the cap runs out before
///            the target, the seed reverts, and the coordinator switches to the fallback pool key (SURFACE).
///         3. mints the full-range position to `owner` (the Safe) through the PositionManager and Permit2;
///         4. clears every allowance it gave and returns everything it still holds to the seeder.
///         Only the seeder can call `seed()`, once. Afterwards the helper holds no tokens and no allowances, and the
///         seeder's allowances to it are spent.
contract SeedHelper {
    using SafeERC20 for IERC20;

    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;

    struct Plan {
        PoolKey key;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        /// @dev Caps on what the mint may take.
        uint128 amount0;
        uint128 amount1;
        /// @dev The most the repair swap may spend of each token (it spends only the input token).
        uint128 repairMax0;
        uint128 repairMax1;
        /// @dev Receives the position NFT: the protocol Safe, so it must have code.
        address owner;
    }

    IV4PositionManager public immutable positionManager;
    IV4PoolManager public immutable poolManager;
    address public immutable permit2;
    IV4StateView public immutable stateView;
    address public immutable seeder;
    bool public seeded;
    Plan internal _plan;

    event Repaired(uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96, int256 amount0, int256 amount1);
    event Seeded(
        uint256 indexed tokenId,
        address indexed owner,
        bytes32 indexed poolId,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );

    error NotSeeder();
    error AlreadySeeded();
    error NotPoolManager();
    error BadPlan(string what);
    error PriceNotSet(uint160 current, uint160 target);
    error ShortTransfer(address token);
    error WrongPosition(uint256 tokenId);

    constructor(IV4PositionManager positionManager_, IV4StateView stateView_, Plan memory plan_) {
        if (plan_.owner.code.length == 0) revert BadPlan("owner without code");
        if (plan_.repairMax0 == 0 || plan_.repairMax1 == 0) revert BadPlan("zero repair cap");
        if (plan_.key.currency0 >= plan_.key.currency1 || plan_.key.hooks != address(0)) revert BadPlan("pool key");
        positionManager = positionManager_;
        poolManager = IV4PoolManager(positionManager_.poolManager());
        permit2 = positionManager_.permit2();
        stateView = stateView_;
        seeder = msg.sender;
        _plan = plan_;
    }

    function plan() external view returns (Plan memory) {
        return _plan;
    }

    function seed() external returns (uint256 tokenId) {
        if (msg.sender != seeder) revert NotSeeder();
        if (seeded) revert AlreadySeeded();
        seeded = true;
        Plan memory p = _plan;
        IERC20 t0 = IERC20(p.key.currency0);
        IERC20 t1 = IERC20(p.key.currency1);
        _pull(t0, uint256(p.amount0) + p.repairMax0);
        _pull(t1, uint256(p.amount1) + p.repairMax1);

        bytes32 poolId = keccak256(abi.encode(p.key));
        (uint160 current,,,) = stateView.getSlot0(poolId);
        if (current == 0) {
            poolManager.initialize(p.key, p.sqrtPriceX96);
        } else if (current != p.sqrtPriceX96) {
            poolManager.unlock(abi.encode(p.key, p.sqrtPriceX96, current, p.repairMax0, p.repairMax1));
        }
        (current,,,) = stateView.getSlot0(poolId);
        if (current != p.sqrtPriceX96) revert PriceNotSet(current, p.sqrtPriceX96);

        uint256 before0 = t0.balanceOf(address(this));
        uint256 before1 = t1.balanceOf(address(this));
        t0.forceApprove(permit2, p.amount0);
        t1.forceApprove(permit2, p.amount1);
        IV4Permit2(permit2).approve(address(t0), address(positionManager), p.amount0, uint48(block.timestamp));
        IV4Permit2(permit2).approve(address(t1), address(positionManager), p.amount1, uint48(block.timestamp));
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(p.key, p.tickLower, p.tickUpper, uint256(p.liquidity), p.amount0, p.amount1, p.owner, bytes(""));
        params[1] = abi.encode(address(t0), address(t1));
        // Read and minted inside one transaction, so nobody else's mint can take this id.
        tokenId = positionManager.nextTokenId();
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), block.timestamp
        );
        if (positionManager.ownerOf(tokenId) != p.owner || positionManager.getPositionLiquidity(tokenId) != p.liquidity)
        {
            revert WrongPosition(tokenId);
        }
        uint256 used0 = before0 - t0.balanceOf(address(this));
        uint256 used1 = before1 - t1.balanceOf(address(this));

        IV4Permit2(permit2).approve(address(t0), address(positionManager), 0, 0);
        IV4Permit2(permit2).approve(address(t1), address(positionManager), 0, 0);
        t0.forceApprove(permit2, 0);
        t1.forceApprove(permit2, 0);
        uint256 left0 = t0.balanceOf(address(this));
        uint256 left1 = t1.balanceOf(address(this));
        if (left0 != 0) t0.safeTransfer(seeder, left0);
        if (left1 != 0) t1.safeTransfer(seeder, left1);
        emit Seeded(tokenId, p.owner, poolId, current, p.liquidity, used0, used1);
    }

    /// @dev The repair: an exact-input swap of the input token's cap, limited at the target. It stops at the target
    ///      with the rest of the cap unspent, or spends the whole cap short of it (`seed` then reverts). Pays the pool
    ///      from the helper's balance and takes what it bought.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint160 target, uint160 from, uint128 max0, uint128 max1) =
            abi.decode(data, (PoolKey, uint160, uint160, uint128, uint128));
        bool zeroForOne = target < from;
        int256 delta =
            poolManager.swap(key, SwapParams(zeroForOne, -int256(uint256(zeroForOne ? max0 : max1)), target), "");
        int256 d0 = delta >> 128;
        int256 d1 = int256(int128(delta));
        _square(key.currency0, d0);
        _square(key.currency1, d1);
        emit Repaired(from, target, d0, d1);
        return "";
    }

    /// @dev Settles the helper's side of one currency: pays what it owes (negative), takes what it is owed.
    function _square(address currency, int256 d) private {
        if (d < 0) {
            poolManager.sync(currency);
            IERC20(currency).safeTransfer(address(poolManager), uint256(-d));
            poolManager.settle();
        } else if (d > 0) {
            poolManager.take(currency, address(this), uint256(d));
        }
    }

    /// @dev Pulls exactly `amount`, refusing a token that delivers less.
    function _pull(IERC20 token, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(seeder, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert ShortTransfer(address(token));
    }
}

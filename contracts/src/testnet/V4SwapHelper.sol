// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolKey, SwapParams, IV4PoolManager} from "../sidequest/SeedHelper.sol";

/// @title V4SwapHelper
/// @notice **Testnet only, never deployed on mainnet** (mainnet swaps go through Uniswap's own UniversalRouter and
///         V4Quoter, which Monad testnet does not have). An exact-input single-pool ERC-20 swap on Uniswap v4 for
///         Explore's Buy: the caller approves this helper the input token, names the least it accepts and a deadline,
///         and receives the output. `quoteExactIn` runs the same swap and reverts with its result, so an
///         `eth_call` reads the price. The helper holds nothing between calls.
contract V4SwapHelper {
    using SafeERC20 for IERC20;

    /// @dev Just inside the v4 price bounds: a swap stops only for want of liquidity, never at a limit.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    IV4PoolManager public immutable poolManager;

    struct Call {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        address payer;
        address to;
        bool quote;
    }

    event Swapped(address indexed payer, address indexed to, bytes32 indexed poolId, uint256 amountIn, uint256 amountOut);

    error MainnetRefused();
    error NotPoolManager();
    error Expired();
    error TooLittleReceived(uint256 amountOut, uint256 minOut);
    error NativeUnsupported();
    error QuoteResult(uint256 amountIn, uint256 amountOut);

    constructor(IV4PoolManager poolManager_) {
        if (block.chainid == 143) revert MainnetRefused();
        poolManager = poolManager_;
    }

    /// @notice Spends `amountIn` of the input token (less only if the pool runs out of liquidity) from the caller and
    ///         sends at least `minOut` of the other to `to`.
    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (key.currency0 == address(0)) revert NativeUnsupported();
        (uint256 spent, uint256 out) = abi.decode(
            poolManager.unlock(abi.encode(Call(key, zeroForOne, amountIn, msg.sender, to, false))), (uint256, uint256)
        );
        if (out < minOut) revert TooLittleReceived(out, minOut);
        emit Swapped(msg.sender, to, keccak256(abi.encode(key)), spent, out);
        return out;
    }

    /// @notice What `swapExactIn` would spend and return now. Not a view (it runs the swap and reverts); call it with
    ///         `eth_call`.
    function quoteExactIn(PoolKey calldata key, bool zeroForOne, uint128 amountIn)
        external
        returns (uint256 amountInUsed, uint256 amountOut)
    {
        try poolManager.unlock(abi.encode(Call(key, zeroForOne, amountIn, address(0), address(0), true))) {}
        catch (bytes memory reason) {
            if (reason.length == 68 && bytes4(reason) == QuoteResult.selector) {
                assembly {
                    amountInUsed := mload(add(reason, 36))
                    amountOut := mload(add(reason, 68))
                }
                return (amountInUsed, amountOut);
            }
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Call memory c = abi.decode(data, (Call));
        int256 delta = poolManager.swap(
            c.key,
            SwapParams(
                c.zeroForOne,
                -int256(uint256(c.amountIn)),
                c.zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
            ),
            ""
        );
        int256 d0 = delta >> 128;
        int256 d1 = int256(int128(delta));
        (int256 dIn, int256 dOut) = c.zeroForOne ? (d0, d1) : (d1, d0);
        uint256 spent = dIn < 0 ? uint256(-dIn) : 0;
        uint256 out = dOut > 0 ? uint256(dOut) : 0;
        if (c.quote) revert QuoteResult(spent, out);
        (address input, address output) = c.zeroForOne ? (c.key.currency0, c.key.currency1) : (c.key.currency1, c.key.currency0);
        if (spent != 0) {
            poolManager.sync(input);
            IERC20(input).safeTransferFrom(c.payer, address(poolManager), spent);
            poolManager.settle();
        }
        if (out != 0) poolManager.take(output, c.to, out);
        return abi.encode(spent, out);
    }
}

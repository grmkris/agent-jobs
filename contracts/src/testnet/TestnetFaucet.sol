// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IMintablePaymentToken {
    function mint(address to, uint256 amount) external;
}

/// @title TestnetFaucet
/// @notice **Testnet only, never deployed on mainnet.** One claim gives an address the stake token (SIDE, transferred
///         from this faucet's funded balance, since SIDE has a fixed supply) and each testnet payment token (minted:
///         `MockPaymentToken.mint` is open), at most once per `COOLDOWN`. Anyone may claim for any address, so a relay
///         can pay the gas for a wallet that holds no MON; the cooldown is per recipient. Test tokens have no value.
contract TestnetFaucet is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant COOLDOWN = 1 days;

    IERC20 public immutable stakeToken;
    address[] internal _paymentTokens;
    uint256 public stakeAmount;
    uint256 public paymentAmount;
    mapping(address recipient => uint256 claimedAt) public lastDrip;

    event Dripped(address indexed to, address indexed caller, uint256 stakeAmount, uint256 paymentAmount);
    event AmountsSet(uint256 stakeAmount, uint256 paymentAmount);

    error ZeroRecipient();
    error CoolingDown(uint256 nextAt);
    error FaucetEmpty(uint256 balance);
    error MainnetRefused();

    constructor(address owner_, IERC20 stakeToken_, address[] memory paymentTokens_, uint256 stakeAmount_, uint256 paymentAmount_)
        Ownable(owner_)
    {
        if (block.chainid == 143) revert MainnetRefused();
        stakeToken = stakeToken_;
        _paymentTokens = paymentTokens_;
        stakeAmount = stakeAmount_;
        paymentAmount = paymentAmount_;
        emit AmountsSet(stakeAmount_, paymentAmount_);
    }

    function paymentTokens() external view returns (address[] memory) {
        return _paymentTokens;
    }

    /// @notice When `to` may claim next; zero means now.
    function nextDripAt(address to) public view returns (uint256) {
        uint256 last = lastDrip[to];
        if (last == 0 || block.timestamp >= last + COOLDOWN) return 0;
        return last + COOLDOWN;
    }

    function drip(address to) external {
        if (to == address(0)) revert ZeroRecipient();
        uint256 next = nextDripAt(to);
        if (next != 0) revert CoolingDown(next);
        uint256 balance = stakeToken.balanceOf(address(this));
        if (balance < stakeAmount) revert FaucetEmpty(balance);
        lastDrip[to] = block.timestamp;
        stakeToken.safeTransfer(to, stakeAmount);
        for (uint256 i; i < _paymentTokens.length; ++i) {
            IMintablePaymentToken(_paymentTokens[i]).mint(to, paymentAmount);
        }
        emit Dripped(to, msg.sender, stakeAmount, paymentAmount);
    }

    function setAmounts(uint256 stakeAmount_, uint256 paymentAmount_) external onlyOwner {
        stakeAmount = stakeAmount_;
        paymentAmount = paymentAmount_;
        emit AmountsSet(stakeAmount_, paymentAmount_);
    }

    /// @notice Return the faucet's stake tokens (or anything sent here by mistake) to the owner's choice of address.
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}

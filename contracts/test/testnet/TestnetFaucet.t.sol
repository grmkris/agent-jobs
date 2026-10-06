// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {TestnetFaucet} from "../../src/testnet/TestnetFaucet.sol";

contract StakeStandIn is ERC20 {
    constructor(address to) ERC20("Stake", "SIDE") {
        _mint(to, 10_000e18);
    }
}

contract TestnetFaucetTest is Test {
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address relay = makeAddr("relay");
    StakeStandIn side;
    MockPaymentToken usd;
    MockPaymentToken eur;
    TestnetFaucet faucet;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_790_000_000);
        side = new StakeStandIn(owner);
        usd = new MockPaymentToken("USD", "mUSD");
        eur = new MockPaymentToken("EUR", "mEUR");
        faucet = new TestnetFaucet(owner, IERC20(address(side)), tokens(), 1_000e18, 1_000e6);
        vm.prank(owner);
        side.transfer(address(faucet), 3_500e18);
    }

    function tokens() internal view returns (address[] memory list) {
        list = new address[](2);
        (list[0], list[1]) = (address(usd), address(eur));
    }

    function test_drip_givesEveryTokenOnce_anyoneMayPayTheGas() public {
        vm.prank(relay);
        faucet.drip(alice);
        assertEq(side.balanceOf(alice), 1_000e18);
        assertEq(usd.balanceOf(alice), 1_000e6);
        assertEq(eur.balanceOf(alice), 1_000e6);
        assertEq(faucet.lastDrip(alice), block.timestamp);
        assertEq(faucet.nextDripAt(alice), block.timestamp + 1 days);
        assertEq(side.balanceOf(relay), 0);
    }

    function test_drip_coolsDownPerRecipient() public {
        faucet.drip(alice);
        uint256 next = block.timestamp + 1 days;
        vm.warp(next - 1);
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucet.CoolingDown.selector, next));
        vm.prank(alice);
        faucet.drip(alice);
        faucet.drip(relay);
        vm.warp(next);
        assertEq(faucet.nextDripAt(alice), 0);
        faucet.drip(alice);
        assertEq(side.balanceOf(alice), 2_000e18);
    }

    function test_drip_refusesWhenEmpty_andZeroRecipient() public {
        faucet.drip(alice);
        faucet.drip(relay);
        faucet.drip(makeAddr("third"));
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucet.FaucetEmpty.selector, 500e18));
        faucet.drip(makeAddr("fourth"));
        vm.expectRevert(TestnetFaucet.ZeroRecipient.selector);
        faucet.drip(address(0));
    }

    function test_owner_setsAmounts_andWithdraws() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        faucet.setAmounts(1, 1);
        vm.startPrank(owner);
        faucet.setAmounts(10e18, 5e6);
        faucet.withdraw(IERC20(address(side)), owner, 3_000e18);
        vm.stopPrank();
        faucet.drip(alice);
        assertEq(side.balanceOf(alice), 10e18);
        assertEq(usd.balanceOf(alice), 5e6);
        assertEq(side.balanceOf(address(faucet)), 490e18);
    }

    function test_constructor_refusesMainnet() public {
        vm.chainId(143);
        vm.expectRevert(TestnetFaucet.MainnetRefused.selector);
        new TestnetFaucet(owner, IERC20(address(side)), tokens(), 1, 1);
    }
}

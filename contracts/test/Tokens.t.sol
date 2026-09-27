// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactoryToken} from "../src/FactoryToken.sol";
import {MockPaymentToken} from "../src/MockPaymentToken.sol";

/// @dev R114-09: the production FACTORY cannot enable a faucet; the testnet reward token is parameterised.
contract TokensTest is Test {
    address internal minter = makeAddr("minter");
    address internal anyone = makeAddr("anyone");

    function test_production_factoryHasNoFaucetAndCannotEnableOne() public {
        FactoryToken prod = new FactoryToken("Factory", "FACTORY", false, minter);
        assertFalse(prod.faucetEnabled());
        vm.prank(anyone);
        vm.expectRevert(FactoryToken.FaucetDisabled.selector);
        prod.faucet();
        vm.prank(anyone);
        vm.expectRevert(FactoryToken.NotMinter.selector);
        prod.mint(anyone, 1);
        vm.prank(minter);
        prod.mint(anyone, 5e18);
        assertEq(prod.totalSupply(), 5e18, "only the minter mints");
        // No function can switch it on: `faucetEnabled` is immutable and there is no setter.
        (bool ok,) = address(prod).call(abi.encodeWithSignature("setFaucetEnabled(bool)", true));
        assertFalse(ok);
    }

    function test_testnet_factoryFaucet() public {
        FactoryToken test = new FactoryToken("Factory (testnet)", "FACTORY", true, address(0));
        vm.prank(anyone);
        test.faucet();
        assertEq(test.balanceOf(anyone), test.FAUCET_AMOUNT());
        assertEq(test.decimals(), 18);
    }

    function test_testnet_rewardTokensAreParameterised() public {
        MockPaymentToken musd = new MockPaymentToken("Mock USD (testnet)", "mUSD");
        MockPaymentToken meur = new MockPaymentToken("Mock EUR (testnet)", "mEUR");
        assertEq(musd.symbol(), "mUSD");
        assertEq(meur.symbol(), "mEUR");
        assertEq(meur.decimals(), 6);
        vm.prank(anyone);
        meur.faucet();
        assertEq(meur.balanceOf(anyone), 1_000e6);
        assertEq(musd.balanceOf(anyone), 0);
    }
}

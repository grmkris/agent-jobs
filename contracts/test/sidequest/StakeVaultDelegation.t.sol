// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStakeVault} from "../../src/sidequest/interfaces/IStakeVault.sol";
import {StakeVaultFixture} from "./StakeVault.t.sol";

contract StakeVaultDelegationTest is StakeVaultFixture {
    address account = makeAddr("backed-agent");
    address account2 = makeAddr("other-agent");

    function _delegate(address delegator, address backed, uint256 assets) internal {
        vm.prank(delegator);
        vault.delegate(backed, assets);
    }

    function _queue(address delegator, address backed, uint256 shares) internal {
        vm.prank(delegator);
        vault.requestUndelegate(backed, shares);
    }

    function _withdraw(address delegator, address backed) internal returns (uint256 assets) {
        uint256 before = token.balanceOf(delegator);
        vm.prank(delegator);
        vault.withdraw(backed);
        return token.balanceOf(delegator) - before;
    }

    function _value(address backed, address delegator) internal view returns (uint256) {
        return vault.convertToAssets(backed, vault.positionOf(backed, delegator).shares);
    }

    function test_delegate_ownerCanExitButAccountCannotTakePosition() public {
        _delegate(alice, account, 100e18);
        assertEq(vault.stakeOf(account), 100e18);
        assertEq(vault.stakeOf(alice), 0);
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientShares.selector, 0, 1));
        vault.requestUndelegate(account, 1);
        _queue(alice, account, 100e18);
        vm.warp(t0 + vault.UNSTAKE_DELAY());
        assertEq(_withdraw(alice, account), 100e18);
        assertEq(token.balanceOf(account), 0);
        _assertConserved();
    }

    function test_delegateFor_payerIsNotDelegatorOrAccount() public {
        vm.prank(bob);
        vm.expectEmit(address(vault));
        emit IStakeVault.Delegated(account, alice, bob, 17, 17);
        vault.delegateFor(account, alice, 17);
        assertEq(vault.positionOf(account, alice).shares, 17);
        assertEq(vault.positionOf(account, bob).shares, 0);
        _queue(alice, account, 17);
        vm.warp(t0 + vault.UNSTAKE_DELAY());
        assertEq(_withdraw(alice, account), 17);
    }

    function test_delegateFor_additionDoesNotRestartQueueOrChangeOwner() public {
        _delegate(alice, account, 100);
        _queue(alice, account, 40);
        vm.warp(t0 + 1 days);
        vm.prank(bob);
        vault.delegateFor(account, alice, 20);
        IStakeVault.Position memory p = vault.positionOf(account, alice);
        assertEq(p.shares, 120);
        assertEq(p.queuedShares, 40);
        assertEq(p.unlockAt, t0 + 7 days);
        assertEq(vault.stakeOf(account), 80);
    }

    function test_delegate_poolsStayIsolated() public {
        _delegate(alice, account, 100);
        _delegate(alice, account2, 100);
        _reserve(holding, account, 80);
        vm.prank(holding);
        vault.slash(account, 80);
        assertEq(_value(account, alice), 20);
        assertEq(_value(account2, alice), 100);
        assertEq(vault.totalAssets(), 120);
        _assertConserved();
    }

    function test_delegate_zeroAddressesRejected() public {
        vm.startPrank(alice);
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        vault.delegate(address(0), 1);
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        vault.delegateFor(account, address(0), 1);
        vm.expectRevert(IStakeVault.ZeroAddress.selector);
        vault.delegateFor(address(0), bob, 1);
        vm.stopPrank();
    }

    function test_delegate_failedTransferRollsBackAllBooks() public {
        vm.startPrank(account);
        vm.expectRevert();
        vault.delegate(account, 1);
        vm.stopPrank();
        assertEq(vault.poolOf(account).shares, 0);
        assertEq(vault.positionOf(account, account).shares, 0);
        assertEq(vault.totalAssets(), 0);
    }

    function test_delegate_directTransfersCannotInflateSharePrice() public {
        _delegate(alice, account, 1);
        token.transfer(address(vault), 1_000e18);
        _delegate(bob, account, 1);
        assertEq(vault.positionOf(account, bob).shares, 1);
        assertEq(vault.convertToAssets(account, 1), 1);
        assertEq(vault.totalAssets(), 2);
        assertEq(token.balanceOf(address(vault)), 1_000e18 + 2);
    }

    function test_delegate_roundsSharesDownAfterSlash() public {
        _delegate(alice, account, 10);
        _reserve(holding, account, 4);
        vm.prank(holding);
        vault.slash(account, 4);
        assertEq(vault.convertToShares(account, 1), 1);
        assertEq(vault.convertToShares(account, 2), 3);
        _delegate(bob, account, 1);
        assertEq(vault.poolOf(account).assets, 7);
        assertEq(vault.poolOf(account).shares, 11);
        assertEq(_value(account, bob), 0, "dust rounds toward the pool");
        assertEq(_value(account, alice), 6);
    }

    function test_withdraw_dustAndFinalShareDrainExactAssets() public {
        _delegate(alice, account, 1);
        _delegate(bob, account, 2);
        _reserve(holding, account, 1);
        vm.prank(holding);
        vault.slash(account, 1);
        _queue(alice, account, 1);
        _queue(bob, account, 2);
        vm.warp(t0 + 7 days);
        assertEq(_withdraw(alice, account), 0);
        assertEq(_withdraw(bob, account), 2, "last shares take the remainder");
        assertEq(vault.poolOf(account).assets, 0);
        assertEq(vault.poolOf(account).shares, 0);
        _delegate(alice, account, 1);
        assertEq(vault.positionOf(account, alice).shares, 1, "empty pool returns to 1:1");
        _assertConserved();
    }

    function test_request_onlyOwnActiveSharesAndNonzero() public {
        _delegate(alice, account, 10);
        _queue(alice, account, 6);
        vm.startPrank(alice);
        vm.expectRevert(IStakeVault.ZeroShares.selector);
        vault.requestUndelegate(account, 0);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientShares.selector, 4, 5));
        vault.requestUndelegate(account, 5);
        vm.stopPrank();
        assertEq(vault.poolOf(account).queuedShares, 6);
    }

    function test_request_eventTracksWholeQueueAndCurrentValue() public {
        _delegate(alice, account, 100);
        _queue(alice, account, 10);
        _reserve(holding, account, 20);
        vm.prank(holding);
        vault.slash(account, 20);
        vm.warp(t0 + 1 days);
        vm.prank(alice);
        vm.expectEmit(address(vault));
        emit IStakeVault.UndelegateRequested(account, alice, 20, 16, 30, uint48(t0 + 8 days));
        vault.requestUndelegate(account, 20);
        assertEq(vault.stakeOf(account), 56);
    }

    function test_cancel_eventRestoresSlashedActiveValue() public {
        _delegate(alice, account, 100);
        _reserve(holding, account, 20);
        _queue(alice, account, 30);
        vm.prank(holding);
        vault.slash(account, 20);
        vm.prank(alice);
        vm.expectEmit(address(vault));
        emit IStakeVault.UndelegateCancelled(account, alice, 30, 24);
        vault.cancelUndelegate(account);
        assertEq(vault.stakeOf(account), 80);
        assertEq(vault.positionOf(account, alice).unlockAt, 0);
        assertEq(vault.poolOf(account).queuedShares, 0);
    }

    function test_withdraw_eventUsesSlashedValueAndPaysOnlyOwner() public {
        _delegate(alice, account, 100);
        _reserve(holding, account, 20);
        _queue(alice, account, 30);
        vm.prank(holding);
        vault.slash(account, 20);
        vm.warp(t0 + 7 days);
        vm.prank(alice);
        vm.expectEmit(address(vault));
        emit IStakeVault.Withdrawn(account, alice, 30, 24);
        vault.withdraw(account);
        assertEq(vault.positionOf(account, alice).shares, 70);
        assertEq(token.balanceOf(account), 0);
    }

    function test_withdraw_keepsExactHeadroomForExistingBond() public {
        _delegate(alice, account, 40);
        _delegate(bob, account, 60);
        _reserve(holding, account, 60);
        _queue(alice, account, 40);
        vm.warp(t0 + 7 days);
        assertEq(_withdraw(alice, account), 40);
        assertEq(vault.poolOf(account).assets, 60);
        assertEq(vault.reservedOf(account), 60);
        assertEq(vault.availableOf(account), 0);
    }

    function test_queuedSharesStaySlashableAndStillBondedUntilRelease() public {
        _delegate(alice, account, 40);
        _delegate(bob, account, 60);
        _reserve(holding, account, 80);
        _queue(alice, account, 40);
        vm.prank(holding);
        vault.slash(account, 20);
        assertEq(_value(account, alice), 32);
        assertEq(_value(account, bob), 48);
        vm.warp(t0 + 7 days);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.StillBonded.selector, 48, 60));
        vault.withdraw(account);
        vm.prank(holding);
        vault.release(account, 12);
        assertEq(_withdraw(alice, account), 32);
    }

    function test_fullSlash_resetsGenerationAndNeverRevivesOldPositions() public {
        _delegate(alice, account, 40);
        _delegate(bob, account, 60);
        _reserve(holding, account, 100);
        _queue(alice, account, 40);
        vm.prank(holding);
        vm.expectEmit(address(vault));
        emit IStakeVault.Slashed(holding, account, 100);
        vm.expectEmit(address(vault));
        emit IStakeVault.PoolReset(account, 1);
        vault.slash(account, 100);
        IStakeVault.Pool memory pool = vault.poolOf(account);
        assertEq(pool.assets, 0);
        assertEq(pool.reserved, 0);
        assertEq(pool.shares, 0);
        assertEq(pool.queuedShares, 0);
        assertEq(pool.generation, 1);
        IStakeVault.Position memory p = vault.positionOf(account, alice);
        assertEq(p.shares, 0);
        assertEq(p.queuedShares, 0);
        assertEq(p.unlockAt, 0);
        assertEq(p.generation, 1);
        _delegate(bob, account, 7);
        assertEq(_value(account, alice), 0);
        _delegate(alice, account, 3);
        assertEq(vault.positionOf(account, alice).shares, 3);
        assertEq(vault.positionOf(account, alice).generation, 1);
        assertEq(_value(account, bob), 7);
        _assertConserved();
    }

    function test_fullSlash_staleQueueCannotCancelOrWithdraw() public {
        _delegate(alice, account, 10);
        _reserve(holding, account, 10);
        _queue(alice, account, 10);
        vm.prank(holding);
        vault.slash(account, 10);
        _delegate(bob, account, 100);
        vm.startPrank(alice);
        vm.expectRevert(IStakeVault.NothingQueued.selector);
        vault.cancelUndelegate(account);
        vm.expectRevert(IStakeVault.NothingQueued.selector);
        vault.withdraw(account);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.InsufficientShares.selector, 0, 1));
        vault.requestUndelegate(account, 1);
        vm.stopPrank();
        assertEq(_value(account, bob), 100);
    }

    function test_vetoBelongsToBackedAccountRatherThanDelegator() public {
        _delegate(alice, account, 100);
        vm.prank(alice);
        vault.setHoldingDenied(holding, true);
        _reserve(holding, account, 10);
        vm.prank(account);
        vault.setHoldingDenied(holding, true);
        vm.prank(holding);
        vm.expectRevert(IStakeVault.HoldingDenied.selector);
        vault.reserve(account, 1);
        vm.prank(holding);
        vault.release(account, 10);
        assertEq(vault.reservedOf(account), 0);
    }

    /// @dev Two accepted inflationary deposits followed by a third near-total slash reach the queue-bound edge.
    function _inflateSharesWithNearTotalSlashes(bool otherBond) internal {
        _delegate(alice, account, 1e18);
        if (otherBond) {
            vm.prank(safe);
            vault.proposeHolding(holding2);
            vm.warp(vm.getBlockTimestamp() + vault.HOLDING_DELAY());
            vault.acceptHolding();
            _reserve(holding2, account, 1);
        }
        for (uint256 i; i < 3; ++i) {
            uint256 assets = vault.poolOf(account).assets - 1;
            _reserve(holding, account, assets);
            vm.prank(holding);
            vault.slash(account, assets);
            if (i < 2) _delegate(alice, account, 1e18);
        }
    }

    function _assertCappedDepositTakesNothing() internal {
        IStakeVault.Pool memory before = vault.poolOf(account);
        uint256 balance = token.balanceOf(alice);
        uint256 minted = vault.convertToShares(account, 1e18);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, uint8(192), before.shares + minted)
        );
        vault.delegate(account, 1e18);
        assertEq(token.balanceOf(alice), balance, "rejected deposit does not take tokens");
        assertEq(abi.encode(vault.poolOf(account)), abi.encode(before), "rejected deposit does not change the pool");
    }

    function test_shareCap_nearTotalSlashesStillAllowOneCooldownExitAndRecovery() public {
        _inflateSharesWithNearTotalSlashes(false);
        _assertCappedDepositTakesNothing();
        uint256 shares = vault.positionOf(account, alice).shares;
        assertLe(shares, type(uint192).max);
        _queue(alice, account, shares);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        assertEq(_withdraw(alice, account), 1, "all residual assets in one cooldown");
        assertEq(vault.poolOf(account).shares, 0);
        assertEq(vault.poolOf(account).assets, 0);
        _delegate(alice, account, 1e18);
        assertEq(vault.positionOf(account, alice).shares, 1e18, "empty pool recovers 1:1");
        _assertConserved();
    }

    function test_shareCap_otherHoldingBondSurvivesUntilReleaseThenWholeExitWorks() public {
        _inflateSharesWithNearTotalSlashes(true);
        _assertCappedDepositTakesNothing();
        assertEq(vault.reservedBy(holding2, account), 1);
        uint256 shares = vault.positionOf(account, alice).shares;
        _queue(alice, account, shares);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.StillBonded.selector, 0, 1));
        vault.withdraw(account);
        vm.prank(safe);
        vault.revokeHolding(holding2);
        vm.prank(holding2);
        assertEq(vault.release(account, 1), 1, "revoked Holding can still settle the residual bond");
        assertEq(_withdraw(alice, account), 1);
        _delegate(bob, account, 1e18);
        assertEq(vault.positionOf(account, bob).shares, 1e18);
        _assertConserved();
    }

    function test_inflatedSharesUseFullPrecisionForBackingAndRedemption() public {
        _delegate(alice, account, 1e18);
        _reserve(holding, account, 1e18 - 1);
        vm.prank(holding);
        vault.slash(account, 1e18 - 1);
        _delegate(alice, account, 1e12);
        _reserve(holding, account, 1e12);
        vm.prank(holding);
        vault.slash(account, 1e12);
        _delegate(bob, account, 1_000_000e18);
        IStakeVault.Pool memory pool = vault.poolOf(account);
        assertGt(pool.shares, type(uint256).max / pool.assets, "shares times assets exceeds uint256");
        assertEq(vault.stakeOf(account), 1_000_000e18 + 1);
        uint256 bobShares = vault.positionOf(account, bob).shares;
        assertEq(vault.convertToAssets(account, bobShares), 1_000_000e18);
        _queue(bob, account, bobShares);
        assertEq(vault.stakeOf(account), 1);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        assertEq(_withdraw(bob, account), 1_000_000e18);
        uint256 aliceShares = vault.positionOf(account, alice).shares;
        _queue(alice, account, aliceShares);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        assertEq(_withdraw(alice, account), 1);
        _assertConserved();
    }

    function test_shareCap_isolatedPoolDoesNotPreventOtherBacking() public {
        _inflateSharesWithNearTotalSlashes(false);
        _assertCappedDepositTakesNothing();
        _delegate(bob, account2, 1e18);
        assertEq(vault.poolOf(account2).assets, 1e18);
        assertEq(vault.positionOf(account2, bob).shares, 1e18);
        assertEq(vault.poolOf(account).assets, 1);
    }

    function testFuzz_depositSlashRedeemCannotCreateValue(uint96 a, uint96 b, uint96 c, uint96 burn) public {
        uint256 first = bound(a, 1, 100_000e18);
        uint256 second = bound(b, 1, 100_000e18);
        uint256 later = bound(c, 1, 100_000e18);
        _delegate(alice, account, first);
        _delegate(bob, account, second);
        uint256 slashed = bound(burn, 0, first + second);
        _reserve(holding, account, slashed);
        vm.prank(holding);
        vault.slash(account, slashed);
        _delegate(alice, account, later);
        uint256 aliceShares = vault.positionOf(account, alice).shares;
        uint256 bobShares = vault.positionOf(account, bob).shares;
        _queue(alice, account, aliceShares);
        if (bobShares > 0) _queue(bob, account, bobShares);
        vm.warp(t0 + 7 days);
        uint256 returned = _withdraw(alice, account);
        if (bobShares > 0) returned += _withdraw(bob, account);
        assertEq(returned + slashed, first + second + later, "last exit consumes every remaining asset");
        assertEq(vault.totalAssets(), 0);
        _assertConserved();
    }

    function testFuzz_proRataLossWithinOneWei(uint96 a, uint96 b, uint96 burn, bool aliceQueued) public {
        uint256 first = bound(a, 1, 100_000e18);
        uint256 second = bound(b, 1, 100_000e18);
        uint256 total = first + second;
        uint256 slashed = bound(burn, 0, total);
        _delegate(alice, account, first);
        _delegate(bob, account, second);
        _reserve(holding, account, slashed);
        if (aliceQueued) _queue(alice, account, first);
        vm.prank(holding);
        vault.slash(account, slashed);
        uint256 idealLoss = Math.mulDiv(first, slashed, total);
        assertApproxEqAbs(first - _value(account, alice), idealLoss, 1);
        idealLoss = Math.mulDiv(second, slashed, total);
        assertApproxEqAbs(second - _value(account, bob), idealLoss, 1);
        _assertConserved();
    }
}

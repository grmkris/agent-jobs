// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeSchedule} from "../../src/hireling/FeeSchedule.sol";
import {IFeeSchedule} from "../../src/hireling/interfaces/IFeeSchedule.sol";

contract FeeScheduleTest is Test {
    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");
    address stranger = makeAddr("stranger");
    FeeSchedule fees;
    uint256 t0;

    function _default(address treasury_) internal pure returns (IFeeSchedule.Schedule memory s) {
        s.thresholds = [uint256(0), 10_000e18, 100_000e18, 1_000_000e18];
        s.bps = [uint16(3000), 1000, 300, 100];
        s.treasury = treasury_;
    }

    function setUp() public {
        t0 = vm.getBlockTimestamp();
        fees = new FeeSchedule(_default(treasury));
        fees.transferOwnership(safe);
        vm.prank(safe);
        fees.acceptOwnership();
    }

    function test_defaultTiers_boundaries() public view {
        assertEq(fees.feeBps(0), 3000);
        assertEq(fees.feeBps(10_000e18 - 1), 3000);
        assertEq(fees.feeBps(10_000e18), 1000);
        assertEq(fees.feeBps(100_000e18 - 1), 1000);
        assertEq(fees.feeBps(100_000e18), 300);
        assertEq(fees.feeBps(1_000_000e18 - 1), 300);
        assertEq(fees.feeBps(1_000_000e18), 100);
        assertEq(fees.feeBps(type(uint256).max), 100);
        assertEq(fees.treasury(), treasury);
        assertEq(fees.DELAY(), 3 days);
        assertEq(fees.MAX_BPS(), 3000);
    }

    function testFuzz_feeNeverIncreasesWithStake(uint256 a, uint256 b) public view {
        (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
        assertGe(fees.feeBps(lo), fees.feeBps(hi));
        assertLe(fees.feeBps(lo), 3000);
    }

    function test_propose_executeAfterThreeDays_anyone() public {
        IFeeSchedule.Schedule memory s = _default(makeAddr("newTreasury"));
        s.thresholds = [uint256(0), 1_000e18, 10_000e18, 100_000e18];
        s.bps = [uint16(2000), 500, 200, 50];
        vm.prank(safe);
        fees.propose(s);
        (IFeeSchedule.Schedule memory p, uint48 eta) = fees.pending();
        assertEq(eta, t0 + 3 days);
        assertEq(p.bps[0], 2000);
        assertEq(fees.feeBps(0), 3000, "nothing changes before execute");

        vm.warp(t0 + 3 days - 1);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.ScheduleTimelocked.selector, uint48(t0 + 3 days)));
        fees.execute();

        vm.warp(t0 + 3 days);
        vm.prank(stranger);
        fees.execute();
        assertEq(fees.feeBps(0), 2000);
        assertEq(fees.feeBps(1_000e18), 500);
        assertEq(fees.feeBps(100_000e18), 50);
        assertEq(fees.treasury(), makeAddr("newTreasury"));
        (, eta) = fees.pending();
        assertEq(eta, 0);

        vm.expectRevert(IFeeSchedule.NoPendingSchedule.selector);
        fees.execute();
    }

    function test_cancel() public {
        vm.prank(safe);
        fees.propose(_default(treasury));
        vm.prank(safe);
        fees.cancel();
        vm.warp(t0 + 4 days);
        vm.expectRevert(IFeeSchedule.NoPendingSchedule.selector);
        fees.execute();
        vm.prank(safe);
        vm.expectRevert(IFeeSchedule.NoPendingSchedule.selector);
        fees.cancel();
    }

    function test_onlyOwnerProposesAndCancels() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        fees.propose(_default(treasury));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        fees.cancel();
    }

    function test_bounds_firstThresholdZero() public {
        IFeeSchedule.Schedule memory s = _default(treasury);
        s.thresholds[0] = 1;
        vm.prank(safe);
        vm.expectRevert(IFeeSchedule.FirstThresholdNotZero.selector);
        fees.propose(s);
    }

    function test_bounds_thresholdsStrictlyAscending() public {
        IFeeSchedule.Schedule memory s = _default(treasury);
        s.thresholds[2] = s.thresholds[1];
        vm.prank(safe);
        vm.expectRevert(IFeeSchedule.ThresholdsNotAscending.selector);
        fees.propose(s);
    }

    function test_bounds_rateCap() public {
        IFeeSchedule.Schedule memory s = _default(treasury);
        s.bps[0] = 3001;
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.FeeTooHigh.selector, uint16(3001), uint16(3000)));
        fees.propose(s);
    }

    function test_bounds_ratesNonIncreasing() public {
        IFeeSchedule.Schedule memory s = _default(treasury);
        s.bps[3] = 400;
        vm.prank(safe);
        vm.expectRevert(IFeeSchedule.FeesIncreasing.selector);
        fees.propose(s);
        // Equal neighbours are allowed (a flat schedule).
        s.bps = [uint16(100), 100, 100, 100];
        vm.prank(safe);
        fees.propose(s);
    }

    function test_bounds_treasuryNonzero() public {
        vm.prank(safe);
        vm.expectRevert(IFeeSchedule.ZeroTreasury.selector);
        fees.propose(_default(address(0)));
    }

    function test_constructor_heldToTheSameBounds() public {
        IFeeSchedule.Schedule memory s = _default(treasury);
        s.bps[0] = 5000;
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.FeeTooHigh.selector, uint16(5000), uint16(3000)));
        new FeeSchedule(s);
    }

    // ---------------------------------------------------------------------------------------------
    // C9 audit: expiry, handover, visible replacement
    // ---------------------------------------------------------------------------------------------

    function test_propose_expiresAfterTheGrace() public {
        IFeeSchedule.Schedule memory s = _default(stranger);
        vm.prank(safe);
        fees.propose(s);
        (, uint48 eta) = fees.pending();
        vm.warp(uint256(eta) + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.ScheduleExpired.selector, eta));
        fees.execute();
    }

    function test_handoverDropsTheOldOwnersProposal() public {
        FeeSchedule f = new FeeSchedule(_default(treasury));
        f.propose(_default(stranger));
        f.transferOwnership(safe);
        vm.prank(safe);
        f.acceptOwnership();
        (, uint48 eta) = f.pending();
        assertEq(eta, 0);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        vm.expectRevert(IFeeSchedule.NoPendingSchedule.selector);
        f.execute();
        assertEq(f.treasury(), treasury);
    }

    function test_replacedProposalIsCancelledVisibly() public {
        vm.prank(safe);
        fees.propose(_default(stranger));
        vm.prank(safe);
        vm.expectEmit(false, false, false, false, address(fees));
        emit IFeeSchedule.ScheduleCancelled();
        fees.propose(_default(treasury));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseV1} from "./BaseV1.t.sol";
import {HirelingClocks} from "../../src/hireling/HirelingClocks.sol";
import {StakeVault} from "../../src/hireling/StakeVault.sol";
import {FeeSchedule} from "../../src/hireling/FeeSchedule.sol";
import {HirelingHolding} from "../../src/hireling/HirelingHolding.sol";
import {MiningReserve} from "../../src/hireling/MiningReserve.sol";
import {EpochDistributor} from "../../src/hireling/EpochDistributor.sol";
import {IERC8004Identity} from "../../src/vendor/erc8004/IERC8004.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IStakeVault} from "../../src/hireling/interfaces/IStakeVault.sol";
import {IFeeSchedule} from "../../src/hireling/interfaces/IFeeSchedule.sol";
import {IMiningReserve} from "../../src/hireling/interfaces/IMiningReserve.sol";
import {IEpochDistributor} from "../../src/hireling/interfaces/IEpochDistributor.sol";

contract ClocksTest is BaseV1 {
    // Exercise each real constructor, not only the shared validation helper.
    function deployOne(uint256 which, HirelingClocks.Config memory c) external returns (address) {
        if (which == 0) return address(new StakeVault(factory, c));
        if (which == 1) return address(new FeeSchedule(defaultSchedule(treasury), c));
        if (which == 2) {
            return
                address(
                    new HirelingHolding(core, vault, fees, IERC8004Identity(address(identity)), arbitrator, MARGIN, c)
                );
        }
        if (which == 3) return address(new MiningReserve(factory, address(holding), 1, c));
        return address(new EpochDistributor(factory, vault, 1, c));
    }

    function _refuseAll(HirelingClocks.Config memory c, bytes32 name, uint256 value) internal {
        for (uint256 which; which < 5; ++which) {
            vm.expectRevert(abi.encodeWithSelector(HirelingClocks.InvalidClock.selector, name, value));
            this.deployOne(which, c);
        }
    }

    function _mainnet(uint256 field) internal {
        vm.chainId(143);
        HirelingClocks.Config memory c = HirelingClocks.production();
        bytes32 name;
        uint256 value;
        if (field == 0) {
            name = "minReviewWindow";
            value = ++c.minReviewWindow;
        }
        if (field == 1) {
            name = "minDisputeWindow";
            value = ++c.minDisputeWindow;
        }
        if (field == 2) {
            name = "minArbitrationWindow";
            value = ++c.minArbitrationWindow;
        }
        if (field == 3) {
            name = "unstakeDelay";
            value = ++c.unstakeDelay;
        }
        if (field == 4) {
            name = "holdingDelay";
            value = ++c.holdingDelay;
        }
        if (field == 5) {
            name = "feeDelay";
            value = ++c.feeDelay;
        }
        if (field == 6) {
            name = "proposalGrace";
            value = ++c.proposalGrace;
        }
        if (field == 7) {
            name = "epochZeroDuration";
            value = ++c.epochZeroDuration;
        }
        if (field == 8) {
            name = "epochDuration";
            value = ++c.epochDuration;
        }
        _refuseAll(c, name, value);
    }

    function test_143_refusesMinReviewWindow() public {
        _mainnet(0);
    }

    function test_143_refusesMinDisputeWindow() public {
        _mainnet(1);
    }

    function test_143_refusesMinArbitrationWindow() public {
        _mainnet(2);
    }

    function test_143_refusesUnstakeDelay() public {
        _mainnet(3);
    }

    function test_143_refusesHoldingDelay() public {
        _mainnet(4);
    }

    function test_143_refusesFeeDelay() public {
        _mainnet(5);
    }

    function test_143_refusesProposalGrace() public {
        _mainnet(6);
    }

    function test_143_refusesEpochZeroDuration() public {
        _mainnet(7);
    }

    function test_143_refusesEpochDuration() public {
        _mainnet(8);
    }

    function test_143_acceptsProductionInAllConstructors() public {
        vm.chainId(143);
        for (uint256 which; which < 5; ++which) {
            assertTrue(this.deployOne(which, HirelingClocks.production()) != address(0));
        }
    }

    function test_everyChain_holdingDelayMustOutlastUnstake() public {
        vm.chainId(10143);
        HirelingClocks.Config memory c = HirelingClocks.production();
        c.holdingDelay = c.unstakeDelay;
        _refuseAll(c, "holdingDelay", c.holdingDelay);
        c.holdingDelay--;
        _refuseAll(c, "holdingDelay", c.holdingDelay);
    }

    function test_everyChain_zeroClocksRefuse() public {
        vm.chainId(10143);
        HirelingClocks.Config memory c = HirelingClocks.production();
        c.proposalGrace = 0;
        _refuseAll(c, "proposalGrace", 0);
        c = HirelingClocks.production();
        c.epochDuration = 0;
        _refuseAll(c, "epochDuration", 0);
        c = HirelingClocks.production();
        c.epochZeroDuration = 0;
        _refuseAll(c, "epochZeroDuration", 0);
        c = HirelingClocks.production();
        c.minReviewWindow = 0;
        _refuseAll(c, "minReviewWindow", 0);
        c = HirelingClocks.production();
        c.minDisputeWindow = 0;
        _refuseAll(c, "minDisputeWindow", 0);
        c = HirelingClocks.production();
        c.minArbitrationWindow = 0;
        _refuseAll(c, "minArbitrationWindow", 0);
    }

    function test_everyChain_windowsCannotExceedMaximums() public {
        vm.chainId(10143);
        HirelingClocks.Config memory c = HirelingClocks.production();
        c.minReviewWindow = 14 days + 1;
        _refuseAll(c, "minReviewWindow", c.minReviewWindow);
        c = HirelingClocks.production();
        c.minDisputeWindow = 14 days + 1;
        _refuseAll(c, "minDisputeWindow", c.minDisputeWindow);
        c = HirelingClocks.production();
        c.minArbitrationWindow = 14 days + 1;
        _refuseAll(c, "minArbitrationWindow", c.minArbitrationWindow);
    }

    function test_everyChain_delayAndEpochFloors() public {
        vm.chainId(10143);
        HirelingClocks.Config memory c = HirelingClocks.production();
        c.unstakeDelay = 59;
        _refuseAll(c, "unstakeDelay", 59);
        c = HirelingClocks.production();
        c.holdingDelay = 59;
        _refuseAll(c, "holdingDelay", 59);
        c = HirelingClocks.production();
        c.feeDelay = 59;
        _refuseAll(c, "feeDelay", 59);
        c = HirelingClocks.production();
        c.proposalGrace = 59;
        _refuseAll(c, "proposalGrace", 59);
        c = HirelingClocks.production();
        c.epochZeroDuration = 599;
        _refuseAll(c, "epochZeroDuration", 599);
        c = HirelingClocks.production();
        c.epochDuration = 599;
        _refuseAll(c, "epochDuration", 599);
    }
}

contract FastClocksTest is BaseV1 {
    function clocks() internal pure override returns (HirelingClocks.Config memory) {
        return HirelingClocks.Config(120, 120, 300, 600, 900, 300, 1800, 1800, 3600);
    }

    function test_fastWindowsPublishAtMinimums_belowEachRefuses() public {
        IHirelingHolding.PublishParams memory p = params();
        p.reviewWindow = 120;
        p.disputeWindow = 120;
        p.arbitrationWindow = 300;
        p.reviewWindow--;
        vm.expectRevert(
            abi.encodeWithSelector(
                IHirelingHolding.WindowOutOfBounds.selector, p.reviewWindow, uint32(120), uint32(14 days)
            )
        );
        publishWith(p);
        p.reviewWindow = 120;
        p.disputeWindow--;
        vm.expectRevert(
            abi.encodeWithSelector(
                IHirelingHolding.WindowOutOfBounds.selector, p.disputeWindow, uint32(120), uint32(14 days)
            )
        );
        publishWith(p);
        p.disputeWindow = 120;
        p.arbitrationWindow--;
        vm.expectRevert(
            abi.encodeWithSelector(
                IHirelingHolding.WindowOutOfBounds.selector, p.arbitrationWindow, uint32(300), uint32(14 days)
            )
        );
        publishWith(p);
        p.arbitrationWindow = 300;
        uint256 job = publishWith(p);
        assertEq(holding.getListing(job).reviewWindow, 120);
    }

    function test_fastUnstakeExitBeforeHoldingAcceptance() public {
        uint256 t0 = vm.getBlockTimestamp();
        address newHolding = makeAddr("new-holding");
        vm.prank(deployer);
        vault.proposeHolding(newHolding);
        vm.prank(worker);
        vault.requestUndelegate(worker, 100e18);
        vm.warp(t0 + 599);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.UndelegateLocked.selector, uint48(t0 + 600)));
        vault.withdraw(worker);
        vm.warp(t0 + 600);
        uint256 before = factory.balanceOf(worker);
        vm.prank(worker);
        vault.withdraw(worker);
        assertEq(factory.balanceOf(worker) - before, 100e18);
        vm.warp(t0 + 899);
        vm.expectRevert(abi.encodeWithSelector(IStakeVault.HoldingTimelocked.selector, uint48(t0 + 900)));
        vault.acceptHolding();
        vm.warp(t0 + 900);
        vault.acceptHolding();
        assertTrue(vault.isHolding(newHolding));
    }

    function test_fastFeeDelayAndGraceCutoffs() public {
        uint256 t0 = vm.getBlockTimestamp();
        IFeeSchedule.Schedule memory s = defaultSchedule(stranger);
        vm.prank(deployer);
        fees.propose(s);
        vm.warp(t0 + 299);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.ScheduleTimelocked.selector, uint48(t0 + 300)));
        fees.execute();
        vm.warp(t0 + 300);
        fees.execute();
        assertEq(fees.treasury(), stranger);
        vm.prank(deployer);
        fees.propose(defaultSchedule(treasury));
        vm.warp(t0 + 600 + 1800); // inclusive grace cutoff
        fees.execute();
        assertEq(fees.treasury(), treasury);
        vm.prank(deployer);
        fees.propose(s);
        uint48 eta = uint48(vm.getBlockTimestamp() + 300);
        vm.warp(uint256(eta) + 1801);
        vm.expectRevert(abi.encodeWithSelector(IFeeSchedule.ScheduleExpired.selector, eta));
        fees.execute();
    }

    function test_fastHoldingGraceCutoff() public {
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(deployer);
        vault.proposeHolding(stranger);
        vm.warp(t0 + 900 + 1800);
        vault.acceptHolding();
        assertTrue(vault.isHolding(stranger));
        vm.prank(deployer);
        vault.proposeHolding(relayer);
        vm.warp(t0 + 2 * (900 + 1800) + 1);
        vm.expectRevert(IStakeVault.HoldingProposalExpired.selector);
        vault.acceptHolding();
    }

    function test_fastEpochCloseFundingRootClaimIntoStake() public {
        uint48 genesis = uint48(vm.getBlockTimestamp());
        EpochDistributor distributor = new EpochDistributor(factory, vault, genesis, clocks());
        MiningReserve reserve = new MiningReserve(factory, address(distributor), genesis, clocks());
        vm.prank(deployer);
        factory.transfer(address(reserve), 500_000_000e18);
        bytes32 root = distributor.leaf(0, stranger, 10e18);
        vm.warp(uint256(genesis) + 1799);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.EpochNotEnded.selector, 0, uint256(genesis) + 1800));
        reserve.fund(0, 10e18);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.EpochNotEnded.selector, 0, uint256(genesis) + 1800));
        distributor.setRoot(0, root, 10e18, root);
        vm.warp(uint256(genesis) + 1800);
        reserve.fund(0, 10e18);
        distributor.setRoot(0, root, 10e18, root);
        distributor.claim(0, stranger, 10e18, new bytes32[](0));
        assertEq(vault.stakeOf(stranger), 10e18);
        assertEq(reserve.currentEpoch(), 1);
        assertEq(reserve.epochEnd(1), uint256(genesis) + 5400);
        assertEq(distributor.epochEnd(1), reserve.epochEnd(1));
        assertEq(reserve.budget(0), uint256(500_000_000e18) / 52 * 3 / 7, "economic budgets stay fixed");
        vm.warp(uint256(genesis) + 5399);
        assertEq(reserve.currentEpoch(), 1);
        vm.warp(uint256(genesis) + 5400);
        assertEq(reserve.currentEpoch(), 2);
    }

    function testFuzz_epochBoundaries(uint48 zero, uint48 duration, uint32 epoch) public {
        zero = uint48(bound(zero, 600, 30 days));
        duration = uint48(bound(duration, 600, 30 days));
        epoch = uint32(bound(epoch, 0, 1_000_000));
        HirelingClocks.Config memory c = clocks();
        c.epochZeroDuration = zero;
        c.epochDuration = duration;
        uint48 genesis = uint48(vm.getBlockTimestamp());
        EpochDistributor distributor = new EpochDistributor(factory, vault, genesis, c);
        MiningReserve reserve = new MiningReserve(factory, address(distributor), genesis, c);
        uint256 end = reserve.epochEnd(epoch);
        assertEq(distributor.epochEnd(epoch), end);
        assertEq(end - reserve.epochStart(epoch), epoch == 0 ? zero : duration);
        vm.warp(end - 1);
        assertEq(reserve.currentEpoch(), epoch);
        vm.warp(end);
        assertEq(reserve.currentEpoch(), uint256(epoch) + 1);
    }
}

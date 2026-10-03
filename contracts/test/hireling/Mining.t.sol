// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HirelingClocks} from "../../src/hireling/HirelingClocks.sol";

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {Factory} from "../../src/hireling/Factory.sol";
import {StakeVault} from "../../src/hireling/StakeVault.sol";
import {MiningReserve} from "../../src/hireling/MiningReserve.sol";
import {EpochDistributor} from "../../src/hireling/EpochDistributor.sol";
import {IMiningReserve} from "../../src/hireling/interfaces/IMiningReserve.sol";
import {IEpochDistributor} from "../../src/hireling/interfaces/IEpochDistributor.sol";

contract MiningTest is Test {
    uint256 constant W = uint256(500_000_000e18) / 52;
    uint48 constant GENESIS = 1_800_000_000;

    address safe = makeAddr("safe");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address relayer = makeAddr("relayer");
    Factory token;
    StakeVault vault;
    EpochDistributor distributor;
    MiningReserve reserve;

    function setUp() public {
        vm.warp(GENESIS);
        address[] memory to = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        (to[0], amounts[0]) = (address(this), 1_000_000_000e18);
        token = new Factory("Factory", "FACTORY", to, amounts);
        vault = new StakeVault(token, HirelingClocks.production());
        vault.bootstrapHolding(makeAddr("holding"));
        distributor = new EpochDistributor(token, vault, GENESIS, HirelingClocks.production());
        reserve = new MiningReserve(token, address(distributor), GENESIS, HirelingClocks.production());
        token.transfer(address(reserve), 500_000_000e18);
        reserve.transferOwnership(safe);
        distributor.transferOwnership(safe);
        vm.startPrank(safe);
        reserve.acceptOwnership();
        distributor.acceptOwnership();
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------
    // Schedule
    // ------------------------------------------------------------------------------------------

    function test_schedule_budgets() public view {
        assertEq(reserve.WEEKLY_BUDGET(), W);
        assertEq(reserve.budget(0), W * 3 / 7);
        assertEq(reserve.budget(1), W);
        assertEq(reserve.budget(26), W);
        assertEq(reserve.budget(27), W / 2);
        assertEq(reserve.budget(52), W / 2);
        assertEq(reserve.budget(53), W / 4);
        assertEq(reserve.budget(type(uint256).max), 0);
    }

    function test_schedule_boundaries() public {
        assertEq(reserve.epochStart(0), GENESIS);
        assertEq(reserve.epochEnd(0), GENESIS + 72 hours);
        assertEq(reserve.epochStart(1), GENESIS + 72 hours);
        assertEq(reserve.epochEnd(1), GENESIS + 72 hours + 7 days);
        assertEq(reserve.epochEnd(5), GENESIS + 72 hours + 5 * 7 days);
        assertEq(distributor.epochEnd(5), reserve.epochEnd(5), "both read the same genesis");
        assertEq(reserve.currentEpoch(), 0);
        vm.warp(GENESIS + 72 hours - 1);
        assertEq(reserve.currentEpoch(), 0);
        vm.warp(GENESIS + 72 hours);
        assertEq(reserve.currentEpoch(), 1);
        vm.warp(GENESIS + 72 hours + 7 days);
        assertEq(reserve.currentEpoch(), 2);

        MiningReserve later = new MiningReserve(token, address(distributor), GENESIS + 1 days, HirelingClocks.production());
        vm.warp(GENESIS);
        vm.expectRevert(IMiningReserve.BeforeGenesis.selector);
        later.currentEpoch();
    }

    function testFuzz_schedule_cumulativeEqualsSumCappedAtReserve(uint16 e) public view {
        uint256 epoch = bound(uint256(e), 0, 400);
        uint256 sum;
        for (uint256 i; i <= epoch; ++i) {
            sum += reserve.budget(i);
        }
        assertEq(reserve.cumulativeBudget(epoch), sum < 500_000_000e18 ? sum : 500_000_000e18);
    }

    /// @dev Review C6-002: the series passes the 500M after about seven halving eras; the cap makes the tail a clean
    ///      ExceedsBudget instead of a failed transfer.
    function test_schedule_cappedAtTheReserve() public {
        assertEq(reserve.cumulativeBudget(type(uint256).max), 500_000_000e18);
        uint256 sum;
        uint256 crossing;
        for (uint256 i; i < 400; ++i) {
            sum += reserve.budget(i);
            // Budgets are cut at the cap (C9 MATH-4): they reach exactly 500M and never pass it.
            if (sum >= 500_000_000e18) {
                crossing = i;
                break;
            }
        }
        assertEq(sum, 500_000_000e18);
        assertGt(crossing, 26 * 6, "past six eras");
        assertLt(crossing, 26 * 8, "before eight");
        assertEq(reserve.cumulativeBudget(crossing), 500_000_000e18);

        vm.warp(reserve.epochEnd(crossing));
        vm.prank(safe);
        reserve.fund(crossing, 500_000_000e18);
        assertEq(token.balanceOf(address(reserve)), 0);
        vm.warp(reserve.epochEnd(crossing + 1));
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.ExceedsBudget.selector, 1, 0));
        reserve.fund(crossing + 1, 1);
    }

    /// @dev Review C6-001: no implicit "now", so two contracts deployed in different blocks cannot disagree.
    function test_genesis_mustBeExplicit() public {
        vm.expectRevert(IMiningReserve.ZeroGenesis.selector);
        new MiningReserve(token, address(distributor), 0, HirelingClocks.production());
        vm.expectRevert(IEpochDistributor.ZeroGenesis.selector);
        new EpochDistributor(token, vault, 0, HirelingClocks.production());
    }

    // ------------------------------------------------------------------------------------------
    // Reserve funding: cap and rollover
    // ------------------------------------------------------------------------------------------

    function test_fund_onlyOwnerAfterEpochEnd() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.EpochNotEnded.selector, 0, GENESIS + 72 hours));
        reserve.fund(0, 1);
        vm.warp(GENESIS + 72 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        reserve.fund(0, 1);
        vm.prank(safe);
        vm.expectRevert(IMiningReserve.ZeroAmount.selector);
        reserve.fund(0, 0);
        vm.prank(safe);
        reserve.fund(0, 1);
        assertEq(token.balanceOf(address(distributor)), 1);
    }

    function test_fund_cappedByCumulativeSchedule() public {
        vm.warp(GENESIS + 72 hours);
        uint256 b0 = W * 3 / 7;
        vm.prank(safe);
        reserve.fund(0, b0);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.ExceedsBudget.selector, 1, 0));
        reserve.fund(0, 1);
        // Epoch 1 has not ended: its budget is not available yet.
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.EpochNotEnded.selector, 1, GENESIS + 72 hours + 7 days));
        reserve.fund(1, 1);
        vm.warp(GENESIS + 72 hours + 7 days);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.ExceedsBudget.selector, W + 1, W));
        reserve.fund(1, W + 1);
        vm.prank(safe);
        reserve.fund(1, W);
        assertEq(reserve.totalFunded(), b0 + W);
    }

    function test_fund_unspentBudgetRollsOver() public {
        vm.warp(GENESIS + 72 hours + 7 days);
        uint256 b0 = W * 3 / 7;
        vm.prank(safe);
        reserve.fund(0, b0 / 2);
        vm.prank(safe);
        reserve.fund(1, W + b0 - b0 / 2);
        assertEq(reserve.totalFunded(), b0 + W);
        assertEq(token.balanceOf(address(distributor)), b0 + W);
    }

    // ------------------------------------------------------------------------------------------
    // Distributor: roots backed by funds, claim stakes
    // ------------------------------------------------------------------------------------------

    struct Tree {
        bytes32[4] leaves;
        bytes32 root;
        uint256 total;
    }

    function _tree(uint256 epoch, uint256[4] memory amounts) internal view returns (Tree memory t) {
        address[4] memory who = [alice, bob, carol, dave];
        for (uint256 i; i < 4; ++i) {
            t.leaves[i] = distributor.leaf(epoch, who[i], amounts[i]);
            t.total += amounts[i];
        }
        t.root = Hashes.commutativeKeccak256(
            Hashes.commutativeKeccak256(t.leaves[0], t.leaves[1]), Hashes.commutativeKeccak256(t.leaves[2], t.leaves[3])
        );
    }

    function _proof(Tree memory t, uint256 i) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = t.leaves[i ^ 1];
        p[1] = i < 2
            ? Hashes.commutativeKeccak256(t.leaves[2], t.leaves[3])
            : Hashes.commutativeKeccak256(t.leaves[0], t.leaves[1]);
    }

    function _fundEpoch0(uint256 amount) internal {
        vm.warp(GENESIS + 72 hours);
        vm.prank(safe);
        reserve.fund(0, amount);
    }

    function test_leaf_isOzDoubleHash() public view {
        assertEq(
            distributor.leaf(3, alice, 7e18), keccak256(bytes.concat(keccak256(abi.encode(uint256(3), alice, 7e18))))
        );
    }

    function test_setRoot_afterEpochEndAndBackedByFunds() public {
        Tree memory t = _tree(0, [uint256(100e18), 200e18, 300e18, 400e18]);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.EpochNotEnded.selector, 0, GENESIS + 72 hours));
        distributor.setRoot(0, t.root, t.total, keccak256("data"));

        vm.warp(GENESIS + 72 hours);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.InsufficientFunds.selector, 0, t.total));
        distributor.setRoot(0, t.root, t.total, keccak256("data"));

        vm.prank(safe);
        reserve.fund(0, t.total);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        distributor.setRoot(0, t.root, t.total, keccak256("data"));
        vm.prank(safe);
        vm.expectRevert(IEpochDistributor.ZeroRoot.selector);
        distributor.setRoot(0, bytes32(0), t.total, keccak256("data"));
        vm.prank(safe);
        distributor.setRoot(0, t.root, t.total, keccak256("data"));
        assertEq(distributor.outstanding(), t.total);
        assertEq(distributor.available(), 0);
        IEpochDistributor.EpochRoot memory r = distributor.rootOf(0);
        assertEq(r.root, t.root);
        assertEq(r.dataHash, keccak256("data"));
    }

    function test_setRoot_fundsCannotBackTwoRoots() public {
        Tree memory t0 = _tree(0, [uint256(100e18), 200e18, 300e18, 400e18]);
        Tree memory t1 = _tree(1, [uint256(1e18), 1e18, 1e18, 1e18]);
        _fundEpoch0(t0.total);
        vm.prank(safe);
        distributor.setRoot(0, t0.root, t0.total, bytes32(0));
        vm.warp(GENESIS + 72 hours + 7 days);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.InsufficientFunds.selector, 0, t1.total));
        distributor.setRoot(1, t1.root, t1.total, bytes32(0));
    }

    function test_setRoot_replaceableUntilFirstClaim() public {
        Tree memory bad = _tree(0, [uint256(900e18), 1, 1, 1]);
        Tree memory good = _tree(0, [uint256(100e18), 200e18, 300e18, 400e18]);
        _fundEpoch0(1_000e18);
        vm.prank(safe);
        distributor.setRoot(0, bad.root, bad.total, bytes32(0));
        // The replacement frees the old total first.
        vm.prank(safe);
        distributor.setRoot(0, good.root, good.total, bytes32(0));
        assertEq(distributor.outstanding(), good.total);

        vm.prank(relayer);
        distributor.claim(0, alice, 100e18, _proof(good, 0));
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.RootLocked.selector, 0));
        distributor.setRoot(0, bad.root, bad.total, bytes32(0));
    }

    function test_claim_stakesForTheAccount_onceAnyoneMayClaim() public {
        Tree memory t = _tree(0, [uint256(100e18), 200e18, 300e18, 400e18]);
        _fundEpoch0(t.total);
        vm.prank(safe);
        distributor.setRoot(0, t.root, t.total, bytes32(0));

        vm.prank(relayer);
        vm.expectEmit(address(distributor));
        emit IEpochDistributor.Claimed(0, bob, 200e18);
        distributor.claim(0, bob, 200e18, _proof(t, 1));
        assertEq(vault.stakeOf(bob), 200e18, "staked, not sent");
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(relayer), 0);
        assertTrue(distributor.isClaimed(0, bob));
        assertEq(distributor.outstanding(), t.total - 200e18);
        assertEq(distributor.rootOf(0).claimed, 200e18);

        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.AlreadyClaimed.selector, 0, bob));
        distributor.claim(0, bob, 200e18, _proof(t, 1));
        vm.expectRevert(IEpochDistributor.InvalidProof.selector);
        distributor.claim(0, carol, 301e18, _proof(t, 2));
        vm.expectRevert(IEpochDistributor.InvalidProof.selector);
        distributor.claim(0, carol, 300e18, _proof(t, 1));
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.NoRoot.selector, 1));
        distributor.claim(1, carol, 300e18, _proof(t, 2));

        distributor.claim(0, alice, 100e18, _proof(t, 0));
        distributor.claim(0, carol, 300e18, _proof(t, 2));
        distributor.claim(0, dave, 400e18, _proof(t, 3));
        assertEq(distributor.outstanding(), 0);
        assertEq(vault.totalStaked(), t.total);
    }

    function test_claim_rootPaysAtMostItsTotal() public {
        // A wrong root whose leaves sum past the declared total.
        Tree memory t = _tree(0, [uint256(100e18), 200e18, 300e18, 400e18]);
        _fundEpoch0(t.total);
        vm.prank(safe);
        distributor.setRoot(0, t.root, 500e18, bytes32(0));
        distributor.claim(0, dave, 400e18, _proof(t, 3));
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.InsufficientFunds.selector, 100e18, 300e18));
        distributor.claim(0, carol, 300e18, _proof(t, 2));
        distributor.claim(0, alice, 100e18, _proof(t, 0));
        assertEq(distributor.available(), t.total - 500e18, "the rest stays for later roots");
    }

    function test_claim_aDonationNeverBlocksSetup() public {
        token.transfer(address(distributor), 5e18);
        Tree memory t = _tree(0, [uint256(1e18), 1e18, 1e18, 1e18]);
        vm.warp(GENESIS + 72 hours);
        vm.prank(safe);
        distributor.setRoot(0, t.root, t.total, bytes32(0));
        distributor.claim(0, alice, 1e18, _proof(t, 0));
        assertEq(vault.stakeOf(alice), 1e18);
    }

    // ---------------------------------------------------------------------------------------------
    // C9 audit: the budget is cut at the cap; a root's total can be corrected
    // ---------------------------------------------------------------------------------------------

    /// @dev MATH-4: budgets sum to the capped cumulative schedule, and end where the reserve does.
    function test_schedule_budgetCutAtTheCap() public view {
        uint256 sum;
        for (uint256 e; e <= 200; ++e) {
            sum += reserve.budget(e);
            assertEq(sum, reserve.cumulativeBudget(e));
        }
        assertEq(reserve.cumulativeBudget(181), 500_000_000e18);
        assertLt(reserve.cumulativeBudget(180), 500_000_000e18);
        assertEq(reserve.budget(181), 500_000_000e18 - reserve.cumulativeBudget(180));
        assertEq(reserve.budget(182), 0);
        assertEq(reserve.budget(5000), 0);
    }

    /// @dev MATH-5: a total above the sum of its leaves is released after claims locked the root; an increase needs
    ///      unpromised funds; never below what was claimed.
    function test_resizeRoot_releasesAnOverPromise() public {
        Tree memory t = _tree(0, [uint256(100e18), 200e18, 300e18, 400e18]);
        _fundEpoch0(1_100e18);
        vm.prank(safe);
        distributor.setRoot(0, t.root, t.total + 100e18, bytes32(0));
        distributor.claim(0, alice, 100e18, _proof(t, 0));
        assertEq(distributor.available(), 0);
        vm.prank(safe);
        distributor.resizeRoot(0, t.total);
        assertEq(distributor.available(), 100e18, "the over-promise is free again");
        assertEq(distributor.outstanding(), t.total - 100e18);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.InsufficientFunds.selector, 50e18, 100e18));
        distributor.resizeRoot(0, 50e18);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IEpochDistributor.InsufficientFunds.selector, 100e18, 200e18));
        distributor.resizeRoot(0, t.total + 200e18);
        vm.prank(stranger_());
        vm.expectRevert();
        distributor.resizeRoot(0, t.total);
        // Every remaining leaf still claims in full.
        distributor.claim(0, bob, 200e18, _proof(t, 1));
        distributor.claim(0, carol, 300e18, _proof(t, 2));
        distributor.claim(0, dave, 400e18, _proof(t, 3));
        assertEq(distributor.outstanding(), 0);
    }

    function stranger_() internal returns (address) {
        return makeAddr("stranger");
    }
}

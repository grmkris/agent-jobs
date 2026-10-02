// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {IStakeVault} from "../../src/hireling/interfaces/IStakeVault.sol";
import {IFeeSchedule} from "../../src/hireling/interfaces/IFeeSchedule.sol";
import {BlocklistToken, FeeOnTransferToken} from "../mocks/OddTokens.sol";
import {GasHungryToken} from "./mocks/V1Tokens.sol";
import {BaseV1} from "./BaseV1.t.sol";

contract HirelingHoldingTest is BaseV1 {
    // ------------------------------------------------------------------------------------------
    // Publish
    // ------------------------------------------------------------------------------------------

    function test_publish_escrowsRewardReservesBondFreezesTerms() public {
        uint256 jobId = publish();
        IHirelingHolding.Listing memory l = listing(jobId);
        assertEq(pay.balanceOf(address(holding)), REWARD);
        assertEq(vault.reservedOf(creator), CREATOR_BOND);
        assertEq(vault.reservedBy(address(holding), creator), CREATOR_BOND);
        assertEq(factory.balanceOf(address(holding)), 0, "no FACTORY moves at publish");
        assertEq(l.creator, creator);
        assertEq(l.approver, creator, "approver defaults to the creator");
        assertEq(l.arbitrator, arbitrator, "arbitrator defaults to defaultArbitrator");
        assertEq(l.reviewWindow, REVIEW);
        assertEq(l.disputeWindow, DISPUTE);
        assertEq(l.arbitrationWindow, ARBITRATION);
        assertEq(l.reward, REWARD);
        assertFalse(l.funded);
        ERC8183.Job memory job = core.getJob(jobId);
        assertEq(job.client, address(holding));
        assertEq(job.evaluator, address(evaluator));
        assertTrue(holding.policyListed(creator, l.policyHash));
    }

    function test_publish_windowBounds() public {
        uint32[3] memory lo = [uint32(1 hours), 1 hours, 12 hours];
        uint32[3] memory hi = [uint32(14 days), 14 days, 14 days];
        for (uint256 w; w < 3; ++w) {
            for (uint256 side; side < 2; ++side) {
                IHirelingHolding.PublishParams memory p = params();
                uint32 bad = side == 0 ? lo[w] - 1 : hi[w] + 1;
                if (w == 0) p.reviewWindow = bad;
                if (w == 1) p.disputeWindow = bad;
                if (w == 2) p.arbitrationWindow = bad;
                p.expiredAt = p.deliveryDeadline + 60 days;
                vm.prank(creator);
                vm.expectRevert(abi.encodeWithSelector(IHirelingHolding.WindowOutOfBounds.selector, bad, lo[w], hi[w]));
                holding.publish(p);
            }
        }
        // Exactly at the bounds is fine.
        IHirelingHolding.PublishParams memory ok = params();
        (ok.reviewWindow, ok.disputeWindow, ok.arbitrationWindow) = (1 hours, 14 days, 12 hours);
        ok.expiredAt = ok.deliveryDeadline + 1 hours + 14 days + 12 hours + MARGIN;
        publishWith(ok);
    }

    function test_publish_expiryMustCoverEveryWindowPlusMargin() public {
        IHirelingHolding.PublishParams memory p = params();
        uint256 minimum = uint256(p.deliveryDeadline) + REVIEW + DISPUTE + ARBITRATION + MARGIN;
        p.expiredAt = uint48(minimum - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IHirelingHolding.ExpiryTooShort.selector, p.expiredAt, minimum));
        holding.publish(p);
        p.expiredAt = uint48(minimum);
        publishWith(p);
    }

    function test_publish_refusals() public {
        IHirelingHolding.PublishParams memory p = params();
        p.reward = 0;
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.ZeroReward.selector);
        holding.publish(p);

        p = params();
        p.policyHash = bytes32(0);
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.PolicyHashRequired.selector);
        holding.publish(p);

        p = params();
        p.deliveryDeadline = uint48(block.timestamp);
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.DeadlineInPast.selector);
        holding.publish(p);
    }

    function test_publish_arbitratorConflict() public {
        IHirelingHolding.PublishParams memory p = params();
        p.arbitrator = creator;
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.ArbitratorConflict.selector);
        holding.publish(p);

        p = params();
        address approver = makeAddr("approver");
        p.approver = approver;
        p.arbitrator = approver;
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.ArbitratorConflict.selector);
        holding.publish(p);

        // The default arbitrator publishing its own offer resolves to itself: refused too.
        deal(address(pay), arbitrator, REWARD);
        vm.startPrank(arbitrator);
        pay.approve(address(holding), REWARD);
        p = params();
        vm.expectRevert(IHirelingHolding.ArbitratorConflict.selector);
        holding.publish(p);
        vm.stopPrank();
    }

    function test_publish_customArbitratorAndDefaultChangeNeverTouchLiveListing() public {
        address custom = makeAddr("custom");
        IHirelingHolding.PublishParams memory p = params();
        p.arbitrator = custom;
        uint256 a = publishWith(p);
        uint256 b = publish();
        address rotated = makeAddr("rotated");
        vm.prank(deployer);
        holding.setDefaultArbitrator(rotated);
        uint256 c = publish();
        assertEq(listing(a).arbitrator, custom);
        assertEq(listing(b).arbitrator, arbitrator, "stored at publish");
        assertEq(listing(c).arbitrator, rotated);
    }

    /// @dev M3: a copied policyHash published by someone else no longer blocks the real creator.
    function test_publish_M3_frontRunByAnotherCreatorDoesNotBlock() public {
        IHirelingHolding.PublishParams memory p = params();
        deal(address(pay), stranger, REWARD);
        vm.startPrank(stranger);
        pay.approve(address(holding), REWARD);
        p.creatorBond = 0;
        holding.publish(p);
        vm.stopPrank();
        assertTrue(holding.policyListed(stranger, p.policyHash));
        assertFalse(holding.policyListed(creator, p.policyHash));

        p.creatorBond = CREATOR_BOND;
        uint256 jobId = publishWith(p);
        assertEq(listing(jobId).creator, creator);

        // The creator still cannot fund the same offer twice (R114-07).
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.PolicyHashUsed.selector);
        holding.publish(p);
    }

    function test_publish_refusesShortfallToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        fot.mint(creator, REWARD);
        vm.prank(creator);
        fot.approve(address(holding), REWARD);
        IHirelingHolding.PublishParams memory p = params(IERC20(address(fot)), REWARD, 0, 0);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IHirelingHolding.RewardTokenShortfall.selector, REWARD, REWARD - REWARD / 100)
        );
        holding.publish(p);
    }

    function test_publish_creatorBondNeedsUnreservedStake() public {
        IHirelingHolding.PublishParams memory p = params(IERC20(address(pay)), REWARD, CREATOR_STAKE + 1, 0);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientAvailable.selector, CREATOR_STAKE, CREATOR_STAKE + 1)
        );
        holding.publish(p);
    }

    function test_publish_revokedHoldingPublishesNothingEvenUnbonded() public {
        vm.prank(deployer);
        vault.revokeHolding(address(holding));
        IHirelingHolding.PublishParams memory p = params(IERC20(address(pay)), REWARD, 0, 0);
        vm.prank(creator);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        holding.publish(p);
    }

    // ------------------------------------------------------------------------------------------
    // Activate: fee tiers, snapshot, reservations, roles
    // ------------------------------------------------------------------------------------------

    function test_activate_feePerTier() public {
        uint256[4] memory stakes = [uint256(WORKER_STAKE), 10_000e18, 100_000e18, 1_000_000e18];
        uint16[4] memory expected = [uint16(3000), 1000, 300, 100];
        uint256 kept;
        for (uint256 i; i < 4; ++i) {
            uint256 have = vault.stakeOf(worker);
            if (stakes[i] > have) {
                vm.prank(worker);
                vault.stake(stakes[i] - have);
            }
            uint256 jobId = publish();
            (uint16 bps, uint256 fee, uint256 net) = holding.quoteActivation(jobId, worker);
            assertEq(bps, expected[i]);
            assertEq(fee, REWARD * expected[i] / 10_000);
            assertEq(net, REWARD - fee);
            activate(jobId);
            IHirelingHolding.Listing memory l = listing(jobId);
            assertEq(l.feeBps, expected[i]);
            assertEq(l.fee, fee);
            assertEq(core.getJob(jobId).budget, net, "the core is funded with net only");
            kept += fee;
            assertEq(holding.termsOf(jobId).funded, net);
        }
        assertEq(pay.balanceOf(address(holding)), kept, "Holding keeps exactly the fees");
    }

    function test_activate_reservationsIncludedInTier() public {
        // 9_990 staked + 10 reserved elsewhere = 10_000: the 10 % tier counts reserved stake.
        vm.prank(worker);
        vault.stake(10_000e18 - WORKER_STAKE);
        uint256 jobId = publish();
        activate(jobId);
        assertEq(vault.reservedOf(worker), WORKER_BOND);
        uint256 next = publish();
        (uint16 bps,,) = holding.quoteActivation(next, worker);
        assertEq(bps, 1000);
    }

    function test_activate_feeSnapshot_scheduleChangeNeverReachesLiveJob() public {
        uint256 jobId = submittedJob();
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        IFeeSchedule.Schedule memory zero = defaultSchedule(treasury);
        zero.bps = [uint16(0), 0, 0, 0];
        vm.prank(deployer);
        fees.propose(zero);
        vm.warp(block.timestamp + 3 days);
        fees.execute();
        assertEq(fees.feeBps(0), 0);

        uint256 workerBefore = pay.balanceOf(worker);
        vm.prank(creator);
        evaluator.accept(jobId);
        holding.settle(jobId);
        assertEq(pay.balanceOf(worker) - workerBefore, net);
        assertEq(pay.balanceOf(treasury), fee, "the snapshotted 30 % still applies");
    }

    function test_activate_feeSnapshot_stakeChangeAfterActivationIgnored() public {
        uint256 jobId = fundedJob();
        uint16 before = listing(jobId).feeBps;
        vm.prank(worker);
        vault.stake(1_000_000e18);
        assertEq(listing(jobId).feeBps, before);
        assertEq(holding.termsOf(jobId).funded, REWARD - listing(jobId).fee);
    }

    function test_activate_reservesWorkerBond_blocksUnstake() public {
        uint256 jobId = fundedJob();
        assertTrue(listing(jobId).workerBondReserved);
        assertEq(vault.reservedOf(worker), WORKER_BOND);
        assertEq(factory.balanceOf(address(holding)), 0, "no FACTORY moves at activation");
        vm.prank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientAvailable.selector, WORKER_STAKE - WORKER_BOND, WORKER_STAKE)
        );
        vault.requestUnstake(WORKER_STAKE);
    }

    function test_activate_workerBondNeedsStake() public {
        IHirelingHolding.PublishParams memory p = params(IERC20(address(pay)), REWARD, 0, WORKER_STAKE + 1);
        uint256 jobId = publishWith(p);
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, address(pay), net, 1);
        vm.prank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientAvailable.selector, WORKER_STAKE, WORKER_STAKE + 1)
        );
        holding.activate(sel, sig, auth);
    }

    function test_activate_budgetAuthMustNameNet() public {
        uint256 jobId = publish();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        // Signed for the gross reward: the core rejects it, because Holding sets the budget to `net`.
        ERC8183WithAuthorization.Authorization memory auth =
            budgetAuth(workerPk, worker, jobId, address(pay), REWARD, 1);
        vm.prank(worker);
        vm.expectRevert();
        holding.activate(sel, sig, auth);
    }

    function test_activate_roleConflicts() public {
        // The approver as worker.
        address approver = worker;
        IHirelingHolding.PublishParams memory p = params();
        p.approver = approver;
        uint256 jobId = publishWith(p);
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.RoleConflict.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(worker, 0, 0, ""));

        // The arbitrator as worker.
        p = params();
        p.arbitrator = worker;
        jobId = publishWith(p);
        sel = selectionFor(jobId, worker, AGENT_ID);
        sig = signSelection(creatorPk, sel);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.RoleConflict.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(worker, 0, 0, ""));

        // The creator as worker (with a third-party approver).
        p = params();
        p.approver = makeAddr("approver");
        jobId = publishWith(p);
        sel = selectionFor(jobId, creator, AGENT_ID);
        sig = signSelection(creatorPk, sel);
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.RoleConflict.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(creator, 0, 0, ""));
    }

    function test_activate_selectionChecks() public {
        uint256 jobId = publish();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory none;

        vm.prank(stranger);
        vm.expectRevert(IHirelingHolding.NotSelectedWorker.selector);
        holding.activate(sel, sig, none);

        IHirelingHolding.Selection memory bad = selectionFor(jobId, worker, AGENT_ID);
        bad.termsHash = keccak256("other");
        bytes memory badSig = signSelection(creatorPk, bad);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.TermsMismatch.selector);
        holding.activate(bad, badSig, none);

        bytes memory wrongSigner = signSelection(workerPk, sel);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.InvalidSignature.selector);
        holding.activate(sel, wrongSigner, none);

        bad = selectionFor(jobId, worker, 7);
        badSig = signSelection(creatorPk, bad);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.NotAgentWallet.selector);
        holding.activate(bad, badSig, none);

        vm.prank(creator);
        holding.cancelSelection(sel.nonce);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.SelectionNonceUsed.selector);
        holding.activate(sel, sig, none);

        bad = selectionFor(jobId, worker, AGENT_ID);
        bad.nonce = 99;
        badSig = signSelection(creatorPk, bad);
        vm.warp(bad.activateBy + 1);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.SelectionExpired.selector);
        holding.activate(bad, badSig, none);
    }

    function test_activate_onceOnly() public {
        uint256 jobId = fundedJob();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        sel.nonce = 77;
        bytes memory sig = signSelection(creatorPk, sel);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.AlreadyActivated.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(worker, 0, 0, ""));
    }

    // ------------------------------------------------------------------------------------------
    // Cancel
    // ------------------------------------------------------------------------------------------

    function test_cancel_refundsInOneTransaction_noFee_bondReleased() public {
        uint256 jobId = publish();
        uint256 before = pay.balanceOf(creator);
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        assertEq(pay.balanceOf(creator), before + REWARD, "the whole reward, no fee");
        assertEq(vault.reservedOf(creator), 0);
        IHirelingHolding.Listing memory l = listing(jobId);
        assertEq(uint8(l.outcome), uint8(IHirelingHolding.Outcome.Refunded));
        assertTrue(l.rewardSettled && l.creatorBondSettled);
        vm.expectRevert(IHirelingHolding.NothingToSettle.selector);
        holding.settle(jobId);
    }

    function test_cancel_onlyCreatorBeforeActivation() public {
        uint256 jobId = publish();
        vm.prank(stranger);
        vm.expectRevert(IHirelingHolding.NotCreator.selector);
        holding.cancel(jobId);
        activate(jobId);
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.AlreadyActivated.selector);
        holding.cancel(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Settle: the money table
    // ------------------------------------------------------------------------------------------

    function test_settle_completed_feeToTreasury_bondsReleased() public {
        uint256 jobId = submittedJob();
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 workerBefore = pay.balanceOf(worker);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker) - workerBefore, net, "the core paid net");
        assertEq(vault.reservedOf(worker), 0);
        assertEq(vault.reservedOf(creator), 0);

        vm.expectEmit(address(holding));
        emit IHirelingHolding.FeeCharged(jobId, address(pay), worker, creator, fee, 0);
        holding.settle(jobId);
        assertEq(pay.balanceOf(treasury), fee);
        assertEq(pay.balanceOf(address(holding)), 0);
        assertEq(uint8(listing(jobId).outcome), uint8(IHirelingHolding.Outcome.Paid));
    }

    function test_topUp_paid_bonusMinusBonusFeeToWorker() public {
        uint256 jobId = fundedJob();
        topUp(jobId, contributor, 50e6);
        submit(jobId);
        topUp(jobId, contributor, 10e6);
        assertEq(listing(jobId).bonus, 60e6);
        assertEq(holding.topUpOf(jobId, contributor), 60e6);

        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 bonusFee = 60e6 * 3000 / 10_000;
        uint256 workerBefore = pay.balanceOf(worker);
        vm.prank(creator);
        evaluator.accept(jobId);
        vm.expectEmit(address(holding));
        emit IHirelingHolding.FeeCharged(jobId, address(pay), worker, creator, fee + bonusFee, bonusFee);
        holding.settle(jobId);
        assertEq(pay.balanceOf(worker) - workerBefore, net + 60e6 - bonusFee);
        assertEq(pay.balanceOf(treasury), fee + bonusFee);
        assertEq(pay.balanceOf(address(holding)), 0);

        vm.expectRevert(IHirelingHolding.TopUpNotRefundable.selector);
        holding.claimTopUpRefund(jobId, contributor);
    }

    function test_topUp_refunded_pullPerContributor() public {
        uint256 jobId = fundedJob();
        topUp(jobId, contributor, 40e6);
        deal(address(pay), stranger, 5e6);
        vm.startPrank(stranger);
        pay.approve(address(holding), 5e6);
        holding.topUp(jobId, 5e6);
        vm.stopPrank();

        // Not refundable until the reward is settled back to the creator.
        vm.expectRevert(IHirelingHolding.TopUpNotRefundable.selector);
        holding.claimTopUpRefund(jobId, contributor);

        // Missed delivery: refund, worker bond slashed.
        vm.warp(listing(jobId).deliveryDeadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        uint256 creatorBefore = pay.balanceOf(creator);
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator) - creatorBefore, REWARD, "reward back with the fee");
        assertEq(pay.balanceOf(treasury), 0);

        uint256 before = pay.balanceOf(contributor);
        vm.prank(relayer);
        holding.claimTopUpRefund(jobId, contributor);
        assertEq(pay.balanceOf(contributor) - before, 40e6, "anyone triggers; the contributor is paid");
        vm.expectRevert(IHirelingHolding.NothingToRefund.selector);
        holding.claimTopUpRefund(jobId, contributor);
        vm.prank(stranger);
        holding.claimTopUpRefund(jobId, stranger);
        assertEq(pay.balanceOf(stranger), 5e6);
        assertEq(pay.balanceOf(address(holding)), 0);
    }

    function test_topUp_onlyWhileActive() public {
        uint256 jobId = publish();
        vm.prank(contributor);
        vm.expectRevert(IHirelingHolding.NotActive.selector);
        holding.topUp(jobId, 1e6);

        activate(jobId);
        vm.prank(contributor);
        vm.expectRevert(IHirelingHolding.ZeroAmount.selector);
        holding.topUp(jobId, 0);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        vm.prank(contributor);
        vm.expectRevert(IHirelingHolding.NotActive.selector);
        holding.topUp(jobId, 1e6);
    }

    function test_settle_earnedAfterThirdPartyClaimRefund() public {
        uint256 jobId = fundedJob();
        topUp(jobId, contributor, 20e6);
        submit(jobId);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        uint256 bonusFee = 20e6 * 3000 / 10_000;
        // Nobody calls the silence timeout; the core expires and a stranger claims the refund into Holding.
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        vm.prank(stranger);
        core.claimRefund(jobId);
        uint256 workerBefore = pay.balanceOf(worker);
        holding.settle(jobId);
        assertEq(pay.balanceOf(worker) - workerBefore, net + 20e6 - bonusFee, "R114-03 silence right survives");
        assertEq(pay.balanceOf(treasury), fee + bonusFee);
        assertEq(vault.reservedOf(worker), 0);
        assertEq(vault.stakeOf(worker), WORKER_STAKE, "earned: bond released");
    }

    function test_settle_onlyWhenTerminal_andOnce() public {
        uint256 jobId = fundedJob();
        vm.expectRevert(IHirelingHolding.NotTerminal.selector);
        holding.settle(jobId);
        vm.expectRevert(IHirelingHolding.UnknownJob.selector);
        holding.settle(999);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        holding.settle(jobId);
        vm.expectRevert(IHirelingHolding.NothingToSettle.selector);
        holding.settle(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // Refusing tokens fall back to `owed` (ADR-0010)
    // ------------------------------------------------------------------------------------------

    function _blockyJob() internal returns (BlocklistToken blk, uint256 jobId) {
        blk = new BlocklistToken();
        blk.mint(creator, REWARD);
        blk.mint(contributor, REWARD);
        vm.prank(creator);
        blk.approve(address(holding), REWARD);
        vm.prank(contributor);
        blk.approve(address(holding), REWARD);
        jobId = publishWith(params(IERC20(address(blk)), REWARD, CREATOR_BOND, WORKER_BOND));
    }

    function test_owed_treasuryRefusesFee_workerStillPaid() public {
        (BlocklistToken blk, uint256 jobId) = _blockyJob();
        activate(jobId);
        submit(jobId);
        (uint256 fee, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        vm.prank(creator);
        evaluator.accept(jobId);
        blk.setBlocked(treasury, true);
        holding.settle(jobId);
        assertEq(blk.balanceOf(worker), net);
        assertEq(holding.owed(IERC20(address(blk)), treasury), fee);
        blk.setBlocked(treasury, false);
        vm.prank(treasury);
        holding.withdraw(IERC20(address(blk)));
        assertEq(blk.balanceOf(treasury), fee);
        vm.prank(treasury);
        vm.expectRevert(IHirelingHolding.NothingOwed.selector);
        holding.withdraw(IERC20(address(blk)));
    }

    function test_owed_creatorRefusesRefund_bondsStillSettle() public {
        (BlocklistToken blk, uint256 jobId) = _blockyJob();
        blk.setBlocked(creator, true);
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(holding.owed(IERC20(address(blk)), creator), REWARD);
        assertEq(vault.reservedOf(creator), 0, "the bond never waits on the reward token");
    }

    function test_owed_gasBombBonusPushCannotBlockSettle() public {
        GasHungryToken hungry = new GasHungryToken();
        hungry.mint(creator, REWARD);
        hungry.mint(contributor, REWARD);
        vm.prank(creator);
        hungry.approve(address(holding), REWARD);
        vm.prank(contributor);
        hungry.approve(address(holding), REWARD);
        uint256 jobId = publishWith(params(IERC20(address(hungry)), REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        topUp(jobId, contributor, 10e6);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        // From now on every transfer to the worker never finishes.
        hungry.setHungry(worker, type(uint256).max);
        holding.settle{gas: 2_000_000}(jobId);
        uint256 bonusFee = 10e6 * 3000 / 10_000;
        assertEq(holding.owed(IERC20(address(hungry)), worker), 10e6 - bonusFee);
        assertGt(hungry.balanceOf(treasury), 0, "the other payee is still paid");
    }

    function test_settle_needsGasForTheFullPushBudget() public {
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.accept(jobId);
        // Too little gas for a push: revert instead of silently routing an honest payee into `owed`.
        vm.expectRevert();
        holding.settle{gas: 200_000}(jobId);
        holding.settle(jobId);
        assertEq(holding.owed(IERC20(address(pay)), treasury), 0);
    }

    // ------------------------------------------------------------------------------------------
    // Admin and access
    // ------------------------------------------------------------------------------------------

    function test_bondMovesAreEvaluatorOnly() public {
        uint256 jobId = fundedJob();
        vm.prank(stranger);
        vm.expectRevert(IHirelingHolding.NotEvaluator.selector);
        holding.burnBond(jobId, IHirelingHolding.Side.Worker);
        vm.prank(stranger);
        vm.expectRevert(IHirelingHolding.NotEvaluator.selector);
        holding.returnBonds(jobId);
    }

    function test_admin_setEvaluatorOnce_defaultArbitratorOwnerOnly() public {
        vm.prank(deployer);
        vm.expectRevert(IHirelingHolding.EvaluatorAlreadySet.selector);
        holding.setEvaluator(stranger);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        holding.setDefaultArbitrator(stranger);
        vm.prank(deployer);
        vm.expectRevert(IHirelingHolding.ZeroAddress.selector);
        holding.setDefaultArbitrator(address(0));
    }

    function test_termsOf() public {
        uint256 jobId = publish();
        IHirelingHolding.Terms memory t = holding.termsOf(jobId);
        assertEq(t.creator, creator);
        assertEq(t.arbitrator, arbitrator);
        assertEq(t.worker, address(0));
        assertEq(t.funded, 0);
        activate(jobId);
        t = holding.termsOf(jobId);
        assertEq(t.worker, worker);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(t.funded, net);
        assertEq(t.reviewWindow, REVIEW);
    }
}

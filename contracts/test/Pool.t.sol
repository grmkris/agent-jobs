// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobPool} from "../src/JobPool.sol";
import {JobPoolFactory} from "../src/JobPoolFactory.sol";

/// @dev JobPool (ADR-0007): pooled funding of one offer, the pool as creator, the curator as approver and signer.
contract PoolTest is Base {
    JobPoolFactory internal poolFactory;
    address internal curator;
    uint256 internal curatorPk;
    address internal pledgerA = makeAddr("pledgerA");
    address internal pledgerB = makeAddr("pledgerB");
    bytes32 internal constant SALT = keccak256("pool-1");

    function setUp() public override {
        super.setUp();
        (curator, curatorPk) = makeAddrAndKey("curator");
        poolFactory = new JobPoolFactory();
        vm.prank(creator);
        factory.approve(address(poolFactory), type(uint256).max);
        pay.mint(pledgerA, 10 * REWARD);
        pay.mint(pledgerB, 10 * REWARD);
    }

    // ------------------------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------------------------

    function poolParams(JobHolding.Mode mode) internal returns (JobPool.Params memory p) {
        JobHolding.PublishParams memory pub = params(REWARD, 0, mode == JobHolding.Mode.Contest ? 0 : WORKER_BOND);
        pub.approver = curator;
        pub.mode = mode;
        if (mode == JobHolding.Mode.Contest) pub.selectionDeadline = uint48(block.timestamp + 3 days);
        p = JobPool.Params({
            token: IERC20(address(pay)),
            goal: REWARD,
            pledgeDeadline: uint48(block.timestamp + 1 days),
            curator: curator,
            holding: holding,
            publish: pub,
            governance: 0,
            holdProvider: address(0)
        });
    }

    function createPool(JobHolding.Mode mode) internal returns (JobPool pool) {
        JobPool.Params memory p = poolParams(mode);
        vm.prank(creator);
        pool = JobPool(poolFactory.create(SALT, p));
        vm.prank(pledgerA);
        pay.approve(address(pool), type(uint256).max);
        vm.prank(pledgerB);
        pay.approve(address(pool), type(uint256).max);
    }

    function fundedPool(JobHolding.Mode mode) internal returns (JobPool pool) {
        pool = createPool(mode);
        vm.prank(pledgerA);
        pool.pledge(REWARD * 60 / 100);
        vm.prank(pledgerB);
        pool.pledge(REWARD * 40 / 100);
    }

    function launchedPool(JobHolding.Mode mode) internal returns (JobPool pool, uint256 jobId) {
        pool = fundedPool(mode);
        jobId = pool.launch();
    }

    function curatorSelection(uint256 jobId) internal view returns (JobHolding.Selection memory sel, bytes memory sig) {
        sel = selectionFor(jobId, worker, AGENT_ID);
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(curatorPk, holding.selectionDigest(sel));
        sig = abi.encodePacked(r, s_, v);
    }

    function activateForPool(uint256 jobId) internal {
        (JobHolding.Selection memory sel, bytes memory sig) = curatorSelection(jobId);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, REWARD, uint72(jobId));
        vm.prank(worker);
        holding.activate(sel, sig, auth);
    }

    // ------------------------------------------------------------------------------------------
    // creation
    // ------------------------------------------------------------------------------------------

    function test_predictMatchesCreate() public {
        address predicted = poolFactory.predict(creator, SALT);
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        assertEq(address(pool), predicted);
        assertEq(pool.creator(), creator);
        assertEq(pool.curator(), curator);
        assertEq(pool.goal(), REWARD);
        assertEq(poolFactory.poolCount(), 1);
        assertEq(uint8(pool.phase()), uint8(JobPool.Phase.Funding));
        // The offer names the pool as creator and the curator as approver.
        JobPool.Params memory p = pool.params();
        assertEq(p.publish.approver, curator);
        assertEq(p.holdProvider, creator);
    }

    function test_create_pullsTheHoldIntoThePool() public {
        uint256 before = factory.balanceOf(creator);
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        assertEq(factory.balanceOf(address(pool)), MIN_HOLD);
        assertEq(factory.balanceOf(creator), before - MIN_HOLD);
        assertEq(pool.holdAmount(), MIN_HOLD);
    }

    function test_governanceNonZeroReverts() public {
        JobPool.Params memory p = poolParams(JobHolding.Mode.HireFirst);
        p.governance = 1;
        vm.prank(creator);
        vm.expectRevert(JobPool.GovernanceUnsupported.selector);
        poolFactory.create(SALT, p);
    }

    function test_create_rejectsACreatorBondOrAForeignApprover() public {
        JobPool.Params memory p = poolParams(JobHolding.Mode.HireFirst);
        p.publish.creatorBond = 1;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(JobPool.BadParams.selector, "creatorBond"));
        poolFactory.create(SALT, p);
        p = poolParams(JobHolding.Mode.HireFirst);
        p.publish.approver = stranger;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(JobPool.BadParams.selector, "approver"));
        poolFactory.create(SALT, p);
    }

    function test_implementationCannotBeInitialised() public {
        JobPool impl = poolFactory.implementation();
        // Precomputed: the helper makes view calls, which would otherwise consume the expected revert.
        JobPool.Params memory p = poolParams(JobHolding.Mode.HireFirst);
        vm.expectRevert(JobPool.AlreadyInitialized.selector);
        impl.initialize(creator, p, 0);
    }

    // ------------------------------------------------------------------------------------------
    // pledging
    // ------------------------------------------------------------------------------------------

    function test_pledge_capsAtGoal() public {
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        vm.prank(pledgerA);
        pool.pledge(REWARD * 60 / 100);
        uint256 before = pay.balanceOf(pledgerB);
        vm.prank(pledgerB);
        pool.pledge(REWARD); // asks for the whole goal, gets the remaining 40 %
        assertEq(pay.balanceOf(pledgerB), before - REWARD * 40 / 100);
        assertEq(pool.pledged(pledgerB), REWARD * 40 / 100);
        assertEq(pool.totalPledged(), REWARD);
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.OverGoal.selector);
        pool.pledge(1);
    }

    function test_unpledge_beforeLaunch() public {
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        vm.prank(pledgerA);
        pool.pledge(REWARD * 60 / 100);
        uint256 before = pay.balanceOf(pledgerA);
        vm.prank(pledgerA);
        pool.unpledge(REWARD * 10 / 100);
        assertEq(pay.balanceOf(pledgerA), before + REWARD * 10 / 100);
        assertEq(pool.totalPledged(), REWARD * 50 / 100);
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.NothingToRefund.selector);
        pool.unpledge(REWARD);
    }

    function test_unpledge_refusedOnceFull() public {
        JobPool pool = fundedPool(JobHolding.Mode.HireFirst);
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.PoolFull.selector);
        pool.unpledge(1);
    }

    function test_pledge_afterDeadlineReverts() public {
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.NotFunding.selector);
        pool.pledge(1);
    }

    // ------------------------------------------------------------------------------------------
    // launch
    // ------------------------------------------------------------------------------------------

    function test_launch_requiresGoal() public {
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        vm.prank(pledgerA);
        pool.pledge(REWARD * 60 / 100);
        vm.expectRevert(JobPool.GoalNotReached.selector);
        pool.launch();
    }

    function test_launch_publishesWithPoolAsCreatorAndCuratorAsApprover() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.HireFirst);
        JobHolding.Listing memory l = listing(jobId);
        assertEq(l.creator, address(pool));
        assertEq(l.approver, curator);
        assertEq(l.reward, REWARD);
        assertEq(l.creatorBond, 0);
        assertEq(pool.jobId(), jobId);
        assertEq(uint8(pool.phase()), uint8(JobPool.Phase.Launched));
        assertEq(pay.balanceOf(address(pool)), 0);
        assertEq(pay.balanceOf(address(holding)), REWARD);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Open));
        vm.expectRevert(JobPool.AlreadyLaunched.selector);
        pool.launch();
    }

    function test_launch_holdGate_factoryDepositCoversMinHold() public {
        JobPool pool = fundedPool(JobHolding.Mode.HireFirst);
        // Raise the gate above what the factory placed here: Holding refuses the pool.
        vm.prank(deployer);
        holding.setHoldRequirements(MIN_HOLD + 1, MIN_HOLD);
        vm.expectRevert(abi.encodeWithSelector(JobHolding.InsufficientFactoryHeld.selector, MIN_HOLD, MIN_HOLD + 1));
        pool.launch();
        vm.prank(deployer);
        holding.setHoldRequirements(MIN_HOLD, MIN_HOLD);
        pool.launch();
    }

    function test_launch_afterGraceReverts() public {
        JobPool pool = fundedPool(JobHolding.Mode.HireFirst);
        vm.warp(block.timestamp + 2 days + 1);
        vm.expectRevert(JobPool.PledgeDeadlinePassed.selector);
        pool.launch();
        assertEq(uint8(pool.phase()), uint8(JobPool.Phase.Expired));
    }

    // ------------------------------------------------------------------------------------------
    // the curator acts for the pool
    // ------------------------------------------------------------------------------------------

    function test_hire_activateWithCuratorSignedSelection() public {
        (, uint256 jobId) = launchedPool(JobHolding.Mode.HireFirst);
        // A selection the creator key (not the curator) signed is refused: the pool honours only its curator.
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory wrong = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, REWARD, uint72(jobId));
        vm.prank(worker);
        vm.expectRevert(JobHolding.InvalidSignature.selector);
        holding.activate(sel, wrong, auth);
        activateForPool(jobId);
        assertEq(listing(jobId).worker, worker);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Funded));
    }

    function test_hire_acceptByCurator_paysWorker_refundsNothing() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.HireFirst);
        activateForPool(jobId);
        submitDirect(jobId);
        vm.prank(curator);
        evaluator.accept(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
        assertEq(pay.balanceOf(worker), REWARD);
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.NothingToRefund.selector);
        pool.refund();
    }

    function test_contest_awardByCurator_paysEntrant() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.Contest);
        JobHolding.Candidate memory c = candidate(jobId, worker, workerPk, AGENT_ID, DELIVERABLE, 7);
        vm.prank(stranger);
        vm.expectRevert(JobHolding.NotApprover.selector);
        holding.award(jobId, c);
        vm.prank(curator);
        holding.award(jobId, c);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Completed));
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.NothingToRefund.selector);
        pool.refund();
    }

    function test_cancelSelection_forwardsToHolding() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.HireFirst);
        (JobHolding.Selection memory sel, bytes memory sig) = curatorSelection(jobId);
        vm.prank(stranger);
        vm.expectRevert(JobPool.NotCurator.selector);
        pool.cancelSelection(sel.nonce);
        vm.prank(curator);
        pool.cancelSelection(sel.nonce);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, REWARD, uint72(jobId));
        vm.prank(worker);
        vm.expectRevert(JobHolding.SelectionNonceUsed.selector);
        holding.activate(sel, sig, auth);
    }

    // ------------------------------------------------------------------------------------------
    // refunds
    // ------------------------------------------------------------------------------------------

    function test_cancel_thenSettle_refundsProRata() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.HireFirst);
        vm.prank(stranger);
        vm.expectRevert(JobPool.NotCurator.selector);
        pool.cancel();
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.JobNotTerminal.selector);
        pool.refund();
        vm.prank(curator);
        pool.cancel();
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        uint256 a = pay.balanceOf(pledgerA);
        uint256 b = pay.balanceOf(pledgerB);
        vm.prank(pledgerA);
        pool.refund(); // settles the listing on the way
        vm.prank(pledgerB);
        pool.refund();
        assertEq(pay.balanceOf(pledgerA) - a, REWARD * 60 / 100);
        assertEq(pay.balanceOf(pledgerB) - b, REWARD * 40 / 100);
        assertEq(pay.balanceOf(address(pool)), 0);
        assertEq(pool.paidOut(), REWARD);
        assertTrue(pool.refundable());
    }

    function test_refund_isIdempotent() public {
        (JobPool pool,) = launchedPool(JobHolding.Mode.HireFirst);
        vm.prank(curator);
        pool.cancel();
        vm.startPrank(pledgerA);
        pool.refund();
        vm.expectRevert(JobPool.NothingToRefund.selector);
        pool.refund();
        vm.stopPrank();
    }

    function test_cancelPool_thenRefundsInFull() public {
        JobPool pool = fundedPool(JobHolding.Mode.HireFirst);
        vm.prank(curator);
        pool.cancelPool();
        assertEq(uint8(pool.phase()), uint8(JobPool.Phase.Cancelled));
        vm.expectRevert(JobPool.NotFunding.selector);
        pool.launch();
        uint256 a = pay.balanceOf(pledgerA);
        vm.prank(pledgerA);
        pool.refund();
        assertEq(pay.balanceOf(pledgerA) - a, REWARD * 60 / 100);
    }

    function test_expiredUnlaunched_refundsAll() public {
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        vm.prank(pledgerA);
        pool.pledge(REWARD * 60 / 100);
        vm.prank(pledgerA);
        vm.expectRevert(JobPool.NotLaunched.selector);
        pool.refund();
        vm.warp(block.timestamp + 2 days + 1);
        uint256 a = pay.balanceOf(pledgerA);
        vm.prank(pledgerA);
        pool.refund();
        assertEq(pay.balanceOf(pledgerA) - a, REWARD * 60 / 100);
    }

    function test_missedDelivery_burnAndRefund() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.HireFirst);
        activateForPool(jobId);
        uint256 supply = circulating();
        vm.warp(holding.deliveryDeadlineOf(jobId) + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        assertEq(uint8(status(jobId)), uint8(ERC8183.JobStatus.Rejected));
        uint256 a = pay.balanceOf(pledgerA);
        vm.prank(pledgerA);
        pool.refund();
        assertEq(pay.balanceOf(pledgerA) - a, REWARD * 60 / 100);
        // The worker's bond burned; the pool posted none.
        assertEq(circulating(), supply - WORKER_BOND);
    }

    function test_expiredContest_refunds() public {
        (JobPool pool, uint256 jobId) = launchedPool(JobHolding.Mode.Contest);
        vm.warp(listing(jobId).selectionDeadline + 1);
        holding.expireContest(jobId);
        uint256 b = pay.balanceOf(pledgerB);
        vm.prank(pledgerB);
        pool.refund();
        assertEq(pay.balanceOf(pledgerB) - b, REWARD * 40 / 100);
    }

    function test_reclaimHold_afterTerminal() public {
        (JobPool pool,) = launchedPool(JobHolding.Mode.HireFirst);
        vm.expectRevert(JobPool.HoldNotReclaimable.selector);
        pool.reclaimHold();
        vm.prank(curator);
        pool.cancel();
        uint256 before = factory.balanceOf(creator);
        pool.reclaimHold();
        assertEq(factory.balanceOf(creator) - before, MIN_HOLD);
        assertEq(factory.balanceOf(address(pool)), 0);
        vm.expectRevert(JobPool.HoldNotReclaimable.selector);
        pool.reclaimHold();
    }

    function test_isValidSignature_curatorOnly() public {
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        bytes32 digest = keccak256("anything");
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(curatorPk, digest);
        assertEq(pool.isValidSignature(digest, abi.encodePacked(r, s_, v)), bytes4(0x1626ba7e));
        (v, r, s_) = vm.sign(creatorPk, digest);
        assertEq(pool.isValidSignature(digest, abi.encodePacked(r, s_, v)), bytes4(0xffffffff));
    }

    function testFuzz_proRata_sumsToAvailable(uint96 a, uint96 b) public {
        a = uint96(bound(a, 1, REWARD - 1));
        b = uint96(REWARD - a);
        JobPool pool = createPool(JobHolding.Mode.HireFirst);
        vm.prank(pledgerA);
        pool.pledge(a);
        vm.prank(pledgerB);
        pool.pledge(b);
        pool.launch();
        vm.prank(curator);
        pool.cancel();
        uint256 a0 = pay.balanceOf(pledgerA);
        uint256 b0 = pay.balanceOf(pledgerB);
        vm.prank(pledgerA);
        pool.refund();
        vm.prank(pledgerB);
        pool.refund();
        uint256 ra = pay.balanceOf(pledgerA) - a0;
        uint256 rb = pay.balanceOf(pledgerB) - b0;
        assertLe(ra, a);
        assertLe(rb, b);
        assertEq(ra + rb, REWARD);
        assertEq(pool.paidOut(), REWARD);
    }
}

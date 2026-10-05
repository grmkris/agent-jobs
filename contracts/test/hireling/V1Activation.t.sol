// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Ports of the legacy Activation suite to v1.
contract V1ActivationTest is BaseV1 {
    function test_activation_atActivateByAllowed_afterRefused() public {
        uint256 jobId = publish();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        sel.activateBy = uint48(block.timestamp + 1 days);
        uint256 snap = vm.snapshotState();
        vm.warp(sel.activateBy);
        activateAs(sel, workerPk);
        assertTrue(listing(jobId).funded);
        vm.revertToState(snap);
        vm.warp(sel.activateBy + 1);
        bytes memory sig = signSelection(creatorPk, sel);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.SelectionExpired.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(worker, 0, 0, ""));
    }

    function test_activation_activateByMustPrecedeDeliveryDeadline() public {
        uint256 jobId = publish();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        sel.activateBy = listing(jobId).deliveryDeadline;
        bytes memory sig = signSelection(creatorPk, sel);
        vm.prank(worker);
        vm.expectRevert(IHirelingHolding.SelectionInvalid.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(worker, 0, 0, ""));
    }

    function test_activation_registryWalletChangeAfterwardsLeavesPayoutUnchanged() public {
        uint256 jobId = submittedJob();
        identity.setAgentWallet(AGENT_ID, makeAddr("newWallet"));
        vm.prank(creator);
        evaluator.accept(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(pay.balanceOf(worker), net);
    }

    function test_activation_lapsedSelectionLetsTheNextApplicantActivate() public {
        (address second, uint256 secondPk) = makeAddrAndKey("second");
        identity.setAgentWallet(7, second);
        vm.prank(deployer);
        factory.transfer(second, WORKER_BOND);
        vm.startPrank(second);
        factory.approve(address(vault), WORKER_BOND);
        vault.delegate(second, WORKER_BOND);
        vm.stopPrank();
        uint256 jobId = publish();
        IHirelingHolding.Selection memory first = selectionFor(jobId, worker, AGENT_ID);
        first.activateBy = uint48(block.timestamp + 1 hours);
        vm.warp(first.activateBy + 1);
        IHirelingHolding.Selection memory next = selectionFor(jobId, second, 7);
        next.nonce = 1_000;
        activateAs(next, secondPk);
        assertEq(listing(jobId).worker, second);
        assertEq(listing(jobId).feeBps, 3000, "an unstaked worker pays the top rate");
    }

    /// @dev Any failure inside activation (here the budget authorization) undoes the reservation and the nonce.
    function test_activation_isAtomic() public {
        uint256 jobId = publish();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory bad = budgetAuth(workerPk, worker, jobId, address(pay), 1, 1);
        vm.prank(worker);
        vm.expectRevert();
        holding.activate(sel, sig, bad);
        assertEq(vault.reservedOf(worker), 0);
        assertFalse(holding.selectionNonceUsed(creator, sel.nonce));
        assertFalse(listing(jobId).funded);
        assertEq(uint8(core.getJob(jobId).status), uint8(ERC8183.JobStatus.Open));
        activate(jobId);
        assertTrue(listing(jobId).funded);
    }

    function test_activation_creatorCannotActivateOnTheWorkersBehalf() public {
        uint256 jobId = publish();
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        vm.prank(creator);
        vm.expectRevert(IHirelingHolding.NotSelectedWorker.selector);
        holding.activate(sel, sig, ERC8183WithAuthorization.Authorization(worker, 0, 0, ""));
    }

    function test_activation_afterRevocationRefused_creatorCanStillCancel() public {
        uint256 jobId = publish();
        vm.prank(deployer);
        vault.revokeHolding(address(holding));
        IHirelingHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, address(pay), net, 1);
        vm.prank(worker);
        vm.expectRevert();
        holding.activate(sel, sig, auth);
        vm.prank(creator);
        holding.cancel(jobId);
        assertEq(pay.balanceOf(creator), 10 * REWARD);
        assertEq(vault.reservedOf(creator), 0, "a revoked Holding still releases its reservations");
    }
}

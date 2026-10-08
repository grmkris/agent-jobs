// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SidequestClocks} from "../../src/sidequest/SidequestClocks.sol";
import {BaseV1} from "./BaseV1.t.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";

contract BondHorizonTest is BaseV1 {
    function horizonParams() internal returns (ISidequestHolding.PublishParams memory p) {
        p = params();
        p.deliveryDeadline = uint48(block.timestamp + 1 days);
        p.reviewWindow = 1 hours;
        p.disputeWindow = 1 hours;
        p.arbitrationWindow = 12 hours;
        p.expiredAt = p.deliveryDeadline + 14 hours + MARGIN;
    }

    function test_publish_refusesCreatorBondBeyondHorizonAtomically() public {
        ISidequestHolding.PublishParams memory p = horizonParams();
        uint256 latest = block.timestamp + vault.UNSTAKE_DELAY();
        p.expiredAt = uint48(latest + 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ISidequestHolding.BondOutlastsUnbonding.selector, p.expiredAt, latest));
        holding.publish(p);
        assertEq(vault.reservedOf(creator), 0);
        assertEq(pay.balanceOf(address(holding)), 0);
        assertFalse(holding.policyListed(creator, p.policyHash));
    }

    function test_publish_andActivateAcceptExactHorizon() public {
        ISidequestHolding.PublishParams memory p = horizonParams();
        p.expiredAt = uint48(block.timestamp + vault.UNSTAKE_DELAY());
        uint256 job = publishWith(p);
        activate(job);
        assertEq(vault.reservedOf(creator), CREATOR_BOND);
        assertEq(vault.reservedOf(worker), WORKER_BOND);
    }

    function test_activate_refusesWorkerBondBeyondHorizonAtomically() public {
        ISidequestHolding.PublishParams memory p = horizonParams();
        p.creatorBond = 0;
        uint256 latest = block.timestamp + vault.UNSTAKE_DELAY();
        p.expiredAt = uint48(latest + 1);
        uint256 job = publishWith(p);
        // The selection signature is valid; only the bond horizon refuses it.
        ISidequestHolding.Selection memory sel = selectionFor(job, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        (,, uint256 net) = holding.quoteActivation(job, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            budgetAuth(workerPk, worker, job, address(pay), net, uint72(job));
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(ISidequestHolding.BondOutlastsUnbonding.selector, p.expiredAt, latest));
        holding.activate(sel, sig, auth);
        assertEq(vault.reservedOf(worker), 0);
        assertFalse(listing(job).funded);
        assertFalse(holding.selectionNonceUsed(creator, sel.nonce));
        // Activation later uses its own clock and now fits exactly.
        vm.warp(block.timestamp + 1);
        activate(job);
        assertTrue(listing(job).funded);
    }

    function test_zeroBondsAllowLongExpiryAndMaximumWindows() public {
        ISidequestHolding.PublishParams memory p = horizonParams();
        p.creatorBond = 0;
        p.workerBond = 0;
        p.deliveryDeadline = uint48(block.timestamp + 90 days);
        p.reviewWindow = 14 days;
        p.disputeWindow = 14 days;
        p.arbitrationWindow = 14 days;
        p.expiredAt = p.deliveryDeadline + 42 days + MARGIN;
        uint256 job = publishWith(p);
        activate(job);
        assertTrue(listing(job).funded);
    }

    function testFuzz_bondsReservedBeforeExitExpireByUnlock(uint48 expiryOffset, uint48 requestOffset) public {
        ISidequestHolding.PublishParams memory p = horizonParams();
        uint256 minimumOffset = p.expiredAt - block.timestamp;
        p.expiredAt = uint48(block.timestamp + bound(expiryOffset, minimumOffset, vault.UNSTAKE_DELAY()));
        uint256 job = publishWith(p);
        activate(job);
        vm.warp(block.timestamp + bound(requestOffset, 0, 30 days));
        vm.prank(creator);
        vault.requestUndelegate(creator, 1e18);
        vm.prank(worker);
        vault.requestUndelegate(worker, 1e18);
        assertLe(listing(job).expiredAt, vault.positionOf(creator, creator).unlockAt);
        assertLe(listing(job).expiredAt, vault.positionOf(worker, worker).unlockAt);
    }
}

contract TestnetBondHorizonTest is BondHorizonTest {
    function clocks() internal pure override returns (SidequestClocks.Config memory c) {
        c = SidequestClocks.production();
        c.unstakeDelay = 3 days;
        c.holdingDelay = 3 days + 1 hours;
    }
}

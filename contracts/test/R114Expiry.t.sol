// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev R114-03, found at 47c4dd2 (an earned payment lost after core expiry), written as counterexamples before the
///      fix (spec §13, S7 row). Recovery is attempted through every Holding entry point by low-level call, so these
///      tests state the money outcome, not the name of the function that delivers it.
contract R114ExpiryTest is Base {
    // ------------------------------------------------------------------------------------------
    // R114-03: an earned payment survives the core's outer expiry
    // ------------------------------------------------------------------------------------------

    /// @dev Every party tries every Holding recovery path, twice; whatever exists must pay each amount once.
    function _recoverAll(uint256 jobId) internal {
        for (uint256 i; i < 2; ++i) {
            vm.prank(creator);
            (bool ok,) = address(holding).call(abi.encodeWithSignature("withdraw(uint256)", jobId));
            vm.prank(worker);
            (ok,) = address(holding).call(abi.encodeWithSignature("withdrawWorkerBond(uint256)", jobId));
            vm.prank(stranger);
            (ok,) = address(holding).call(abi.encodeWithSignature("settle(uint256)", jobId));
            ok;
        }
    }

    function _pastCoreExpiry(uint256 jobId) internal {
        vm.warp(uint256(core.getJob(jobId).expiredAt) + core.EVALUATION_GRACE_PERIOD());
    }

    /// @dev The counterexample: timely submit, review window passes, nobody settles, a third party calls the
    ///      core's `claimRefund`. The reward lands in Holding as custody; the worker earned it.
    function test_R114_03_silenceThenThirdPartyRefund_paysWorkerOnce() public {
        uint256 creatorPay = pay.balanceOf(creator);
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = submittedJob();
        _pastCoreExpiry(jobId);
        vm.prank(stranger);
        core.claimRefund(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Expired));

        _recoverAll(jobId);
        assertEq(pay.balanceOf(worker), REWARD, "the earned reward reaches the worker");
        assertEq(pay.balanceOf(creator), creatorPay - REWARD, "the creator does not get it back");
        assertEq(factory.balanceOf(creator), cFac, "creator bond back");
        assertEq(factory.balanceOf(worker), wFac, "worker bond back");
        assertEq(pay.balanceOf(address(holding)) + factory.balanceOf(address(holding)), 0, "paid exactly once");
    }

    function test_R114_03_silenceCompletionFirst_thenRefundRefused() public {
        uint256 jobId = submittedJob();
        _pastCoreExpiry(jobId);
        evaluator.completeAfterSilence(jobId);
        vm.expectRevert(ERC8183.WrongStatus.selector);
        core.claimRefund(jobId);
        _recoverAll(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(address(holding)) + factory.balanceOf(address(holding)), 0);
    }

    function test_R114_03_refundFirst_thenSilenceCompletionRefused() public {
        uint256 jobId = submittedJob();
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        vm.expectRevert(JobsEvaluator.NotSubmitted.selector);
        evaluator.completeAfterSilence(jobId);
        _recoverAll(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(address(holding)) + factory.balanceOf(address(holding)), 0);
    }

    function test_R114_03_noShowAfterExpiryRefundsCreator() public {
        uint256 creatorPay = pay.balanceOf(creator);
        uint256 jobId = fundedJob();
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _recoverAll(jobId);
        assertEq(pay.balanceOf(creator), creatorPay, "a no-show earns nothing");
        assertEq(pay.balanceOf(worker), 0);
        assertEq(pay.balanceOf(address(holding)), 0);
    }

    function test_R114_03_undisputedRejectionAfterExpiryRefundsCreator() public {
        uint256 creatorPay = pay.balanceOf(creator);
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.reject(jobId, JobsEvaluator.Violation.None, REASON);
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _recoverAll(jobId);
        assertEq(pay.balanceOf(creator), creatorPay);
        assertEq(pay.balanceOf(worker), 0);
        assertEq(pay.balanceOf(address(holding)), 0);
    }

    function test_R114_03_arbitrationTimeoutAfterExpiryRefundsCreatorBurnsNothing() public {
        uint256 creatorPay = pay.balanceOf(creator);
        uint256 supply = circulating();
        uint256 jobId = disputedJob();
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _recoverAll(jobId);
        assertEq(pay.balanceOf(creator), creatorPay);
        assertEq(pay.balanceOf(worker), 0);
        assertEq(circulating(), supply, "arbitrator inactivity never burns");
        assertEq(pay.balanceOf(address(holding)) + factory.balanceOf(address(holding)), 0);
    }

    /// @dev A submission after the delivery deadline earns no silence right, even if nobody rejects it.
    function test_R114_03_lateSubmissionEarnsNoSilencePayment() public {
        uint256 creatorPay = pay.balanceOf(creator);
        uint256 jobId = fundedJob();
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        submitDirect(jobId);
        _pastCoreExpiry(jobId);
        core.claimRefund(jobId);
        _recoverAll(jobId);
        assertEq(pay.balanceOf(creator), creatorPay);
        assertEq(pay.balanceOf(worker), 0);
    }

    function test_R114_03_otherEscrowsUntouched() public {
        uint256 expiring = submittedJob();
        vm.warp(block.timestamp + 1 days);
        uint256 live = fundedJob();
        uint256 inCore = pay.balanceOf(address(core));
        _pastCoreExpiry(expiring);
        core.claimRefund(expiring);
        _recoverAll(expiring);
        _recoverAll(live);
        assertEq(pay.balanceOf(worker), REWARD, "only the expired job's reward moved");
        assertEq(pay.balanceOf(address(core)), inCore - REWARD, "the live job's escrow is still in the core");
        assertEq(uint256(status(live)), uint256(ERC8183.JobStatus.Funded));
        assertEq(factory.balanceOf(address(holding)), CREATOR_BOND + WORKER_BOND, "the live job's bonds stay locked");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev The smallest gas each payout call succeeds with (EVM pricing, execution gas without the 21k intrinsic), found
///      by binary search, and a guard that it stays under the limits the coordinator published (decisions D4). Monad
///      prices cold state access higher than the EVM, so clients add a margin on top (ADR-0011, gas table).
contract GasFloorsTest is BaseV1 {
    uint256 constant SETTLE_LIMIT = 1_000_000;
    uint256 constant TOPUP_REFUND_LIMIT = 450_000;
    uint256 constant EVALUATOR_LIMIT = 900_000;

    function _floor(address from, address target, bytes memory data) internal returns (uint256 lo) {
        lo = 21_000;
        uint256 hi = 5_000_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            vm.prank(from);
            (bool ok,) = target.call{gas: mid}(data);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
    }

    function test_gas_settle_worstCase() public {
        // Refund through the core's claimRefund: settle releases both bonds and pushes the reward.
        uint256 jobId = fundedJob();
        topUp(jobId, contributor, 10e6);
        submit(jobId);
        vm.warp(core.getJob(jobId).expiredAt + 1 hours);
        core.claimRefund(jobId);
        uint256 g = _floor(stranger, address(holding), abi.encodeCall(IHirelingHolding.settle, (jobId)));
        console.log("settle (2 bond releases + worker and treasury pushes):", g);
        assertLt(g, SETTLE_LIMIT);
    }

    function test_gas_settle_afterAccept() public {
        uint256 jobId = fundedJob();
        topUp(jobId, contributor, 10e6);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        uint256 g = _floor(stranger, address(holding), abi.encodeCall(IHirelingHolding.settle, (jobId)));
        console.log("settle after accept (bonus + fee pushes):", g);
        assertLt(g, SETTLE_LIMIT);
    }

    function test_gas_claimTopUpRefund() public {
        uint256 jobId = fundedJob();
        topUp(jobId, contributor, 10e6);
        vm.warp(listing(jobId).deliveryDeadline + 1);
        evaluator.rejectAfterDeliveryDeadline(jobId);
        holding.settle(jobId);
        uint256 g =
            _floor(relayer, address(holding), abi.encodeCall(IHirelingHolding.claimTopUpRefund, (jobId, contributor)));
        console.log("claimTopUpRefund:", g);
        assertLt(g, TOPUP_REFUND_LIMIT);
    }

    function test_gas_accept() public {
        uint256 jobId = submittedJob();
        uint256 g = _floor(creator, address(evaluator), abi.encodeCall(IHirelingEvaluator.accept, (jobId)));
        console.log("accept (bonds, complete, feedback):", g);
        assertLt(g, EVALUATOR_LIMIT);
    }

    function test_gas_completeAfterSilence() public {
        uint256 jobId = submittedJob();
        vm.warp(vm.getBlockTimestamp() + REVIEW + 1);
        uint256 g =
            _floor(stranger, address(evaluator), abi.encodeCall(IHirelingEvaluator.completeAfterSilence, (jobId)));
        console.log("completeAfterSilence:", g);
        assertLt(g, EVALUATOR_LIMIT);
    }

    function test_gas_ruleWithSlash() public {
        uint256 jobId = disputedJob();
        uint256 g = _floor(
            arbitrator, address(evaluator), abi.encodeCall(IHirelingEvaluator.rule, (jobId, true, true, REASON))
        );
        console.log("rule for worker with creator slash:", g);
        assertLt(g, EVALUATOR_LIMIT);
    }

    function test_gas_ruleWithSignature() public {
        uint256 jobId = disputedJob();
        IHirelingEvaluator.Ruling memory r =
            IHirelingEvaluator.Ruling(jobId, false, true, REASON, vm.getBlockTimestamp() + 1 hours, 1);
        bytes memory sig = signRuling(arbitratorPk, r);
        uint256 g = _floor(relayer, address(evaluator), abi.encodeCall(IHirelingEvaluator.ruleWithSignature, (r, sig)));
        console.log("ruleWithSignature for creator with worker slash:", g);
        assertLt(g, EVALUATOR_LIMIT);
    }
}

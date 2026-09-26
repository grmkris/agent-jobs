// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// @dev R16-10: the complete flow ends in reputation, and settlement survives missing evidence and a failing
///      registry.
contract EndToEndTest is Base {
    function test_completeFlow_evidenceAcceptPayBondsReputation() public {
        uint256 cFac = factory.balanceOf(creator);
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = publish();
        assign(jobId);
        acceptRelayed(jobId, REWARD, 1, block.timestamp + 1 hours);
        fund(jobId);
        submitRelayed(jobId, 2);

        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        evaluator.attachEvidence(jobId, a, attester, signEvidence(attesterPk, a));
        (bytes32 digest, bytes32 submissionHash, bytes32 policyHash,,,,) = evaluator.evidence(jobId, attester);
        assertEq(digest, evidenceDigest(a));
        assertEq(submissionHash, DELIVERABLE, "matches the finalized deliverable");
        assertEq(policyHash, holding.policyHashOf(jobId), "matches the accepted policy");

        vm.expectEmit(true, true, false, true, address(evaluator));
        emit JobsEvaluator.FeedbackRecorded(jobId, AGENT_ID, true);
        vm.prank(creator);
        evaluator.accept(jobId);

        assertEq(pay.balanceOf(worker), REWARD, "reward paid");
        assertEq(factory.balanceOf(creator), cFac, "creator bond returned");
        assertEq(factory.balanceOf(worker), wFac, "worker bond returned");
        assertEq(reputation.calls(), 1, "reputation recorded");
        assertEq(reputation.lastAgentId(), AGENT_ID);
        assertEq(reputation.lastValue(), 1);
        assertEq(reputation.lastTag2(), "completed");
        assertEq(reputation.lastClient(), address(evaluator), "the evaluator is the client of record");
    }

    function test_settlementWithoutEvidence() public {
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(reputation.calls(), 1);
    }

    function test_registryRevertsPaymentStillCompletes() public {
        reputation.setMode(MockReputation.Mode.Revert);
        uint256 jobId = submittedJob();
        vm.expectEmit(true, true, false, false, address(evaluator));
        emit JobsEvaluator.FeedbackFailed(jobId, AGENT_ID, "");
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD, "payment is never undone by feedback");
        assertEq(factory.balanceOf(address(holding)), 0, "bonds returned");
    }

    function test_registryBurnsGasPaymentStillCompletes() public {
        reputation.setMode(MockReputation.Mode.BurnGas);
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD, "the gas cap bounds a misbehaving registry");
    }

    function test_rejectionRecordsNegativeFeedback() public {
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, false);
        assertEq(reputation.lastValue(), 0);
        assertEq(reputation.lastTag2(), "rejected");
    }
}

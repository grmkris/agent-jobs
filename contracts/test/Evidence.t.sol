// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev R16-06 and R16-07: evidence bookkeeping per verifier, bound to the job's accepted policy.
contract EvidenceTest is Base {
    address internal ci;
    uint256 internal ciPk;

    function setUp() public override {
        super.setUp();
        (ci, ciPk) = makeAddrAndKey("second-verifier");
        vm.prank(deployer);
        evaluator.setVerifier(ci, true);
    }

    function _digestOf(uint256 jobId, address verifier) internal view returns (bytes32 d) {
        (d,,,,,,) = evaluator.evidence(jobId, verifier);
    }

    function test_twoVerifiersSameStatementBothRecorded() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        evaluator.attachEvidence(jobId, a, attester, signEvidence(attesterPk, a));
        evaluator.attachEvidence(jobId, a, ci, signEvidence(ciPk, a));
        assertEq(_digestOf(jobId, attester), evidenceDigest(a));
        assertEq(_digestOf(jobId, ci), evidenceDigest(a));
        assertTrue(evaluator.usedDigest(attester, evidenceDigest(a)));
        assertTrue(evaluator.usedDigest(ci, evidenceDigest(a)));
    }

    function test_reversedArrivalOrderSameResult() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        evaluator.attachEvidence(jobId, a, ci, signEvidence(ciPk, a));
        evaluator.attachEvidence(jobId, a, attester, signEvidence(attesterPk, a));
        assertEq(_digestOf(jobId, attester), _digestOf(jobId, ci));
    }

    function test_sameVerifierRepeatIsIdempotent() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        bytes memory sig = signEvidence(attesterPk, a);
        evaluator.attachEvidence(jobId, a, attester, sig);
        (,,,, uint48 firstAt,,) = evaluator.evidence(jobId, attester);
        vm.warp(block.timestamp + 1 hours);
        vm.recordLogs();
        evaluator.attachEvidence(jobId, a, attester, sig);
        assertEq(vm.getRecordedLogs().length, 0, "no second endorsement event");
        (,,,, uint48 secondAt,,) = evaluator.evidence(jobId, attester);
        assertEq(secondAt, firstAt, "the record was not overwritten");
    }

    function test_differingConclusionsStayInspectable() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory pass = attestation(jobId, 1, block.timestamp + 1 days);
        JobsEvaluator.EvidenceAttestation memory fail = attestation(jobId, 0, block.timestamp + 1 days);
        evaluator.attachEvidence(jobId, pass, attester, signEvidence(attesterPk, pass));
        evaluator.attachEvidence(jobId, fail, ci, signEvidence(ciPk, fail));
        (,,,,,, uint8 c1) = evaluator.evidence(jobId, attester);
        (,,,,,, uint8 c2) = evaluator.evidence(jobId, ci);
        assertEq(c1, 1);
        assertEq(c2, 0);
    }

    function test_rightSignerWrongPolicyRejected() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        a.policyHash = keccak256("policy-v2");
        bytes memory sig = signEvidence(attesterPk, a);
        vm.expectRevert(JobsEvaluator.EvidencePolicyMismatch.selector);
        evaluator.attachEvidence(jobId, a, attester, sig);
    }

    /// @dev The contract binds evidence to the policy; binding to the finalized deliverable is the indexer's
    ///      job (the core keeps the deliverable only in `JobSubmitted`). The stored `submissionHash` is what
    ///      the indexer compares, so evidence for candidate A is visibly not evidence for finalized B.
    function test_candidateEvidenceIsStoredWithItsOwnSubmissionHash() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        a.submissionHash = keccak256("candidate-A");
        evaluator.attachEvidence(jobId, a, attester, signEvidence(attesterPk, a));
        (, bytes32 submissionHash,,,,,) = evaluator.evidence(jobId, attester);
        assertTrue(submissionHash != DELIVERABLE, "does not match the finalized deliverable");
    }

    function test_expiredEvidenceIsRefusedNotCurrent() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 hours);
        evaluator.attachEvidence(jobId, a, attester, signEvidence(attesterPk, a));
        (,,,,, uint48 validUntil,) = evaluator.evidence(jobId, attester);
        vm.warp(uint256(validUntil) + 1);
        JobsEvaluator.EvidenceAttestation memory late = attestation(jobId, 1, block.timestamp - 1);
        bytes memory sig = signEvidence(ciPk, late);
        vm.expectRevert(JobsEvaluator.EvidenceExpired.selector);
        evaluator.attachEvidence(jobId, late, ci, sig);
    }
}

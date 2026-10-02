// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Ports of the legacy Evidence suite to v1: evidence binds to the listing's own policy.
contract V1EvidenceTest is BaseV1 {
    function _attestation(uint256 jobId, uint8 conclusion, uint256 validUntil)
        internal
        view
        returns (IHirelingEvaluator.EvidenceAttestation memory)
    {
        return IHirelingEvaluator.EvidenceAttestation({
            jobId: jobId,
            submissionHash: DELIVERABLE,
            policyHash: listing(jobId).policyHash,
            repo: keccak256("repo"),
            headSha: keccak256("head"),
            testedSha: keccak256("tested"),
            checkRunsHash: keccak256("checks"),
            conclusion: conclusion,
            validUntil: validUntil
        });
    }

    function _sign(uint256 pk, IHirelingEvaluator.EvidenceAttestation memory a) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                evaluator.EVIDENCE_TYPEHASH(),
                a.jobId,
                a.submissionHash,
                a.policyHash,
                a.repo,
                a.headSha,
                a.testedSha,
                a.checkRunsHash,
                a.conclusion,
                a.validUntil
            )
        );
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = evaluator.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_twoVerifiersSameStatementBothRecorded_sameVerifierIdempotent() public {
        (address second, uint256 secondPk) = makeAddrAndKey("second-verifier");
        vm.prank(deployer);
        evaluator.setVerifier(second, true);
        uint256 jobId = submittedJob();
        uint256 held = pay.balanceOf(address(holding));
        IHirelingEvaluator.EvidenceAttestation memory a = _attestation(jobId, 1, block.timestamp + 1 days);
        evaluator.attachEvidence(jobId, a, attester, _sign(attesterPk, a));
        evaluator.attachEvidence(jobId, a, second, _sign(secondPk, a));
        evaluator.attachEvidence(jobId, a, attester, _sign(attesterPk, a));
        (bytes32 d1,,,,,,) = evaluator.evidence(jobId, attester);
        (bytes32 d2,,,,,,) = evaluator.evidence(jobId, second);
        assertTrue(d1 != bytes32(0) && d1 == d2);
        assertEq(pay.balanceOf(address(holding)), held, "evidence moves no money");
    }

    function test_rightSignerWrongPolicyRejected_expiredRefused() public {
        uint256 jobId = submittedJob();
        IHirelingEvaluator.EvidenceAttestation memory a = _attestation(jobId, 1, block.timestamp + 1 days);
        a.policyHash = keccak256("someone else's offer");
        bytes memory sig = _sign(attesterPk, a);
        vm.expectRevert(IHirelingEvaluator.EvidencePolicyMismatch.selector);
        evaluator.attachEvidence(jobId, a, attester, sig);

        a = _attestation(jobId, 1, block.timestamp - 1);
        sig = _sign(attesterPk, a);
        vm.expectRevert(IHirelingEvaluator.EvidenceExpired.selector);
        evaluator.attachEvidence(jobId, a, attester, sig);

        a = _attestation(jobId, 1, block.timestamp + 1 days);
        sig = _sign(workerPk, a);
        vm.expectRevert(IHirelingEvaluator.InvalidSignature.selector);
        evaluator.attachEvidence(jobId, a, attester, sig);
    }

    function test_differingConclusionsStayInspectable() public {
        uint256 jobId = submittedJob();
        IHirelingEvaluator.EvidenceAttestation memory pass = _attestation(jobId, 1, block.timestamp + 1 days);
        IHirelingEvaluator.EvidenceAttestation memory fail = _attestation(jobId, 2, block.timestamp + 1 days);
        evaluator.attachEvidence(jobId, pass, attester, _sign(attesterPk, pass));
        evaluator.attachEvidence(jobId, fail, attester, _sign(attesterPk, fail));
        (,,,,,, uint8 conclusion) = evaluator.evidence(jobId, attester);
        assertEq(conclusion, 2, "the latest statement is current; both are in the event history");
    }
}

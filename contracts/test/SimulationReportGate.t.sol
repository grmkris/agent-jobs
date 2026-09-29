// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {SimulationReportGate} from "../src/SimulationReportGate.sol";
import {EvidenceReceiver} from "../src/EvidenceReceiver.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

contract SimulationReportGateTest is Base {
    address internal forwarder;
    SimulationReportGate internal gate;
    EvidenceReceiver internal targetReceiver;
    uint256 internal jobId;
    bytes internal report;

    function setUp() public override {
        super.setUp();
        vm.chainId(10143);
        forwarder = makeAddr("simulator-forwarder");
        vm.etch(forwarder, hex"00");
        jobId = submittedJob();
        report = abi.encode(attestation(jobId, 1, block.timestamp + 1 days));
        gate = new SimulationReportGate(evaluator, forwarder, keccak256(report));
        targetReceiver = gate.receiver();
        vm.prank(deployer);
        evaluator.setVerifier(address(targetReceiver), true);
    }

    function test_exactReportReachesRealReceiverAndEvaluator() public {
        vm.prank(forwarder);
        gate.onReport("", report);
        (bytes32 digest,,,,,, uint8 conclusion) = evaluator.evidence(jobId, address(targetReceiver));
        assertEq(digest, evidenceDigest(abi.decode(report, (JobsEvaluator.EvidenceAttestation))));
        assertEq(conclusion, 1);
        assertEq(targetReceiver.owner(), address(gate));
    }

    function test_wrongSenderAndDirectReceiverCallsFail() public {
        vm.expectRevert(SimulationReportGate.WrongForwarder.selector);
        gate.onReport("", report);
        vm.prank(forwarder);
        vm.expectRevert();
        targetReceiver.onReport("", report);
    }

    function testFuzz_anyChangedReportFails(bytes memory changed) public {
        vm.assume(keccak256(changed) != keccak256(report));
        vm.prank(forwarder);
        vm.expectRevert(SimulationReportGate.UnapprovedReport.selector);
        gate.onReport("", changed);
    }

    function test_replayDoesNotOverwriteEvidence() public {
        vm.prank(forwarder);
        gate.onReport("", report);
        (,,,, uint48 beforeAt,,) = evaluator.evidence(jobId, address(targetReceiver));
        vm.warp(block.timestamp + 10);
        vm.prank(forwarder);
        gate.onReport("", report);
        (,,,, uint48 afterAt,,) = evaluator.evidence(jobId, address(targetReceiver));
        assertEq(beforeAt, afterAt);
    }

    function test_revocationBlocksEvenTheApprovedReport() public {
        vm.prank(deployer);
        evaluator.setVerifier(address(targetReceiver), false);
        vm.prank(forwarder);
        vm.expectRevert(JobsEvaluator.NotVerifier.selector);
        gate.onReport("", report);
    }

    function test_cannotDeployOnMainnet() public {
        vm.chainId(143);
        vm.expectRevert(SimulationReportGate.WrongChain.selector);
        new SimulationReportGate(evaluator, forwarder, keccak256(report));
    }
}

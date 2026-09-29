// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SimulationReportGate} from "../../src/SimulationReportGate.sol";
import {JobsEvaluator} from "../../src/JobsEvaluator.sol";

/// @dev Real legacy evaluator bytecode, completed job 8, and the board's published attestation.
contract CRESimulationForkTest is Test {
    function test_completedLegacyJobAcceptsTheExactBoardDigest() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 10143);
        string memory cfg = vm.readFile("config/monad-testnet.json");
        JobsEvaluator evaluator = JobsEvaluator(vm.parseJsonAddress(cfg, ".cre.simulation.evaluator"));
        address forwarder = vm.parseJsonAddress(cfg, ".cre.simulation.forwarder");
        address admin = vm.parseJsonAddress(cfg, ".roles.admin");
        address boardAttester = vm.parseJsonAddress(cfg, ".roles.attester");
        (bytes32 expected, bytes32 submission, bytes32 policy, bytes32 sha,, uint48 until, uint8 conclusion) = evaluator.evidence(8, boardAttester);
        // Fork remains repeatable after the historical statement expires.
        vm.warp(uint256(until) - 1);
        JobsEvaluator.EvidenceAttestation memory a = JobsEvaluator.EvidenceAttestation({
            jobId: 8, submissionHash: submission, policyHash: policy,
            repo: keccak256("https://github.com/grmkris/runner-spike-fixture"), headSha: sha, testedSha: sha,
            checkRunsHash: 0x8bdb511d53f8d2f2586cd41063a3807476e3fcd787b2359b609721521a88fba5,
            conclusion: conclusion, validUntil: until
        });
        bytes memory report = abi.encode(a);
        SimulationReportGate gate = new SimulationReportGate(evaluator, forwarder, keccak256(report));
        address receiver = address(gate.receiver());
        vm.prank(admin);
        evaluator.setVerifier(receiver, true);
        vm.prank(forwarder);
        gate.onReport("", report);
        (bytes32 actual,,,,,,) = evaluator.evidence(8, receiver);
        assertEq(actual, expected, "real legacy evaluator and board golden digest agree");
        vm.prank(admin);
        evaluator.setVerifier(receiver, false);
        assertFalse(evaluator.verifiers(receiver));
        assertTrue(evaluator.verifiers(boardAttester));
    }
}

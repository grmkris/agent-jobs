// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base} from "./Base.t.sol";
import {EvidenceReceiver} from "../src/EvidenceReceiver.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {ReceiverTemplate} from "../src/vendor/cre/ReceiverTemplate.sol";
import {IReceiver} from "../src/vendor/cre/IReceiver.sol";

/// @dev The CRE receiver on Chainlink's pinned ReceiverTemplate. The KeystoneForwarder is played by an address and
///      the metadata is packed as the production forwarder packs it (62 bytes + a 2-byte report id); the live
///      delivery by the deployed workflow is S5's end-to-end proof.
contract ReceiverTest is Base {
    address internal forwarder = makeAddr("keystone-forwarder");
    address internal workflowOwner = makeAddr("workflow-owner");
    string internal constant WORKFLOW = "agent-jobs-evidence";
    bytes32 internal constant WORKFLOW_ID = keccak256("workflow-id");
    EvidenceReceiver internal receiver;

    function setUp() public override {
        super.setUp();
        vm.startPrank(deployer);
        receiver = new EvidenceReceiver(evaluator, forwarder);
        receiver.setExpectedAuthor(workflowOwner);
        receiver.setExpectedWorkflowName(WORKFLOW);
        receiver.renounceOwnership();
        evaluator.setVerifier(address(receiver), true);
        vm.stopPrank();
    }

    /// @dev sha256(name) → lowercase hex → first 10 characters, as ReceiverTemplate and the forwarder encode it.
    function _nameBytes10(string memory name) internal pure returns (bytes10 out) {
        bytes32 h = sha256(bytes(name));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory first10 = new bytes(10);
        for (uint256 i; i < 5; ++i) {
            first10[2 * i] = hexChars[uint8(h[i]) >> 4];
            first10[2 * i + 1] = hexChars[uint8(h[i]) & 0x0f];
        }
        out = bytes10(first10);
    }

    function _metadata(address owner, string memory name) internal pure returns (bytes memory) {
        return abi.encodePacked(WORKFLOW_ID, _nameBytes10(name), owner, bytes2(0x0001));
    }

    function test_receiver_deliversEvidenceAsItsOwnStatement() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        bytes memory meta = _metadata(workflowOwner, WORKFLOW);
        vm.prank(forwarder);
        receiver.onReport(meta, abi.encode(a));
        (bytes32 digest,,,,,,) = evaluator.evidence(jobId, address(receiver));
        assertEq(digest, evidenceDigest(a), "the receiver contract is the registered verifier");
        assertEq(pay.balanceOf(address(receiver)), 0);
    }

    function test_receiver_onlyTheForwarder() public {
        uint256 jobId = submittedJob();
        bytes memory report = abi.encode(attestation(jobId, 1, block.timestamp + 1 days));
        bytes memory meta = _metadata(workflowOwner, WORKFLOW);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, stranger, forwarder));
        receiver.onReport(meta, report);
    }

    function test_receiver_onlyOurWorkflow() public {
        uint256 jobId = submittedJob();
        bytes memory report = abi.encode(attestation(jobId, 1, block.timestamp + 1 days));
        bytes memory foreignOwner = _metadata(stranger, WORKFLOW);
        bytes memory foreignName = _metadata(workflowOwner, "other");
        bytes memory nameErr = abi.encodeWithSelector(
            ReceiverTemplate.InvalidWorkflowName.selector, _nameBytes10("other"), _nameBytes10(WORKFLOW)
        );
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidAuthor.selector, stranger, workflowOwner));
        receiver.onReport(foreignOwner, report);
        vm.prank(forwarder);
        vm.expectRevert(nameErr);
        receiver.onReport(foreignName, report);
    }

    /// @dev Ownership is renounced after configuration: nobody can weaken the checks afterwards.
    function test_receiver_checksCannotBeWeakened() public {
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        receiver.setForwarderAddress(address(0));
        assertEq(receiver.getForwarderAddress(), forwarder);
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId));
    }

    function test_receiver_policyStillChecked() public {
        uint256 jobId = submittedJob();
        JobsEvaluator.EvidenceAttestation memory a = attestation(jobId, 1, block.timestamp + 1 days);
        a.policyHash = keccak256("another offer");
        bytes memory meta = _metadata(workflowOwner, WORKFLOW);
        vm.prank(forwarder);
        vm.expectRevert(JobsEvaluator.EvidencePolicyMismatch.selector);
        receiver.onReport(meta, abi.encode(a));
    }
}

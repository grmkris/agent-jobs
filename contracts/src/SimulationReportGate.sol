// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IReceiver} from "./vendor/cre/IReceiver.sol";
import {EvidenceReceiver} from "./EvidenceReceiver.sol";
import {JobsEvaluator} from "./JobsEvaluator.sol";

/// @notice Testnet simulation ONLY. Chainlink's public simulator forwarder does not authenticate a workflow.
///         This immutable gate lets it deliver exactly one pre-approved report, never arbitrary evidence.
///         The actual EvidenceReceiver and JobsEvaluator execute their unchanged production code.
contract SimulationReportGate is IReceiver {
    address public immutable forwarder;
    bytes32 public immutable reportHash;
    EvidenceReceiver public immutable receiver;

    error WrongChain();
    error InvalidConfiguration();
    error WrongForwarder();
    error UnapprovedReport();

    constructor(JobsEvaluator evaluator, address forwarder_, bytes32 reportHash_) {
        if (block.chainid != 10143) revert WrongChain();
        if (address(evaluator).code.length == 0 || forwarder_.code.length == 0 || reportHash_ == bytes32(0)) {
            revert InvalidConfiguration();
        }
        forwarder = forwarder_;
        reportHash = reportHash_;
        receiver = new EvidenceReceiver(evaluator, address(this));
        // Receiver ownership stays here; this gate has no admin methods and cannot change its permissions.
    }

    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != forwarder) revert WrongForwarder();
        if (keccak256(report) != reportHash) revert UnapprovedReport();
        receiver.onReport("", report);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == 0x01ffc9a7;
    }
}

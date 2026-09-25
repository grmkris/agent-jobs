// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {JobsEvaluator} from "./JobsEvaluator.sol";

/// @title EvidenceReceiver
/// @notice The on-chain end of the Chainlink CRE evidence workflow. CRE's forwarder delivers a signed report
///         through `onReport(metadata, payload)`; the payload is an ABI-encoded `EvidenceAttestation`, which is
///         handed to the evaluator with this contract as the registered verifier. Spike S5 swaps this minimal
///         `IReceiver` shape for Chainlink's `ReceiverTemplate` once the Monad forwarder is pinned; the
///         evaluator side does not change.
contract EvidenceReceiver {
    JobsEvaluator public immutable evaluator;
    address public immutable forwarder;

    event ReportReceived(uint256 indexed jobId, bytes32 testedSha, uint8 conclusion);

    error NotForwarder();

    constructor(JobsEvaluator evaluator_, address forwarder_) {
        evaluator = evaluator_;
        forwarder = forwarder_;
    }

    /// @notice Chainlink `IReceiver.onReport`. `metadata` carries the workflow identity and is checked in S5.
    function onReport(bytes calldata, bytes calldata payload) external {
        if (msg.sender != forwarder) revert NotForwarder();
        JobsEvaluator.EvidenceAttestation memory a = abi.decode(payload, (JobsEvaluator.EvidenceAttestation));
        emit ReportReceived(a.jobId, a.testedSha, a.conclusion);
        this.forward(a);
    }

    /// @dev Re-entered from `onReport` so the attestation is `calldata` for the evaluator's signature.
    function forward(JobsEvaluator.EvidenceAttestation calldata a) external {
        if (msg.sender != address(this)) revert NotForwarder();
        evaluator.attachEvidenceDirect(a.jobId, a);
    }
}

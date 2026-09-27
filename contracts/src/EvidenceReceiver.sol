// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReceiverTemplate} from "./vendor/cre/ReceiverTemplate.sol";
import {JobsEvaluator} from "./JobsEvaluator.sol";

/// @title EvidenceReceiver
/// @notice The Chainlink CRE consumer that is the registered evidence verifier on `JobsEvaluator` (spec §4). Built
///         on Chainlink's pinned `ReceiverTemplate`: only the configured KeystoneForwarder may call `onReport`, and
///         the deployment recipe pins our workflow's owner and name before renouncing ownership, so the checks can
///         never be weakened afterwards. Each report is one `EvidenceAttestation` and is attached as this
///         contract's own statement (`attachEvidenceDirect`); it moves no money.
contract EvidenceReceiver is ReceiverTemplate {
    JobsEvaluator public immutable evaluator;

    event ReportReceived(uint256 indexed jobId, bytes32 testedSha, uint8 conclusion);

    constructor(JobsEvaluator evaluator_, address forwarder_) ReceiverTemplate(forwarder_) {
        evaluator = evaluator_;
    }

    function _processReport(bytes calldata report) internal override {
        JobsEvaluator.EvidenceAttestation memory a = abi.decode(report, (JobsEvaluator.EvidenceAttestation));
        emit ReportReceived(a.jobId, a.testedSha, a.conclusion);
        evaluator.attachEvidenceDirect(a.jobId, a);
    }
}

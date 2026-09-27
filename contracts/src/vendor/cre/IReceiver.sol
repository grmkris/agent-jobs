// SPDX-License-Identifier: MIT
// Vendored from smartcontractkit/chainlink-evm at b6cf3a6ff90c7172e1d6090d056c0f77282450ce,
// contracts/src/v0.8/automation-cre/ (MIT). Only change: OpenZeppelin imports use this repo's remapping.
pragma solidity ^0.8.0;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IReceiver - receives keystone reports
/// @notice Implementations must support the IReceiver interface through ERC165.
interface IReceiver is IERC165 {
  /// @notice Handles incoming keystone reports.
  /// @dev If this function call reverts, it can be retried with a higher gas
  /// limit. The receiver is responsible for discarding stale reports.
  /// @param metadata Report's metadata.
  /// @param report Workflow report.
  function onReport(
    bytes calldata metadata,
    bytes calldata report
  ) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title TeamVesting
/// @notice The team's 150M FACTORY (ADR-0011): OpenZeppelin's `VestingWalletCliff` unchanged, every parameter from
///         the deploy config rather than code. The default reading of note 17 is `start = T0 + 1 year`, duration
///         3 years, no cliff (nothing for a year, then linear); the alternative is `start = T0`, duration 4 years,
///         cliff 1 year (a quarter at the cliff). The beneficiary owns the wallet and may hand it on (`Ownable`).
contract TeamVesting is VestingWalletCliff {
    constructor(address beneficiary, uint64 startTimestamp, uint64 durationSeconds, uint64 cliffSeconds)
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {}
}

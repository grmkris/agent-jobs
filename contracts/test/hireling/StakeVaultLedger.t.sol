// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStakeVault} from "../../src/hireling/interfaces/IStakeVault.sol";
import {StakeVaultFixture} from "./StakeVault.t.sol";

/// @dev Rebuilds pools, positions and per-Holding reservations using vault events alone.
contract StakeVaultLedgerTest is StakeVaultFixture {
    bytes32 constant DELEGATED = keccak256("Delegated(address,address,address,uint256,uint256)");
    bytes32 constant REQUESTED = keccak256("UndelegateRequested(address,address,uint256,uint256,uint256,uint48)");
    bytes32 constant CANCELLED = keccak256("UndelegateCancelled(address,address,uint256,uint256)");
    bytes32 constant WITHDRAWN = keccak256("Withdrawn(address,address,uint256,uint256)");
    bytes32 constant RESERVED = keccak256("Reserved(address,address,uint256)");
    bytes32 constant RELEASED = keccak256("Released(address,address,uint256)");
    bytes32 constant SLASHED = keccak256("Slashed(address,address,uint256)");
    bytes32 constant RESET = keccak256("PoolReset(address,uint64)");

    mapping(address => IStakeVault.Pool) ledgerPools;
    mapping(address => mapping(address => IStakeVault.Position)) ledgerPositions;
    mapping(address => mapping(address => uint256)) ledgerReservedBy;

    function _address(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    function _position(address account, address delegator) internal returns (IStakeVault.Position storage position) {
        position = ledgerPositions[account][delegator];
        uint64 generation = ledgerPools[account].generation;
        if (position.generation != generation) {
            delete ledgerPositions[account][delegator];
            position.generation = generation;
        }
    }

    function _value(IStakeVault.Pool storage pool, uint256 shares) internal view returns (uint256) {
        return pool.shares == 0 ? 0 : Math.mulDiv(shares, pool.assets, pool.shares);
    }

    function _replay(Vm.Log memory log) internal {
        if (log.emitter != address(vault)) return;
        bytes32 eventId = log.topics[0];
        if (eventId == DELEGATED) {
            address account = _address(log.topics[1]);
            address delegator = _address(log.topics[2]);
            (uint256 assets, uint256 shares) = abi.decode(log.data, (uint256, uint256));
            IStakeVault.Pool storage pool = ledgerPools[account];
            IStakeVault.Position storage position = _position(account, delegator);
            uint256 minted = pool.shares == 0 ? assets : Math.mulDiv(assets, pool.shares, pool.assets);
            assertEq(shares, minted, "event mint price");
            pool.assets += uint128(assets);
            pool.shares += shares;
            position.shares += shares;
        } else if (eventId == REQUESTED) {
            address account = _address(log.topics[1]);
            address delegator = _address(log.topics[2]);
            (uint256 shares, uint256 assets, uint256 queued, uint48 unlock) =
                abi.decode(log.data, (uint256, uint256, uint256, uint48));
            IStakeVault.Pool storage pool = ledgerPools[account];
            IStakeVault.Position storage position = _position(account, delegator);
            assertEq(assets, _value(pool, shares), "event request price");
            assertEq(queued, uint256(position.queuedShares) + shares, "whole queue");
            pool.queuedShares += uint192(shares);
            position.queuedShares = uint192(queued);
            position.unlockAt = unlock;
        } else if (eventId == CANCELLED || eventId == WITHDRAWN) {
            address account = _address(log.topics[1]);
            address delegator = _address(log.topics[2]);
            (uint256 shares, uint256 assets) = abi.decode(log.data, (uint256, uint256));
            IStakeVault.Pool storage pool = ledgerPools[account];
            IStakeVault.Position storage position = _position(account, delegator);
            assertEq(shares, position.queuedShares, "whole exit");
            assertEq(assets, _value(pool, shares), "event exit price");
            pool.queuedShares -= uint192(shares);
            position.queuedShares = 0;
            position.unlockAt = 0;
            if (eventId == WITHDRAWN) {
                pool.assets -= uint128(assets);
                pool.shares -= shares;
                position.shares -= shares;
            }
        } else if (eventId == RESERVED || eventId == RELEASED || eventId == SLASHED) {
            address h = _address(log.topics[1]);
            address account = _address(log.topics[2]);
            uint256 assets = abi.decode(log.data, (uint256));
            IStakeVault.Pool storage pool = ledgerPools[account];
            if (eventId == RESERVED) {
                pool.reserved += uint128(assets);
                ledgerReservedBy[h][account] += assets;
            } else {
                pool.reserved -= uint128(assets);
                ledgerReservedBy[h][account] -= assets;
                if (eventId == SLASHED) pool.assets -= uint128(assets);
            }
        } else if (eventId == RESET) {
            IStakeVault.Pool storage pool = ledgerPools[_address(log.topics[1])];
            uint64 generation = abi.decode(log.data, (uint64));
            assertEq(pool.assets, 0, "reset follows full slash");
            assertEq(pool.reserved, 0);
            assertEq(generation, pool.generation + 1);
            pool.shares = 0;
            pool.queuedShares = 0;
            pool.generation = generation;
        }
    }

    function _assertLedger(address[2] memory accounts, address[3] memory delegators) internal view {
        uint256 assets;
        uint256 reserved;
        for (uint256 i; i < accounts.length; ++i) {
            address account = accounts[i];
            IStakeVault.Pool memory expected = ledgerPools[account];
            assertEq(abi.encode(expected), abi.encode(vault.poolOf(account)), "event-only pool");
            assets += expected.assets;
            reserved += expected.reserved;
            assertEq(ledgerReservedBy[holding][account], vault.reservedBy(holding, account));
            assertEq(ledgerReservedBy[holding2][account], vault.reservedBy(holding2, account));
            for (uint256 j; j < delegators.length; ++j) {
                IStakeVault.Position memory position = ledgerPositions[account][delegators[j]];
                if (position.generation != expected.generation) {
                    position = IStakeVault.Position(0, 0, 0, expected.generation);
                }
                assertEq(
                    abi.encode(position), abi.encode(vault.positionOf(account, delegators[j])), "event-only position"
                );
            }
        }
        assertEq(assets, vault.totalAssets());
        assertEq(reserved, vault.totalReserved());
    }

    function _delegate(address payer, address account, address delegator, uint256 assets) internal {
        vm.prank(payer);
        vault.delegateFor(account, delegator, assets);
    }

    function _queue(address delegator, address account, uint256 shares) internal {
        vm.prank(delegator);
        vault.requestUndelegate(account, shares);
    }

    function test_eventsReconstructEveryPoolAndPositionAcrossReset() public {
        address carol = makeAddr("carol");
        address[2] memory accounts = [makeAddr("pool-a"), makeAddr("pool-b")];
        address[3] memory delegators = [alice, bob, carol];
        vm.prank(safe);
        vault.proposeHolding(holding2);
        vm.warp(t0 + vault.HOLDING_DELAY());
        vault.acceptHolding();
        vm.recordLogs();
        _delegate(alice, accounts[0], alice, 100);
        _delegate(bob, accounts[0], bob, 200);
        _delegate(bob, accounts[0], carol, 50);
        _delegate(alice, accounts[1], alice, 30);
        _delegate(bob, accounts[1], bob, 70);
        _reserve(holding, accounts[0], 200);
        _reserve(holding2, accounts[0], 50);
        _queue(alice, accounts[0], 80);
        vm.prank(holding);
        vault.slash(accounts[0], 100);
        _delegate(alice, accounts[0], bob, 17);
        vm.prank(alice);
        vault.cancelUndelegate(accounts[0]);
        _queue(bob, accounts[0], 100);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        vm.prank(bob);
        vault.withdraw(accounts[0]);
        vm.prank(holding);
        vault.release(accounts[0], 100);
        vm.prank(holding2);
        vault.slash(accounts[0], 50);
        uint256 remaining = vault.poolOf(accounts[0]).assets;
        _reserve(holding, accounts[0], remaining);
        _queue(carol, accounts[0], 50);
        vm.prank(holding);
        vault.slash(accounts[0], remaining);
        _delegate(bob, accounts[0], alice, 5);
        _reserve(holding, accounts[1], 20);
        _queue(alice, accounts[1], 10);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _queue(alice, accounts[1], 10);
        vm.prank(holding);
        vault.slash(accounts[1], 20);
        vm.prank(alice);
        vault.cancelUndelegate(accounts[1]);
        _queue(bob, accounts[1], 70);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        vm.prank(bob);
        vault.withdraw(accounts[1]);
        _queue(alice, accounts[1], 30);
        vm.warp(vm.getBlockTimestamp() + vault.UNSTAKE_DELAY());
        vm.prank(alice);
        vault.withdraw(accounts[1]);
        _delegate(bob, accounts[1], alice, 3);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            _replay(logs[i]);
            // Every event prefix is itself a usable accounting ledger.
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == RESET) {
                assertEq(ledgerPools[_address(logs[i].topics[1])].shares, 0);
            }
        }
        _assertLedger(accounts, delegators);
        _assertConserved();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";

/// @dev Stands in for JobsEvaluator: a contract that writes feedback about a worker's agent.
contract FeedbackCaller {
    IERC8004Reputation internal immutable reputation;

    constructor(IERC8004Reputation reputation_) {
        reputation = reputation_;
    }

    function record(uint256 agentId, bool completed, bytes32 jobRef) external {
        reputation.giveFeedback(
            agentId, completed ? int128(1) : int128(0), 0, "agent-jobs", completed ? "completed" : "rejected", "", "", jobRef
        );
    }
}

/// @dev Runs only with MONAD_TESTNET_RPC set (`forge test --match-path 'test/fork/*'`); skipped otherwise so
///      the default suite stays hermetic. State changes happen on the fork, never on the real chain.
contract Erc8004ForkTest is Test {
    IERC8004Identity internal constant IDENTITY = IERC8004Identity(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IERC8004Reputation internal constant REPUTATION =
        IERC8004Reputation(0x8004B663056A597Dffe9eCcC1965A193B7388713);

    address internal worker = makeAddr("worker");
    FeedbackCaller internal caller;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        caller = new FeedbackCaller(REPUTATION);
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_registriesAreWired() public onFork {
        assertEq(REPUTATION.getIdentityRegistry(), address(IDENTITY));
        assertEq(block.chainid, 10143);
    }

    function test_workerRegistersAndContractWritesFeedback() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();
        assertGt(agentId, 0);
        assertEq(IDENTITY.ownerOf(agentId), worker);
        assertEq(IDENTITY.getAgentWallet(agentId), worker, "agentWallet defaults to the owner");

        bytes32 jobRef = keccak256("job-1");
        caller.record(agentId, true, jobRef);

        (int128 value,, string memory tag1, string memory tag2, bool revoked) =
            REPUTATION.readFeedback(agentId, address(caller), 1);
        assertEq(value, 1);
        assertEq(tag1, "agent-jobs");
        assertEq(tag2, "completed");
        assertFalse(revoked);
    }

    function test_ownerCannotRateItself() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();
        vm.prank(worker);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        REPUTATION.giveFeedback(agentId, 1, 0, "agent-jobs", "completed", "", "", bytes32(0));
    }

    function test_unregisteredAgentIsRefused() public onFork {
        vm.expectRevert();
        caller.record(type(uint256).max, true, bytes32(0));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ISidequestHolding} from "../../src/sidequest/interfaces/ISidequestHolding.sol";
import {PlainToken, NoReturnToken, ReentrantToken} from "../mocks/OddTokens.sol";
import {BaseV1} from "./BaseV1.t.sol";

/// @dev Ports of the legacy ArbitraryTokens suite to v1 (ADR-0010): any ERC-20, no allowlist.
contract V1ArbitraryTokensTest is BaseV1 {
    function test_anyErc20IsAReward_withoutAnAllowlist() public {
        PlainToken chomp = new PlainToken("CHOMP");
        chomp.mint(creator, 1_000e18);
        vm.prank(creator);
        chomp.approve(address(holding), 1_000e18);
        uint256 jobId = publishWith(params(IERC20(address(chomp)), 1_000e18, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        holding.settle(jobId);
        (uint256 fee, uint256 net) = feeOf(1_000e18, WORKER_STAKE);
        assertEq(chomp.balanceOf(worker), net);
        assertEq(chomp.balanceOf(treasury), fee);
    }

    function test_aTokenWithoutReturnValues_worksEndToEnd() public {
        NoReturnToken nrt = new NoReturnToken();
        nrt.mint(creator, 100e6);
        nrt.mint(contributor, 10e6);
        vm.prank(creator);
        nrt.approve(address(holding), 100e6);
        vm.prank(contributor);
        nrt.approve(address(holding), 10e6);
        uint256 jobId = publishWith(params(IERC20(address(nrt)), 100e6, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        topUp(jobId, contributor, 10e6);
        submit(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        holding.settle(jobId);
        (uint256 fee, uint256 net) = feeOf(100e6, WORKER_STAKE);
        uint256 bonusFee = 10e6 * 3000 / 10_000;
        assertEq(nrt.balanceOf(worker), net + 10e6 - bonusFee, "pushes to a no-return token are not owed");
        assertEq(nrt.balanceOf(treasury), fee + bonusFee);
        assertEq(holding.owed(IERC20(address(nrt)), worker), 0);
    }

    function test_aTransferHookCannotReenterHolding() public {
        ReentrantToken hook = new ReentrantToken();
        hook.mint(creator, 2 * REWARD);
        vm.prank(creator);
        hook.approve(address(holding), 2 * REWARD);
        ISidequestHolding.PublishParams memory second = params(IERC20(address(hook)), REWARD, CREATOR_BOND, 0);
        // On the reward pull, the hook tries to publish again inside publish.
        hook.arm(address(holding), abi.encodeCall(ISidequestHolding.publish, (second)));
        publishWith(params(IERC20(address(hook)), REWARD, CREATOR_BOND, 0));
        assertTrue(hook.attempted());
        assertFalse(hook.reentered());
        assertEq(hook.balanceOf(address(holding)), REWARD);
    }
}

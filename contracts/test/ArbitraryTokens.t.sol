// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {BlocklistToken, FeeOnTransferToken, NoReturnToken, PlainToken, ReentrantToken} from "./mocks/OddTokens.sol";

/// @dev ADR-0010: any ERC-20 is a reward, with no allowlist, and one token's oddities never reach another
///      listing's money or the bonds.
contract ArbitraryTokensTest is Base {
    function _fund(address token) internal {
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", creator, 10 * REWARD));
        require(ok, "mint");
        vm.prank(creator);
        (ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(holding), type(uint256).max));
        require(ok, "approve");
    }

    function _publishIn(address token, uint256 reward) internal returns (uint256 jobId) {
        JobHolding.PublishParams memory p = params(reward, CREATOR_BOND, WORKER_BOND);
        p.token = IERC20(token);
        vm.prank(creator);
        jobId = holding.publish(p);
    }

    function _activateIn(uint256 jobId, address token, uint256 reward) internal {
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        uint256 deadline = block.timestamp + 1 hours;
        ERC8183WithAuthorization.Authorization memory auth = ERC8183WithAuthorization.Authorization(
            worker, uint72(jobId), deadline, signSetBudget(workerPk, worker, jobId, token, reward, uint72(jobId), deadline)
        );
        vm.prank(worker);
        holding.activate(sel, sig, auth);
    }

    function _cancelAndSettle(uint256 jobId) internal {
        vm.prank(creator);
        holding.cancel(jobId);
        holding.settle(jobId);
    }

    function test_anyErc20IsAReward_withoutAnAllowlist() public {
        PlainToken chomp = new PlainToken("CHOMP");
        _fund(address(chomp));
        uint256 jobId = _publishIn(address(chomp), REWARD);
        _activateIn(jobId, address(chomp), REWARD);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(chomp.balanceOf(worker), REWARD, "paid in the creator's own token");
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
    }

    function test_aTokenWithoutReturnValues_worksEndToEnd() public {
        NoReturnToken usdt = new NoReturnToken();
        _fund(address(usdt));
        uint256 jobId = _publishIn(address(usdt), REWARD);
        _activateIn(jobId, address(usdt), REWARD);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(usdt.balanceOf(worker), REWARD);
    }

    function test_feeOnTransfer_refusedAtPublish() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        _fund(address(fee));
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        p.token = IERC20(address(fee));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(JobHolding.RewardTokenShortfall.selector, REWARD, REWARD - REWARD / 100));
        holding.publish(p);
    }

    function test_aRewardTheTokenRefusesIsOwed_andTheBondsStillSettle() public {
        BlocklistToken blk = new BlocklistToken();
        _fund(address(blk));
        uint256 jobId = _publishIn(address(blk), REWARD);
        blk.setBlocked(creator, true);
        uint256 factoryBefore = factory.balanceOf(creator);
        _cancelAndSettle(jobId);
        assertEq(factory.balanceOf(creator), factoryBefore + CREATOR_BOND, "the creator bond returned anyway");
        assertEq(holding.owed(IERC20(address(blk)), creator), REWARD, "the refund is owed, not lost");
        vm.prank(creator);
        vm.expectRevert("blocked");
        holding.withdraw(IERC20(address(blk)));
        blk.setBlocked(creator, false);
        vm.prank(creator);
        holding.withdraw(IERC20(address(blk)));
        assertEq(blk.balanceOf(creator), 10 * REWARD, "all of it back once the token allows it");
        assertEq(holding.owed(IERC20(address(blk)), creator), 0);
        vm.prank(creator);
        vm.expectRevert(JobHolding.NothingOwed.selector);
        holding.withdraw(IERC20(address(blk)));
    }

    function test_aTransferHookCannotReenterHolding() public {
        ReentrantToken hook = new ReentrantToken();
        _fund(address(hook));
        uint256 first = _publishIn(address(hook), REWARD);
        uint256 second = _publishIn(address(hook), REWARD);
        vm.prank(creator);
        holding.cancel(second);
        // Settling the first pays its reward; the token's hook tries to settle the second from inside that payout.
        hook.arm(address(holding), abi.encodeCall(JobHolding.settle, (second)));
        vm.prank(creator);
        holding.cancel(first);
        holding.settle(first);
        assertTrue(hook.attempted(), "the hook ran");
        assertFalse(hook.reentered(), "and was refused");
        assertEq(hook.balanceOf(creator), 9 * REWARD, "only the first reward came back");
        // Outside Holding's frame the same call goes through: the refusal was the guard.
        holding.settle(second);
        assertEq(hook.balanceOf(creator), 10 * REWARD);
    }
}

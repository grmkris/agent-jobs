// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {BlocklistUSD, GasBurnerUSD} from "../../src/testnet/OddTokens.sol";
import {OddTokensRecipe} from "../../script/OddTokensRecipe.sol";
import {BaseV1} from "../hireling/BaseV1.t.sol";

/// @dev C11: the testnet odd tokens, and the v1 paths they are meant to show live (M2 deferral, C9-001).
contract OddTokensTest is BaseV1 {
    OddTokensRecipe.Deployed odd;

    function setUp() public override {
        super.setUp();
        address[] memory wallets = new address[](2);
        (wallets[0], wallets[1]) = (creator, contributor);
        odd = OddTokensRecipe.deploy(address(this), wallets, 1_000e6);
    }

    function test_deploy_mintsEveryWallet_ownerOnly() public {
        assertEq(odd.blocklist.decimals(), 6);
        assertEq(odd.blocklist.balanceOf(creator), 1_000e6);
        assertEq(odd.gasBurner.balanceOf(contributor), 1_000e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        odd.blocklist.setBlocked(creator, true);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        odd.gasBurner.mint(stranger, 1);
    }

    function test_deploy_refusesMainnet() public {
        vm.chainId(143);
        address[] memory none = new address[](0);
        vm.expectRevert(OddTokensRecipe.MainnetRefused.selector);
        this.deployExt(none);
    }

    function deployExt(address[] memory wallets) external {
        OddTokensRecipe.deploy(address(this), wallets, 1);
    }

    function _job(IERC20 token) internal returns (uint256 jobId) {
        vm.prank(creator);
        token.approve(address(holding), REWARD);
        jobId = publishWith(params(token, REWARD, CREATOR_BOND, WORKER_BOND));
        activate(jobId);
        submit(jobId);
    }

    /// @dev bUSD blocks the worker after activation: the accept still lands, the payout is deferred, then owed until
    ///      the block lifts.
    function test_blocklist_showsM2() public {
        uint256 jobId = _job(IERC20(address(odd.blocklist)));
        odd.blocklist.setBlocked(worker, true);
        vm.prank(creator);
        evaluator.accept{gas: 1_200_000}(jobId);
        assertTrue(evaluator.payoutDeferred(jobId));
        if (status(jobId) == ERC8183.JobStatus.Submitted) evaluator.retryDeferred(jobId);
        holding.settle(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(holding.owed(IERC20(address(odd.blocklist)), worker), net);
        odd.blocklist.setBlocked(worker, false);
        vm.prank(worker);
        holding.withdraw(IERC20(address(odd.blocklist)));
        assertEq(odd.blocklist.balanceOf(worker), net);
    }

    /// @dev gUSD burns every gas unit on transfers to the worker: a ruling at the documented limit still lands
    ///      (C9-001); the payout is deferred and owed.
    function test_gasBurner_showsC9001() public {
        uint256 jobId = _job(IERC20(address(odd.gasBurner)));
        rejectAs(jobId, IHirelingEvaluator.Violation.Quality);
        vm.prank(worker);
        evaluator.dispute(jobId);
        odd.gasBurner.setHungry(worker, type(uint256).max);
        vm.prank(arbitrator);
        evaluator.rule{gas: 1_200_000}(jobId, true, false, REASON);
        assertEq(uint8(evaluator.outcome(jobId)), uint8(IHirelingEvaluator.Outcome.RuledForWorker));
        assertTrue(evaluator.payoutDeferred(jobId));
        if (status(jobId) == ERC8183.JobStatus.Submitted) evaluator.retryDeferred(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        (, uint256 net) = feeOf(REWARD, WORKER_STAKE);
        assertEq(holding.owed(IERC20(address(odd.gasBurner)), worker), net);
    }
}

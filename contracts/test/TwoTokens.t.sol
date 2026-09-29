// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {MockPaymentToken} from "../src/MockPaymentToken.sol";

/// @dev S7 tokens row: `mUSD` and `mEUR` side by side; a hire in each token settles in that token only.
contract TwoTokensTest is Base {
    MockPaymentToken internal eur;

    function setUp() public override {
        super.setUp();
        eur = new MockPaymentToken("Mock EUR (testnet)", "mEUR");
        eur.mint(creator, 10 * REWARD);
        vm.prank(creator);
        eur.approve(address(holding), type(uint256).max);
    }

    function _hireIn(IERC20 token, uint256 reward) internal returns (uint256 jobId) {
        JobHolding.PublishParams memory p = params(reward, CREATOR_BOND, WORKER_BOND);
        p.token = token;
        vm.prank(creator);
        jobId = holding.publish(p);
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        uint256 deadline = block.timestamp + 1 hours;
        ERC8183WithAuthorization.Authorization memory auth = ERC8183WithAuthorization.Authorization(
            worker,
            uint72(jobId),
            deadline,
            signSetBudget(workerPk, worker, jobId, address(token), reward, uint72(jobId), deadline)
        );
        vm.prank(worker);
        holding.activate(sel, sig, auth);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
    }

    function test_hireInEachTokenSettlesInThatTokenOnly() public {
        _hireIn(IERC20(address(eur)), 70e6);
        assertEq(eur.balanceOf(worker), 70e6, "paid in mEUR");
        assertEq(pay.balanceOf(worker), 0, "nothing in mUSD");
        _hireIn(IERC20(address(pay)), 30e6);
        assertEq(pay.balanceOf(worker), 30e6);
        assertEq(eur.balanceOf(worker), 70e6);
        assertEq(eur.balanceOf(address(core)) + pay.balanceOf(address(core)), 0);
    }

    /// @dev A budget authorisation for the other token does not verify: Holding fixes the listed token.
    function test_budgetInTheOtherTokenRefused() public {
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        p.token = IERC20(address(eur));
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory auth = budgetAuth(workerPk, worker, jobId, REWARD, 1);
        vm.prank(worker);
        vm.expectRevert(ERC8183WithAuthorization.InvalidAuthorizationSignature.selector);
        holding.activate(sel, sig, auth);
    }
}

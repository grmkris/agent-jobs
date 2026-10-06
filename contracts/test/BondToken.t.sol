// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {IERC8004Reputation} from "../src/vendor/erc8004/IERC8004.sol";

/// @dev A token from an external launcher: a plain ERC-20 with no `burn`.
contract PlainToken is ERC20 {
    constructor() ERC20("Launched", "LAUNCH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A token that keeps 1% of every transfer.
contract FeeToken is ERC20 {
    constructor() ERC20("Taxed", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value / 100;
        super._update(from, address(0xFEE), fee);
        super._update(from, to, value - fee);
    }
}

/// @dev The bond token may be any plain ERC-20 (a SIDE launched elsewhere): slashing needs no `burn`, and a
///      fee-on-transfer token is refused at the first bond so settlements are never short.
contract BondTokenTest is Base {
    function _redeploy(IERC20 bond) internal {
        vm.startPrank(deployer);
        holding = new JobHolding(core, bond, holding.identity(), MIN_HOLD, MIN_HOLD);
        evaluator = new JobsEvaluator(
            core, holding, IERC8004Reputation(address(reputation)), arbitrator, REVIEW, DISPUTE, ARBITRATION, MARGIN
        );
        holding.setEvaluator(address(evaluator));
        vm.stopPrank();
        vm.startPrank(creator);
        pay.approve(address(holding), type(uint256).max);
        bond.approve(address(holding), type(uint256).max);
        vm.stopPrank();
        vm.prank(worker);
        bond.approve(address(holding), type(uint256).max);
    }

    function test_plainErc20_slashSendsTheBondToTheBurnAddress() public {
        PlainToken bond = new PlainToken();
        bond.mint(creator, 10 * CREATOR_BOND + MIN_HOLD);
        bond.mint(worker, 10 * WORKER_BOND + MIN_HOLD);
        _redeploy(bond);
        uint256 wBefore = bond.balanceOf(worker);
        uint256 cBefore = bond.balanceOf(creator);
        uint256 jobId = disputedJob();
        vm.prank(arbitrator);
        evaluator.rule(jobId, false, true, REASON);
        holding.settle(jobId);
        assertEq(bond.balanceOf(worker), wBefore - WORKER_BOND, "worker bond slashed");
        assertEq(bond.balanceOf(holding.BURN_ADDRESS()), WORKER_BOND, "at the burn address");
        assertEq(bond.balanceOf(creator), cBefore, "creator bond back");
        assertEq(bond.balanceOf(address(holding)), 0, "nothing left in Holding");
        assertTrue(listing(jobId).workerBondBurned);
    }

    function test_plainErc20_acceptReturnsBothBonds() public {
        PlainToken bond = new PlainToken();
        bond.mint(creator, 10 * CREATOR_BOND + MIN_HOLD);
        bond.mint(worker, 10 * WORKER_BOND + MIN_HOLD);
        _redeploy(bond);
        uint256 wBefore = bond.balanceOf(worker);
        uint256 cBefore = bond.balanceOf(creator);
        uint256 jobId = submittedJob();
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(bond.balanceOf(worker), wBefore);
        assertEq(bond.balanceOf(creator), cBefore);
        assertEq(pay.balanceOf(worker), REWARD);
    }

    function test_feeOnTransfer_refusedAtPublish() public {
        FeeToken bond = new FeeToken();
        bond.mint(creator, 10 * CREATOR_BOND + MIN_HOLD);
        _redeploy(bond);
        JobHolding.PublishParams memory p = params(REWARD, CREATOR_BOND, WORKER_BOND);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(JobHolding.BondTokenFeeOnTransfer.selector, CREATOR_BOND, CREATOR_BOND - CREATOR_BOND / 100)
        );
        holding.publish(p);
    }
}

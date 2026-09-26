// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";

/// @dev S7 contests (R20): contests buy finished work. The approver's `award` pays the chosen entry in one
///      transaction with the winner offline; a failed award leaves the contest open; no worker bond. Replaces the
///      S1b select-then-accept contest tests.
contract ContestTest is Base {
    uint256 internal constant OTHER_AGENT = 43;
    bytes32 internal constant ENTRY = keccak256("entry-a");
    bytes32 internal constant OTHER_ENTRY = keccak256("entry-b");
    address internal rival;
    uint256 internal rivalPk;

    function setUp() public override {
        super.setUp();
        (rival, rivalPk) = makeAddrAndKey("rival-entrant");
        identity.setAgentWallet(OTHER_AGENT, rival);
    }

    function _entry(uint256 jobId) internal view returns (JobHolding.Candidate memory) {
        return candidate(jobId, worker, workerPk, AGENT_ID, ENTRY, 100);
    }

    function _rivalEntry(uint256 jobId) internal view returns (JobHolding.Candidate memory) {
        return candidate(jobId, rival, rivalPk, OTHER_AGENT, OTHER_ENTRY, 200);
    }

    function _award(uint256 jobId, JobHolding.Candidate memory c) internal {
        vm.prank(creator);
        holding.award(jobId, c);
    }

    function _expectAwardRevert(uint256 jobId, JobHolding.Candidate memory c, bytes4 err) internal {
        vm.prank(creator);
        vm.expectRevert(err);
        holding.award(jobId, c);
    }

    function _assertOpen(uint256 jobId) internal view {
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Open), "the contest stays open");
        assertEq(core.getJob(jobId).provider, address(0));
        assertEq(pay.balanceOf(address(holding)), REWARD, "the prize is still escrowed in Holding");
        assertFalse(listing(jobId).funded);
    }

    // ---- the award ----

    /// @dev One transaction pays the winner and closes the contest; the winner sends nothing after entering.
    function test_award_paysOnceWithTheWinnerOffline() public {
        uint256 cFac = factory.balanceOf(creator);
        uint256 jobId = publishContest();
        assertEq(pay.balanceOf(address(holding)), REWARD, "prize locked at publish");
        JobHolding.Candidate memory c = _entry(jobId);

        vm.recordLogs();
        _award(jobId, c);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Completed));
        assertEq(pay.balanceOf(worker), REWARD, "paid in the award transaction");
        assertEq(factory.balanceOf(creator), cFac, "creator bond back: an award is a successful settlement");
        assertEq(pay.balanceOf(address(holding)) + pay.balanceOf(address(core)), 0);
        assertEq(factory.balanceOf(address(holding)), 0);
        assertEq(reputation.calls(), 1, "feedback recorded");
        assertEq(reputation.lastTag2(), "completed");

        vm.prank(stranger);
        vm.expectRevert(JobHolding.NothingToSettle.selector);
        holding.settle(jobId);
    }

    function test_award_atExactSelectionDeadlineAllowed() public {
        uint256 jobId = publishContest();
        vm.warp(listing(jobId).selectionDeadline);
        _award(jobId, _entry(jobId));
        assertEq(pay.balanceOf(worker), REWARD);
    }

    function test_award_afterSelectionDeadlineRefused() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        vm.warp(uint256(listing(jobId).selectionDeadline) + 1);
        _expectAwardRevert(jobId, c, JobHolding.SelectionWindowClosed.selector);
    }

    function test_award_onlyTheApprover() public {
        address approver = makeAddr("approver");
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND);
        p.approver = approver;
        vm.prank(creator);
        uint256 jobId = holding.publish(p);
        JobHolding.Candidate memory c = _entry(jobId);
        _expectAwardRevert(jobId, c, JobHolding.NotApprover.selector);
        vm.prank(worker);
        vm.expectRevert(JobHolding.NotApprover.selector);
        holding.award(jobId, c);
        vm.prank(approver);
        holding.award(jobId, c);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(approver), 0, "the approver judges; it is never paid");
    }

    function test_award_twoCompetingAwardsSettleOnce() public {
        uint256 jobId = publishContest();
        _award(jobId, _entry(jobId));
        _expectAwardRevert(jobId, _rivalEntry(jobId), JobHolding.AlreadyAwarded.selector);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(rival), 0, "only the selected entry is paid");
    }

    function test_award_refusedOnAHire() public {
        uint256 jobId = publish();
        JobHolding.Candidate memory c = candidate(jobId, worker, workerPk, AGENT_ID, ENTRY, 100);
        _expectAwardRevert(jobId, c, JobHolding.WrongMode.selector);
    }

    // ---- a failed award leaves the contest open ----

    function test_award_revokedAuthorisationRevertsAndContestStaysOpen() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        vm.prank(worker);
        core.cancelAuthorization(c.submitAuth.nonce);
        _expectAwardRevert(jobId, c, ERC8183WithAuthorization.AuthorizationNonceUsed.selector);
        _assertOpen(jobId);
        _award(jobId, _rivalEntry(jobId));
        assertEq(pay.balanceOf(rival), REWARD, "another candidate can still be awarded");
    }

    function test_award_expiredAuthorisationRevertsAndContestStaysOpen() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        uint256 deadline = block.timestamp + 1 hours;
        c.budgetAuth = ERC8183WithAuthorization.Authorization(
            worker, 100, deadline, signSetBudget(workerPk, worker, jobId, address(pay), REWARD, 100, deadline)
        );
        vm.warp(deadline + 1);
        _expectAwardRevert(jobId, c, ERC8183WithAuthorization.AuthorizationExpired.selector);
        _assertOpen(jobId);
    }

    /// @dev An authorisation signed by someone other than the named entrant does not settle the entrant's entry.
    function test_award_foreignAuthorisationReverts() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        // The rival signs a valid submission of the worker's exact deliverable; the core's provider check refuses it.
        uint256 deadline = listing(jobId).selectionDeadline;
        c.submitAuth = ERC8183WithAuthorization.Authorization(
            rival, 201, deadline, signSubmit(rivalPk, rival, jobId, ENTRY, 201, deadline)
        );
        _expectAwardRevert(jobId, c, ERC8183.Unauthorized.selector);
        _assertOpen(jobId);
    }

    /// @dev The award binds the exact deliverable the entrant signed.
    function test_award_otherDeliverableReverts() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        c.deliverable = OTHER_ENTRY;
        _expectAwardRevert(jobId, c, ERC8183WithAuthorization.InvalidAuthorizationSignature.selector);
        _assertOpen(jobId);
    }

    function test_award_changedRegistryWalletReverts() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        identity.setAgentWallet(AGENT_ID, stranger);
        _expectAwardRevert(jobId, c, JobHolding.NotAgentWallet.selector);
        _assertOpen(jobId);
        c.agentId = 0;
        _expectAwardRevert(jobId, c, JobHolding.AgentIdRequired.selector);
    }

    // ---- expiry ----

    function test_contest_noAwardByDeadlineRefundsThePrize() public {
        uint256 payBefore = pay.balanceOf(creator);
        uint256 facBefore = factory.balanceOf(creator);
        uint256 jobId = publishContest();
        vm.expectRevert(JobHolding.SelectionWindowOpen.selector);
        holding.expireContest(jobId);
        vm.warp(uint256(listing(jobId).selectionDeadline) + 1);
        vm.prank(stranger);
        holding.expireContest(jobId);
        assertEq(uint256(status(jobId)), uint256(ERC8183.JobStatus.Rejected));
        holding.settle(jobId);
        assertEq(pay.balanceOf(creator), payBefore, "prize back");
        assertEq(factory.balanceOf(creator), facBefore, "creator bond back");
        vm.expectRevert(JobHolding.NothingToSettle.selector);
        holding.settle(jobId);
    }

    /// @dev Award first: expiry can neither close nor refund an awarded prize.
    function test_contest_awardThenExpiryRefused() public {
        uint256 jobId = publishContest();
        _award(jobId, _entry(jobId));
        vm.warp(uint256(listing(jobId).selectionDeadline) + 1);
        vm.expectRevert(JobHolding.AlreadyAwarded.selector);
        holding.expireContest(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
    }

    /// @dev Expiry first: no award afterwards.
    function test_contest_expiryThenAwardRefused() public {
        uint256 jobId = publishContest();
        JobHolding.Candidate memory c = _entry(jobId);
        vm.warp(uint256(listing(jobId).selectionDeadline) + 1);
        holding.expireContest(jobId);
        _expectAwardRevert(jobId, c, JobHolding.SelectionWindowClosed.selector);
        vm.expectRevert(ERC8183.WrongStatus.selector);
        holding.expireContest(jobId);
    }

    function test_contest_liveContestCannotBeCancelled() public {
        uint256 jobId = publishContest();
        vm.prank(creator);
        vm.expectRevert(JobHolding.WrongMode.selector);
        holding.cancel(jobId);
        vm.expectRevert(JobHolding.NotTerminal.selector);
        holding.settle(jobId);
        assertEq(pay.balanceOf(address(holding)), REWARD, "the prize stays available to entrants");
    }

    function test_contest_unselectedEntrantHasNoPath() public {
        uint256 jobId = publishContest();
        _award(jobId, _entry(jobId));
        vm.prank(rival);
        vm.expectRevert(JobsEvaluator.NotProvider.selector);
        evaluator.dispute(jobId);
        assertEq(pay.balanceOf(rival) + factory.balanceOf(rival), 0, "no entitlement, no penalty");
    }

    function test_contest_completionOnlyFromHoldingsAward() public {
        uint256 jobId = publishContest();
        vm.prank(creator);
        vm.expectRevert(JobsEvaluator.NotHolding.selector);
        evaluator.completeAward(jobId);
    }

    function test_contest_selectionDeadlineMustPrecedeDelivery() public {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND);
        p.selectionDeadline = p.deliveryDeadline;
        vm.prank(creator);
        vm.expectRevert(JobHolding.SelectionDeadlineInvalid.selector);
        holding.publish(p);
        JobHolding.PublishParams memory h = params(REWARD, CREATOR_BOND, WORKER_BOND);
        h.selectionDeadline = uint48(block.timestamp + 1 days);
        vm.prank(creator);
        vm.expectRevert(JobHolding.SelectionDeadlineInvalid.selector);
        holding.publish(h);
    }
}

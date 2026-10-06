// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";

/// @dev S7 hire handshake (R20, R114-01): the creator signs a `Selection`; the worker's own `activate` is the final
///      confirmation. Nothing binds the worker before it acts, and nobody else can start its bonded obligation.
contract ActivationTest is Base {
    uint256 internal constant OTHER_AGENT = 43;
    address internal next;
    uint256 internal nextPk;

    function setUp() public override {
        super.setUp();
        (next, nextPk) = makeAddrAndKey("next-applicant");
        identity.setAgentWallet(OTHER_AGENT, next);
        factory.mint(next, 10 * WORKER_BOND + MIN_HOLD);
        vm.prank(next);
        factory.approve(address(holding), type(uint256).max);
    }

    struct Prepared {
        JobHolding.Selection sel;
        bytes sig;
        ERC8183WithAuthorization.Authorization auth;
    }

    function _prepare(JobHolding.Selection memory sel, uint256 workerKey) internal view returns (Prepared memory p) {
        p.sel = sel;
        p.sig = signSelection(creatorPk, sel);
        p.auth = budgetAuth(workerKey, sel.worker, sel.jobId, REWARD, uint72(sel.nonce));
    }

    function _activate(Prepared memory p, address sender) internal {
        vm.prank(sender);
        holding.activate(p.sel, p.sig, p.auth);
    }

    function _expectActivateRevert(Prepared memory p, address sender, bytes4 err) internal {
        vm.prank(sender);
        vm.expectRevert(err);
        holding.activate(p.sel, p.sig, p.auth);
    }

    // ---- who may activate ----

    function test_activation_workerActivatesInOneTransaction() public {
        uint256 wFac = factory.balanceOf(worker);
        uint256 jobId = publish();
        activate(jobId);
        ERC8183.Job memory job = core.getJob(jobId);
        assertEq(uint256(job.status), uint256(ERC8183.JobStatus.Funded), "provider, budget and funding at once");
        assertEq(job.provider, worker);
        assertEq(job.providerAgentId, AGENT_ID);
        assertEq(job.budget, REWARD);
        assertEq(pay.balanceOf(address(core)), REWARD);
        assertEq(factory.balanceOf(worker), wFac - WORKER_BOND, "bond pulled at activation");
        assertTrue(holding.selectionNonceUsed(creator, jobId));
    }

    /// @dev R114-01: a relayed call would check the relayer; the worker sends its own activation.
    function test_activation_relayerOrThirdPartyCannotActivate() public {
        uint256 jobId = publish();
        Prepared memory p = _prepare(selectionFor(jobId, worker, AGENT_ID), workerPk);
        _expectActivateRevert(p, relayer, JobHolding.NotSelectedWorker.selector);
        _expectActivateRevert(p, stranger, JobHolding.NotSelectedWorker.selector);
        _activate(p, worker);
    }

    /// @dev A creator's selection plus the worker's standing SIDE allowance and a leaked budget authorization is
    ///      still not activation: only the worker's own transaction binds it.
    function test_activation_creatorCannotActivateOnTheWorkersBehalf() public {
        uint256 jobId = publish();
        Prepared memory p = _prepare(selectionFor(jobId, worker, AGENT_ID), workerPk);
        _expectActivateRevert(p, creator, JobHolding.NotSelectedWorker.selector);
        assertEq(core.getJob(jobId).provider, address(0), "nothing fixed on-chain");
    }

    function test_activation_anotherApplicantCannotUseSomeoneElsesSelection() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        Prepared memory p = _prepare(sel, workerPk);
        _expectActivateRevert(p, next, JobHolding.NotSelectedWorker.selector);
        // Rewriting the selection to name itself breaks the creator's signature.
        p.sel.worker = next;
        p.sel.agentId = OTHER_AGENT;
        p.auth = budgetAuth(nextPk, next, jobId, REWARD, 9);
        _expectActivateRevert(p, next, JobHolding.InvalidSignature.selector);
    }

    function test_activation_selectionMustBeSignedByTheCreator() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        Prepared memory p = _prepare(sel, workerPk);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(impostorPk, holding.selectionDigest(sel));
        p.sig = abi.encodePacked(r, s, v);
        _expectActivateRevert(p, worker, JobHolding.InvalidSignature.selector);
    }

    // ---- selection validity ----

    function test_activation_atActivateByAllowed_afterRefused() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        sel.activateBy = uint48(block.timestamp + 1 days);
        Prepared memory p = _prepare(sel, workerPk);
        vm.warp(uint256(sel.activateBy) + 1);
        p.auth = budgetAuth(workerPk, worker, jobId, REWARD, uint72(sel.nonce));
        _expectActivateRevert(p, worker, JobHolding.SelectionExpired.selector);
        vm.warp(sel.activateBy);
        p.auth = budgetAuth(workerPk, worker, jobId, REWARD, uint72(sel.nonce));
        _activate(p, worker);
    }

    function test_activation_activateByMustPrecedeDeliveryDeadline() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        sel.activateBy = holding.deliveryDeadlineOf(jobId);
        _expectActivateRevert(_prepare(sel, workerPk), worker, JobHolding.SelectionInvalid.selector);
    }

    /// @dev Past the delivery deadline no selection can still be live, so activation is refused.
    function test_activation_afterDeliveryDeadlineRefused() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        vm.warp(uint256(holding.deliveryDeadlineOf(jobId)) + 1);
        _expectActivateRevert(_prepare(sel, workerPk), worker, JobHolding.SelectionExpired.selector);
    }

    function test_activation_cancelledSelectionRefused() public {
        uint256 jobId = publish();
        Prepared memory p = _prepare(selectionFor(jobId, worker, AGENT_ID), workerPk);
        vm.prank(creator);
        holding.cancelSelection(p.sel.nonce);
        _expectActivateRevert(p, worker, JobHolding.SelectionNonceUsed.selector);
        vm.prank(creator);
        vm.expectRevert(JobHolding.SelectionNonceUsed.selector);
        holding.cancelSelection(p.sel.nonce);
    }

    /// @dev A used selection nonce cannot activate another listing of the same creator.
    function test_activation_replayedSelectionNonceRefused() public {
        uint256 first = publish();
        uint256 second = publish();
        activate(first);
        JobHolding.Selection memory sel = selectionFor(second, worker, AGENT_ID);
        sel.nonce = first;
        _expectActivateRevert(_prepare(sel, workerPk), worker, JobHolding.SelectionNonceUsed.selector);
    }

    function test_activation_termsHashMismatchRefused() public {
        uint256 jobId = publish();
        JobHolding.Selection memory sel = selectionFor(jobId, worker, AGENT_ID);
        sel.termsHash = keccak256("other terms");
        _expectActivateRevert(_prepare(sel, workerPk), worker, JobHolding.TermsMismatch.selector);
    }

    // ---- identity ----

    function test_activation_unrelatedAgentIdRefused() public {
        uint256 jobId = publish();
        // The worker names an agent whose registered wallet is someone else's.
        _expectActivateRevert(
            _prepare(selectionFor(jobId, worker, OTHER_AGENT), workerPk), worker, JobHolding.NotAgentWallet.selector
        );
        _expectActivateRevert(
            _prepare(selectionFor(jobId, worker, 0), workerPk), worker, JobHolding.AgentIdRequired.selector
        );
    }

    /// @dev The payout goes to the provider fixed at activation, not to whatever the registry says later.
    function test_activation_registryWalletChangeAfterwardsLeavesPayoutUnchanged() public {
        uint256 jobId = fundedJob();
        identity.setAgentWallet(AGENT_ID, stranger);
        submitDirect(jobId);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        assertEq(pay.balanceOf(stranger), 0);
    }

    function test_activation_holdGate() public {
        uint256 jobId = publish();
        uint256 held = factory.balanceOf(worker);
        vm.prank(worker);
        factory.transfer(stranger, held);
        Prepared memory p = _prepare(selectionFor(jobId, worker, AGENT_ID), workerPk);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(JobHolding.InsufficientFactoryHeld.selector, 0, MIN_HOLD));
        holding.activate(p.sel, p.sig, p.auth);
    }

    // ---- one listing, one agreement ----

    function test_activation_lapsedSelectionLetsTheNextApplicantActivate() public {
        uint256 jobId = publish();
        JobHolding.Selection memory first = selectionFor(jobId, worker, AGENT_ID);
        first.activateBy = uint48(block.timestamp + 1 hours);
        Prepared memory lapsed = _prepare(first, workerPk);
        vm.warp(block.timestamp + 2 hours);
        lapsed.auth = budgetAuth(workerPk, worker, jobId, REWARD, uint72(first.nonce));
        _expectActivateRevert(lapsed, worker, JobHolding.SelectionExpired.selector);
        assertEq(factory.balanceOf(address(holding)), CREATOR_BOND, "a lapsed selection costs nobody anything");

        JobHolding.Selection memory second = selectionFor(jobId, next, OTHER_AGENT);
        second.nonce = jobId + 1;
        _activate(_prepare(second, nextPk), next);
        assertEq(core.getJob(jobId).provider, next, "same jobId, next applicant");
    }

    function test_activation_atMostOncePerListing() public {
        uint256 jobId = publish();
        activate(jobId);
        JobHolding.Selection memory second = selectionFor(jobId, next, OTHER_AGENT);
        second.nonce = jobId + 1;
        _expectActivateRevert(_prepare(second, nextPk), next, JobHolding.AlreadyActivated.selector);
    }

    /// @dev All or nothing: a failing bond transfer leaves no provider, no budget and the nonce unused.
    function test_activation_isAtomic() public {
        uint256 jobId = publish();
        vm.prank(worker);
        factory.approve(address(holding), 0);
        Prepared memory p = _prepare(selectionFor(jobId, worker, AGENT_ID), workerPk);
        vm.prank(worker);
        vm.expectRevert();
        holding.activate(p.sel, p.sig, p.auth);
        assertEq(core.getJob(jobId).provider, address(0));
        assertFalse(holding.selectionNonceUsed(creator, p.sel.nonce));
        vm.prank(worker);
        factory.approve(address(holding), type(uint256).max);
        _activate(p, worker);
    }

    function test_activation_cancelOnlyBeforeActivation() public {
        uint256 jobId = fundedJob();
        vm.prank(creator);
        vm.expectRevert(JobHolding.AlreadyActivated.selector);
        holding.cancel(jobId);
    }
}

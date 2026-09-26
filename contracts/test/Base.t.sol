// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {FactoryToken} from "../src/FactoryToken.sol";
import {MockPaymentToken} from "../src/MockPaymentToken.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {IERC8004Identity, IERC8004Reputation} from "../src/vendor/erc8004/IERC8004.sol";
import {MockIdentity} from "./mocks/MockIdentity.sol";
import {MockReputation} from "./mocks/MockReputation.sol";

/// @dev Deploys the whole system the way the demo will: our own core proxy (fees 0, the payment token
///      allowlisted, no hooks), Holding with a small hold gate, the evaluator with the arbitrator pinned and
///      our attester registered as a verifier. Helpers walk a job through the lifecycle directly and through
///      the authorization relay.
abstract contract Base is Test {
    uint48 internal constant REVIEW = 3 days;
    uint48 internal constant DISPUTE = 3 days;
    uint48 internal constant ARBITRATION = 7 days;
    uint48 internal constant MARGIN = 1 days;
    uint256 internal constant REWARD = 100e6;
    uint256 internal constant CREATOR_BOND = 20e18;
    uint256 internal constant WORKER_BOND = 10e18;
    uint256 internal constant MIN_HOLD = 1e18;
    uint256 internal constant AGENT_ID = 42;
    bytes32 internal constant MANIFEST = keccak256("manifest-v1");
    /// @dev Seed of the board's `termsHash`; each publish gets its own, since Holding refuses a reused one.
    bytes32 internal constant POLICY = keccak256("policy-v1");
    uint256 internal policyNonce;
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");

    address internal deployer = makeAddr("deployer");
    address internal arbitrator = makeAddr("arbitrator");
    address internal creator;
    uint256 internal creatorPk;
    address internal stranger = makeAddr("stranger");
    address internal relayer = makeAddr("relayer");
    address internal worker;
    uint256 internal workerPk;
    address internal impostor;
    uint256 internal impostorPk;
    address internal attester;
    uint256 internal attesterPk;

    FactoryToken internal factory;
    MockPaymentToken internal pay;
    ERC8183WithAuthorization internal core;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;
    MockReputation internal reputation;
    MockIdentity internal identity;

    function setUp() public virtual {
        (creator, creatorPk) = makeAddrAndKey("creator");
        (worker, workerPk) = makeAddrAndKey("worker");
        (impostor, impostorPk) = makeAddrAndKey("impostor");
        (attester, attesterPk) = makeAddrAndKey("attester");

        vm.startPrank(deployer);
        factory = new FactoryToken();
        pay = new MockPaymentToken();
        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        bytes memory init = abi.encodeCall(ERC8183WithAuthorization.initialize, (deployer, deployer));
        core = ERC8183WithAuthorization(address(new ERC1967Proxy(address(impl), init)));
        core.setPaymentTokenAllowed(address(pay), true);
        core.setPlatformFee(0, deployer);
        core.setEvaluatorFee(0);
        identity = new MockIdentity();
        holding = new JobHolding(core, factory, IERC8004Identity(address(identity)), MIN_HOLD, MIN_HOLD);
        reputation = new MockReputation();
        evaluator = new JobsEvaluator(
            core, holding, IERC8004Reputation(address(reputation)), arbitrator, REVIEW, DISPUTE, ARBITRATION, MARGIN
        );
        holding.setEvaluator(address(evaluator));
        evaluator.setVerifier(attester, true);
        vm.stopPrank();

        // Creator: rewards in the payment token, bonds plus the hold minimum in FACTORY.
        pay.mint(creator, 10 * REWARD);
        factory.mint(creator, 10 * CREATOR_BOND + MIN_HOLD);
        vm.startPrank(creator);
        pay.approve(address(holding), type(uint256).max);
        factory.approve(address(holding), type(uint256).max);
        vm.stopPrank();
        // Worker: bonds plus the hold minimum in FACTORY, nothing else.
        factory.mint(worker, 10 * WORKER_BOND + MIN_HOLD);
        vm.prank(worker);
        factory.approve(address(holding), type(uint256).max);
        // The worker participates with its registered ERC-8004 agent wallet.
        identity.setAgentWallet(AGENT_ID, worker);

        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------------------------------------
    // Lifecycle helpers
    // ------------------------------------------------------------------------------------------

    function deliveryDeadline() internal view returns (uint48) {
        return uint48(block.timestamp + 7 days);
    }

    function expiry() internal view returns (uint48) {
        return deliveryDeadline() + evaluator.settlementWindow();
    }

    function params(uint256 reward, uint256 creatorBond, uint256 workerBond)
        internal
        returns (JobHolding.PublishParams memory)
    {
        return JobHolding.PublishParams({
            approver: address(0),
            manifestHash: MANIFEST,
            policyHash: keccak256(abi.encode(POLICY, ++policyNonce)),
            token: IERC20(address(pay)),
            reward: reward,
            creatorBond: creatorBond,
            workerBond: workerBond,
            deliveryDeadline: deliveryDeadline(),
            expiredAt: expiry(),
            mode: JobHolding.Mode.HireFirst,
            selectionDeadline: 0
        });
    }

    // ---- hire: the creator's signed Selection, the worker's own activation ----

    /// @dev A selection valid until one second before the delivery deadline, nonce = jobId.
    function selectionFor(uint256 jobId, address who, uint256 agentId)
        internal
        view
        returns (JobHolding.Selection memory)
    {
        return JobHolding.Selection({
            jobId: jobId,
            worker: who,
            agentId: agentId,
            termsHash: holding.policyHashOf(jobId),
            activateBy: holding.deliveryDeadlineOf(jobId) - 1,
            nonce: jobId
        });
    }

    function signSelection(uint256 pk, JobHolding.Selection memory sel) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, holding.selectionDigest(sel));
        return abi.encodePacked(r, s_, v);
    }

    /// @dev The worker's core `SetBudgetAuthorization` for the listed token and `amount`.
    function budgetAuth(uint256 pk, address signer, uint256 jobId, uint256 amount, uint72 nonce)
        internal
        view
        returns (ERC8183WithAuthorization.Authorization memory)
    {
        uint256 deadline = block.timestamp + 1 hours;
        return ERC8183WithAuthorization.Authorization(
            signer, nonce, deadline, signSetBudget(pk, signer, jobId, address(pay), amount, nonce, deadline)
        );
    }

    function activateAs(JobHolding.Selection memory sel, uint256 workerKey) internal {
        bytes memory sig = signSelection(creatorPk, sel);
        ERC8183WithAuthorization.Authorization memory auth =
            budgetAuth(workerKey, sel.worker, sel.jobId, listing(sel.jobId).reward, uint72(sel.jobId));
        vm.prank(sel.worker);
        holding.activate(sel, sig, auth);
    }

    function activate(uint256 jobId) internal {
        activateAs(selectionFor(jobId, worker, AGENT_ID), workerPk);
    }

    // ---- contest: finished entries, the approver's atomic award ----

    function signSubmit(uint256 pk, address signer, uint256 jobId, bytes32 deliverable, uint72 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return sign(
            pk,
            keccak256(
                abi.encode(
                    core.SUBMIT_AUTHORIZATION_TYPEHASH(), signer, jobId, deliverable, keccak256(""), nonce, deadline
                )
            )
        );
    }

    /// @dev A finished entry with the two core authorisations the entrant signs at entry, valid until the
    ///      selection deadline. Nonces `nonce` (budget) and `nonce + 1` (submit).
    function candidate(uint256 jobId, address who, uint256 pk, uint256 agentId, bytes32 deliverable, uint72 nonce)
        internal
        view
        returns (JobHolding.Candidate memory c)
    {
        JobHolding.Listing memory l = listing(jobId);
        uint256 deadline = l.selectionDeadline;
        c.worker = who;
        c.agentId = agentId;
        c.deliverable = deliverable;
        c.budgetAuth = ERC8183WithAuthorization.Authorization(
            who, nonce, deadline, signSetBudget(pk, who, jobId, address(pay), l.reward, nonce, deadline)
        );
        c.submitAuth = ERC8183WithAuthorization.Authorization(
            who, nonce + 1, deadline, signSubmit(pk, who, jobId, deliverable, nonce + 1, deadline)
        );
    }

    function publishContest() internal returns (uint256 jobId) {
        JobHolding.PublishParams memory p = contestParams(REWARD, CREATOR_BOND);
        vm.prank(creator);
        jobId = holding.publish(p);
    }

    /// @dev Contests carry no worker bond (R20).
    function contestParams(uint256 reward, uint256 creatorBond) internal returns (JobHolding.PublishParams memory p) {
        p = params(reward, creatorBond, 0);
        p.mode = JobHolding.Mode.Contest;
        p.selectionDeadline = uint48(block.timestamp + 2 days);
    }

    function publish(uint256 reward, uint256 creatorBond, uint256 workerBond) internal returns (uint256 jobId) {
        // Precomputed: `params` makes external calls, which would otherwise consume the prank.
        JobHolding.PublishParams memory p = params(reward, creatorBond, workerBond);
        vm.prank(creator);
        jobId = holding.publish(p);
    }

    function publish() internal returns (uint256) {
        return publish(REWARD, CREATOR_BOND, WORKER_BOND);
    }

    function submitDirect(uint256 jobId) internal {
        vm.prank(worker);
        core.submit(jobId, DELIVERABLE, "");
    }

    function submitRelayed(uint256 jobId, uint72 nonce) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = sign(
            workerPk,
            keccak256(
                abi.encode(
                    core.SUBMIT_AUTHORIZATION_TYPEHASH(), worker, jobId, DELIVERABLE, keccak256(""), nonce, deadline
                )
            )
        );
        vm.prank(relayer);
        core.submitWithAuthorization(
            jobId, DELIVERABLE, "", ERC8183WithAuthorization.Authorization(worker, nonce, deadline, sig)
        );
    }

    /// @dev publish → activate (the worker's own transaction) → submit (direct). Returns the job in Submitted.
    function submittedJob() internal returns (uint256 jobId) {
        jobId = fundedJob();
        submitDirect(jobId);
    }

    function fundedJob() internal returns (uint256 jobId) {
        jobId = publish();
        activate(jobId);
    }

    function disputedJob() internal returns (uint256 jobId) {
        jobId = submittedJob();
        vm.prank(creator);
        evaluator.creatorReject(jobId);
        vm.prank(worker);
        evaluator.dispute(jobId);
    }

    function status(uint256 jobId) internal view returns (ERC8183.JobStatus) {
        return core.getJob(jobId).status;
    }

    function listing(uint256 jobId) internal view returns (JobHolding.Listing memory) {
        return holding.getListing(jobId);
    }

    // ------------------------------------------------------------------------------------------
    // EIP-712
    // ------------------------------------------------------------------------------------------

    function sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function signSetBudget(
        uint256 pk,
        address signer,
        uint256 jobId,
        address token_,
        uint256 amount,
        uint72 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return sign(
            pk,
            keccak256(
                abi.encode(
                    core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                    signer,
                    jobId,
                    token_,
                    amount,
                    keccak256(""),
                    nonce,
                    deadline
                )
            )
        );
    }

    function attestation(uint256 jobId, uint8 conclusion, uint256 validUntil)
        internal
        view
        returns (JobsEvaluator.EvidenceAttestation memory)
    {
        return JobsEvaluator.EvidenceAttestation({
            jobId: jobId,
            submissionHash: DELIVERABLE,
            policyHash: holding.policyHashOf(jobId),
            repo: keccak256("github.com/worker/fork"),
            headSha: bytes32(uint256(0xabc)),
            testedSha: bytes32(uint256(0xdef)),
            checkRunsHash: keccak256("build,typecheck,test"),
            conclusion: conclusion,
            validUntil: validUntil
        });
    }

    function evidenceDigest(JobsEvaluator.EvidenceAttestation memory a) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                evaluator.EVIDENCE_TYPEHASH(),
                a.jobId,
                a.submissionHash,
                a.policyHash,
                a.repo,
                a.headSha,
                a.testedSha,
                a.checkRunsHash,
                a.conclusion,
                a.validUntil
            )
        );
        (, string memory name, string memory version,, address verifying,,) = evaluator.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                verifying
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function signEvidence(uint256 pk, JobsEvaluator.EvidenceAttestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, evidenceDigest(a));
        return abi.encodePacked(r, s, v);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {RewardToken} from "../src/RewardToken.sol";

/// @dev Deploys the whole system the way the demo will: our own core proxy (fees 0, one allowlisted token,
///      no hooks), Holding wired to the evaluator, the arbitrator pinned. Helpers walk a job through the
///      lifecycle both directly and through the authorization relay.
abstract contract Base is Test {
    uint48 internal constant REVIEW = 3 days;
    uint48 internal constant DISPUTE = 3 days;
    uint48 internal constant ARBITRATION = 7 days;
    uint48 internal constant MARGIN = 1 days;
    uint256 internal constant REWARD = 100e18;
    uint256 internal constant BOND = 20e18;
    uint256 internal constant AGENT_ID = 42;
    bytes32 internal constant MANIFEST = keccak256("manifest-v1");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");

    address internal deployer = makeAddr("deployer");
    address internal arbitrator = makeAddr("arbitrator");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    address internal relayer = makeAddr("relayer");
    address internal worker;
    uint256 internal workerPk;
    address internal impostor;
    uint256 internal impostorPk;

    RewardToken internal token;
    ERC8183WithAuthorization internal core;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;

    function setUp() public virtual {
        (worker, workerPk) = makeAddrAndKey("worker");
        (impostor, impostorPk) = makeAddrAndKey("impostor");

        vm.startPrank(deployer);
        token = new RewardToken();
        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        bytes memory init = abi.encodeCall(ERC8183WithAuthorization.initialize, (deployer, deployer));
        core = ERC8183WithAuthorization(address(new ERC1967Proxy(address(impl), init)));
        core.setPaymentTokenAllowed(address(token), true);
        core.setPlatformFee(0, deployer);
        core.setEvaluatorFee(0);
        holding = new JobHolding(core, token);
        evaluator = new JobsEvaluator(core, holding, arbitrator, REVIEW, DISPUTE, ARBITRATION, MARGIN);
        holding.setEvaluator(address(evaluator));
        vm.stopPrank();

        token.mint(creator, 10 * (REWARD + BOND));
        vm.prank(creator);
        token.approve(address(holding), type(uint256).max);
        // Leave block 1 / timestamp 1 behind so "now" arithmetic is realistic.
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

    function publish(uint256 reward, uint256 bond) internal returns (uint256 jobId) {
        // Precomputed: `expiry()` makes an external call, which would otherwise consume the prank.
        uint48 dd = deliveryDeadline();
        uint48 exp = expiry();
        vm.prank(creator);
        jobId = holding.publish(MANIFEST, reward, bond, dd, exp);
    }

    function assign(uint256 jobId) internal {
        vm.prank(creator);
        holding.assign(jobId, worker, AGENT_ID);
    }

    /// @dev The cast-style worker: sends setBudget itself.
    function acceptDirect(uint256 jobId, uint256 amount) internal {
        vm.prank(worker);
        core.setBudget(jobId, address(token), amount, "");
    }

    /// @dev The relay-style worker: signs SetBudgetAuthorization, anyone submits it.
    function acceptRelayed(uint256 jobId, uint256 amount, uint72 nonce, uint256 deadline) internal {
        bytes memory sig = signSetBudget(workerPk, worker, jobId, address(token), amount, nonce, deadline);
        vm.prank(relayer);
        core.setBudgetWithAuthorization(
            jobId, address(token), amount, "", ERC8183WithAuthorization.Authorization(worker, nonce, deadline, sig)
        );
    }

    function fund(uint256 jobId) internal {
        vm.prank(stranger);
        holding.fundAfterAccept(jobId);
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

    /// @dev publish → assign → accept (direct) → fund → submit (direct). Returns the job in Submitted.
    function submittedJob(uint256 reward, uint256 bond) internal returns (uint256 jobId) {
        jobId = publish(reward, bond);
        assign(jobId);
        acceptDirect(jobId, reward);
        fund(jobId);
        submitDirect(jobId);
    }

    function fundedJob(uint256 reward, uint256 bond) internal returns (uint256 jobId) {
        jobId = publish(reward, bond);
        assign(jobId);
        acceptDirect(jobId, reward);
        fund(jobId);
    }

    function status(uint256 jobId) internal view returns (ERC8183.JobStatus) {
        return core.getJob(jobId).status;
    }

    function listing(uint256 jobId) internal view returns (JobHolding.Listing memory l) {
        (l.creator, l.deliveryDeadline, l.funded, l.rewardWithdrawn, l.bondSettled, l.reward, l.bond, l.manifestHash)
        = holding.listings(jobId);
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
}

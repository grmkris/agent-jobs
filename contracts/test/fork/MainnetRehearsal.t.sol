// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";
import {JobHolding} from "../../src/JobHolding.sol";
import {JobsEvaluator} from "../../src/JobsEvaluator.sol";
import {Recipe} from "../../script/Recipe.sol";

/// @dev The B7 rehearsal on a local fork of Monad mainnet (nothing is sent): the committed mainnet recipe, then real
///      Circle USDC jobs against the real ERC-8004 registries, with the arbitrator's key signing a ruling as the board
///      relays it. FACTORY is minted on the fork only where a test needs bonds, the way the minter would on mainnet.
///      Skipped unless MONAD_MAINNET_RPC_URL is set.
contract MainnetRehearsalForkTest is Test {
    uint256 internal constant REWARD = 5e6; // 5 USDC
    uint256 internal constant BOND = 10e18;

    bool internal forked;
    Recipe.Config internal c;
    Recipe.Deployed internal d;
    IERC20 internal usdc;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;
    ERC8183WithAuthorization internal core;
    IERC8004Identity internal identity;
    IERC8004Reputation internal reputation;

    address internal creator;
    uint256 internal creatorPk;
    address internal worker;
    uint256 internal workerPk;
    uint256 internal arbitratorPk;
    uint256 internal agentId;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        c = Recipe.load(vm, "monad-mainnet");
        // The configured arbitrator address has its key only in .env.local; the fork swaps in a test key so the
        // ruling is signed exactly as the board would sign it.
        (c.arbitrator, arbitratorPk) = makeAddrAndKey("fork-arbitrator");
        vm.startBroadcast(c.admin);
        d = Recipe.deploy(c);
        vm.stopBroadcast();
        usdc = IERC20(d.rewardTokens[0]);
        holding = d.holdings[0];
        evaluator = d.evaluators[0];
        core = ERC8183WithAuthorization(address(d.core));
        identity = c.identity;
        reputation = c.reputation;

        (creator, creatorPk) = makeAddrAndKey("fork-creator");
        (worker, workerPk) = makeAddrAndKey("fork-worker");
        deal(address(usdc), creator, 100e6);
        vm.prank(creator);
        usdc.approve(address(holding), type(uint256).max);
        vm.prank(worker);
        agentId = identity.register();
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _bonds() internal {
        vm.startPrank(c.factoryMinter);
        d.factory.mint(creator, BOND);
        d.factory.mint(worker, BOND);
        vm.stopPrank();
        vm.prank(creator);
        IERC20(address(d.factory)).approve(address(holding), BOND);
        vm.prank(worker);
        IERC20(address(d.factory)).approve(address(holding), BOND);
    }

    function _hire(uint256 creatorBond, uint256 workerBond) internal returns (uint256 jobId) {
        uint48 dd = uint48(block.timestamp + 2 days);
        JobHolding.PublishParams memory p = JobHolding.PublishParams({
            approver: address(0),
            manifestHash: keccak256("mainnet-rehearsal"),
            policyHash: keccak256(abi.encode("mainnet-rehearsal-policy", block.timestamp, creatorBond)),
            token: usdc,
            reward: REWARD,
            creatorBond: creatorBond,
            workerBond: workerBond,
            deliveryDeadline: dd,
            expiredAt: dd + evaluator.settlementWindow(),
            mode: JobHolding.Mode.HireFirst,
            selectionDeadline: 0
        });
        vm.prank(creator);
        jobId = holding.publish(p);
        JobHolding.Selection memory sel = JobHolding.Selection({
            jobId: jobId,
            worker: worker,
            agentId: agentId,
            termsHash: holding.policyHashOf(jobId),
            activateBy: dd - 1,
            nonce: jobId
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, holding.selectionDigest(sel));
        bytes memory sig = abi.encodePacked(r, s, v);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                core.SET_BUDGET_AUTHORIZATION_TYPEHASH(), worker, jobId, address(usdc), REWARD, keccak256(""), uint72(jobId), deadline
            )
        );
        (v, r, s) = vm.sign(workerPk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        ERC8183WithAuthorization.Authorization memory auth =
            ERC8183WithAuthorization.Authorization(worker, uint72(jobId), deadline, abi.encodePacked(r, s, v));
        vm.prank(worker);
        holding.activate(sel, sig, auth);
        vm.prank(worker);
        core.submit(jobId, keccak256(abi.encode("commit", jobId)), "");
    }

    function test_fork_mainnet_usdcHireWithoutBondsPaysAndRecordsFeedback() public onFork {
        uint256 before = usdc.balanceOf(worker);
        uint256 jobId = _hire(0, 0);
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(uint256(core.getJob(jobId).status), uint256(ERC8183.JobStatus.Completed));
        assertEq(usdc.balanceOf(worker) - before, REWARD, "worker paid in real USDC");
        assertEq(usdc.balanceOf(address(holding)), 0, "nothing left in escrow");
        (int128 value,,, string memory tag2,) = reputation.readFeedback(agentId, address(evaluator), 1);
        assertEq(value, 1);
        assertEq(tag2, "completed");
    }

    function test_fork_mainnet_silenceSettlesForTheWorkerAfterTheReviewWindow() public onFork {
        uint256 jobId = _hire(0, 0);
        vm.warp(block.timestamp + evaluator.reviewWindow() + 1);
        evaluator.completeAfterSilence(jobId);
        assertEq(usdc.balanceOf(worker), REWARD);
    }

    function test_fork_mainnet_signedRulingForTheCreatorBurnsTheWorkerBond() public onFork {
        _bonds();
        uint256 jobId = _hire(BOND, BOND);
        vm.prank(creator);
        evaluator.reject(jobId, JobsEvaluator.Violation.Quality, keccak256("tests fail"));
        vm.prank(worker);
        evaluator.dispute(jobId);
        JobsEvaluator.Ruling memory r = JobsEvaluator.Ruling({
            jobId: jobId,
            forWorker: false,
            slashLoser: true,
            reasonHash: keccak256("the tests fail on the submitted commit"),
            deadline: block.timestamp + 1 days,
            nonce: 1
        });
        (uint8 v, bytes32 rs, bytes32 s) = vm.sign(arbitratorPk, evaluator.rulingDigest(r));
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.prank(makeAddr("relay"));
        evaluator.ruleWithSignature(r, abi.encodePacked(rs, s, v));
        // The core refund lands in Holding; the permissionless `settle` pays it to whoever is owed (R114-03).
        holding.settle(jobId);
        assertEq(usdc.balanceOf(creator) - creatorBefore, REWARD, "reward refunded to the creator");
        assertEq(IERC20(address(d.factory)).balanceOf(worker), 0, "worker bond burned");
        assertEq(IERC20(address(d.factory)).balanceOf(creator), BOND, "creator bond returned");
        vm.expectRevert(JobsEvaluator.RulingNonceUsed.selector);
        evaluator.ruleWithSignature(r, abi.encodePacked(rs, s, v));
    }

    function test_fork_mainnet_withoutMintedFactoryOnlyBondlessJobsPublish() public onFork {
        // With the minter holding back supply, a listing asking for a bond cannot be published: the one FACTORY
        // decision that changes what mainnet users can do on day one.
        JobHolding.PublishParams memory p = JobHolding.PublishParams({
            approver: address(0),
            manifestHash: keccak256("bonded"),
            policyHash: keccak256("bonded-policy"),
            token: usdc,
            reward: REWARD,
            creatorBond: BOND,
            workerBond: 0,
            deliveryDeadline: uint48(block.timestamp + 2 days),
            expiredAt: uint48(block.timestamp + 2 days) + evaluator.settlementWindow(),
            mode: JobHolding.Mode.HireFirst,
            selectionDeadline: 0
        });
        vm.prank(creator);
        vm.expectRevert();
        holding.publish(p);
    }
}

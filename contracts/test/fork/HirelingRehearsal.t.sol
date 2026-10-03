// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "../../src/hireling/interfaces/IHirelingEvaluator.sol";
import {IStakeVault} from "../../src/hireling/interfaces/IStakeVault.sol";
import {HirelingRecipe} from "../../script/HirelingRecipe.sol";
import {HirelingVerify} from "../../script/HirelingVerify.sol";
import {IMiningReserve} from "../../src/hireling/interfaces/IMiningReserve.sol";
import {RecipeDriver} from "../hireling/Recipe.t.sol";

/// @dev The C8 rehearsal on a local fork of Monad (nothing is sent). The recipe runs step by step from the configured
///      deployer with third-party calls between the steps, the Safe accepts every handover, and one hire runs end to
///      end against the real ERC-8004 registries (testnet: the live core is reused; mainnet: a fresh core whose admin
///      roles move to the Safe). The `hireling` inputs are the rehearsal's own, since the coordinator owns the config
///      values. Skipped unless MONAD_TESTNET_RPC_URL / MONAD_MAINNET_RPC_URL are set (public RPCs work).
contract HirelingRehearsalForkTest is Test {
    address safe = makeAddr("rehearsal-safe");
    address stranger = makeAddr("stranger");
    address arbitrator;
    uint256 arbitratorPk;

    function _fork(string memory rpcVar) internal returns (bool) {
        string memory rpc = vm.envOr(rpcVar, string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    function _config(string memory network, bool reuseCore) internal returns (HirelingRecipe.Config memory c) {
        (arbitrator, arbitratorPk) = makeAddrAndKey("rehearsal-arbiter");
        c = HirelingRecipe.loadBase(vm, network);
        // G1b uses the checked-in fast tuple; the mainnet fork deliberately keeps production values.
        if (reuseCore) c.clocks = HirelingRecipe.load(vm, network).clocks;
        vm.etch(safe, hex"00"); // the recipe requires code at the Safe
        c.reuseCore = reuseCore;
        c.safe = safe;
        c.defaultArbitrator = arbitrator;
        c.arbitrator = arbitrator; // the fixture's own role, not the shipped config's (LAUNCH-AUDIT-FIX-001/002)
        c.margin = 1 days;
        c.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        c.bps = [uint16(3000), 1000, 300, 100];
        c.feeTreasury = safe;
        c.treasury = safe;
        c.ecosystem = reuseCore ? c.admin : safe;
        c.liquidity = c.admin;
        c.vestingBeneficiary = makeAddr("team");
        c.vestingStartOffset = 365 days;
        c.vestingDuration = 3 * 365 days;
    }

    function _deploy(HirelingRecipe.Config memory c) internal returns (HirelingRecipe.Deployed memory d) {
        RecipeDriver driver = new RecipeDriver();
        driver.configure(c);
        for (uint256 i; i < 13; ++i) {
            driver.step(i);
            d = driver.deployed();
            // A third party between every step: staking, early publishing and every one-time setup fail.
            if (address(d.vault) != address(0) && !d.vault.bootstrapped()) {
                vm.prank(stranger);
                vm.expectRevert(IStakeVault.NotBootstrapped.selector);
                d.vault.stake(1);
            }
            if (address(d.vault) != address(0)) {
                vm.prank(stranger);
                vm.expectRevert();
                d.vault.bootstrapHolding(stranger);
            }
            if (address(d.holding) != address(0)) {
                vm.prank(stranger);
                vm.expectRevert();
                d.holding.setEvaluator(stranger);
            }
            if (address(d.distributor) != address(0)) {
                vm.prank(stranger);
                vm.expectRevert();
                d.distributor.setRoot(0, keccak256("root"), 0, bytes32(0));
            }
        }
        vm.startPrank(safe);
        d.vault.acceptOwnership();
        d.fees.acceptOwnership();
        d.holding.acceptOwnership();
        d.evaluator.acceptOwnership();
        d.distributor.acceptOwnership();
        d.reserve.acceptOwnership();
        vm.stopPrank();
    }

    function _assertDeployed(HirelingRecipe.Config memory c, HirelingRecipe.Deployed memory d) internal view {
        HirelingVerify.verify(c, d);
        assertEq(d.vault.owner(), safe);
        assertEq(d.fees.owner(), safe);
        assertEq(d.holding.owner(), safe);
        assertEq(d.evaluator.owner(), safe);
        assertEq(d.distributor.owner(), safe);
        assertEq(d.reserve.owner(), safe);
        assertEq(d.factory.totalSupply(), 1_000_000_000e18);
        assertEq(d.factory.balanceOf(address(d.reserve)), 500_000_000e18);
        assertEq(d.core.platformFeeBP(), 0);
        assertEq(d.core.evaluatorFeeBP(), 0);
        assertEq(address(d.holding.identity()), address(c.identity));
        assertEq(address(d.evaluator.reputation()), address(c.reputation));
        assertTrue(d.evaluator.verifiers(c.attester));
        assertTrue(d.vault.isHolding(address(d.holding)));
        assertEq(d.holding.MIN_REVIEW_WINDOW(), c.clocks.minReviewWindow);
        assertEq(d.holding.MIN_DISPUTE_WINDOW(), c.clocks.minDisputeWindow);
        assertEq(d.holding.MIN_ARBITRATION_WINDOW(), c.clocks.minArbitrationWindow);
        assertEq(d.vault.UNSTAKE_DELAY(), c.clocks.unstakeDelay);
        assertEq(d.vault.HOLDING_DELAY(), c.clocks.holdingDelay);
        assertEq(d.fees.DELAY(), c.clocks.feeDelay);
        assertEq(d.fees.PROPOSAL_GRACE(), c.clocks.proposalGrace);
        assertEq(d.reserve.EPOCH_ZERO_DURATION(), c.clocks.epochZeroDuration);
        assertEq(d.reserve.EPOCH_DURATION(), c.clocks.epochDuration);
        assertEq(d.distributor.EPOCH_ZERO_DURATION(), c.clocks.epochZeroDuration);
        assertEq(d.distributor.EPOCH_DURATION(), c.clocks.epochDuration);
    }

    function _budgetAuth(
        ERC8183WithAuthorization core,
        uint256 pk,
        address signer,
        uint256 jobId,
        address token,
        uint256 amount
    ) internal view returns (ERC8183WithAuthorization.Authorization memory) {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                signer,
                jobId,
                token,
                amount,
                keccak256(""),
                uint72(1),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return ERC8183WithAuthorization.Authorization(signer, 1, deadline, abi.encodePacked(r, s, v));
    }

    /// @dev One hire with a dispute ruled for the worker by a relayed signed ruling, then settle.
    function _hire(HirelingRecipe.Config memory c, HirelingRecipe.Deployed memory d, IERC20 token, uint256 reward)
        internal
    {
        (address creator, uint256 creatorPk) = makeAddrAndKey("rehearsal-creator");
        (address worker, uint256 workerPk) = makeAddrAndKey("rehearsal-worker");
        deal(address(token), creator, reward);
        vm.prank(worker);
        uint256 agentId = c.identity.register();
        assertEq(c.identity.getAgentWallet(agentId), worker);
        vm.prank(c.admin);
        d.factory.transfer(worker, 20_000e18);
        vm.startPrank(worker);
        d.factory.approve(address(d.vault), type(uint256).max);
        d.vault.stake(20_000e18);
        vm.stopPrank();

        uint48 deadline = uint48(vm.getBlockTimestamp() + 2 days);
        IHirelingHolding.PublishParams memory p = IHirelingHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256("rehearsal-manifest"),
            policyHash: keccak256("rehearsal-policy"),
            token: token,
            reward: reward,
            creatorBond: 0,
            workerBond: 10e18,
            deliveryDeadline: deadline,
            expiredAt: deadline + c.clocks.minReviewWindow + c.clocks.minDisputeWindow + c.clocks.minArbitrationWindow
                + c.margin,
            reviewWindow: c.clocks.minReviewWindow,
            disputeWindow: c.clocks.minDisputeWindow,
            arbitrationWindow: c.clocks.minArbitrationWindow
        });
        vm.startPrank(creator);
        token.approve(address(d.holding), reward);
        uint256 jobId = d.holding.publish(p);
        vm.stopPrank();

        IHirelingHolding.Selection memory sel =
            IHirelingHolding.Selection(jobId, worker, agentId, keccak256("rehearsal-policy"), deadline - 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, d.holding.selectionDigest(sel));
        (, uint256 fee, uint256 net) = d.holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(d.core, workerPk, worker, jobId, address(token), net);
        vm.prank(worker);
        d.holding.activate(sel, abi.encodePacked(r, s, v), auth);
        vm.prank(worker);
        d.core.submit(jobId, keccak256("rehearsal-work"), "");
        vm.prank(creator);
        d.evaluator.reject(jobId, IHirelingEvaluator.Violation.Quality, keccak256("reason"));
        vm.prank(worker);
        d.evaluator.dispute(jobId);

        IHirelingEvaluator.Ruling memory ruling =
            IHirelingEvaluator.Ruling(jobId, true, false, keccak256("ruling"), vm.getBlockTimestamp() + 1 hours, 1);
        (v, r, s) = vm.sign(arbitratorPk, d.evaluator.rulingDigest(ruling));
        uint256 workerBefore = token.balanceOf(worker);
        vm.prank(stranger);
        d.evaluator.ruleWithSignature{gas: 1_200_000}(ruling, abi.encodePacked(r, s, v));
        d.holding.settle{gas: 1_000_000}(jobId);
        assertEq(uint8(d.core.getJob(jobId).status), uint8(ERC8183.JobStatus.Completed));
        assertEq(token.balanceOf(worker) - workerBefore, net);
        assertEq(token.balanceOf(safe), fee);
        assertEq(d.vault.reservedOf(worker), 0);
    }

    function test_fork_testnet_reusedCore_oneHire() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return vm.skip(true);
        HirelingRecipe.Config memory c = _config("monad-testnet", true);
        HirelingRecipe.Deployed memory d = _deploy(c);
        _assertDeployed(c, d);
        assertEq(address(d.core), c.existingCore, "the live testnet core is reused");
        assertFalse(d.coreDeployed);
        string memory json = vm.readFile(HirelingRecipe.path(vm, "monad-testnet"));
        IERC20 mUsd = IERC20(vm.parseJsonAddressArray(json, ".deployment.rewardTokens")[0]);
        _hire(c, d, mUsd, 25e6);
        // Fast G1b closes epoch zero in 30 min and claims into the new vault, on real testnet dependencies.
        assertEq(c.clocks.epochZeroDuration, 1800);
        assertEq(c.clocks.epochDuration, 3600);
        uint256 end = d.reserve.epochEnd(0);
        bytes32 root = d.distributor.leaf(0, stranger, 1e18);
        vm.warp(end - 1);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(IMiningReserve.EpochNotEnded.selector, 0, end));
        d.reserve.fund(0, 1e18);
        vm.warp(end);
        vm.startPrank(safe);
        d.reserve.fund(0, 1e18);
        d.distributor.setRoot(0, root, 1e18, keccak256("fork-only-epoch"));
        vm.stopPrank();
        d.distributor.claim(0, stranger, 1e18, new bytes32[](0));
        assertEq(d.vault.stakeOf(stranger), 1e18);
        assertEq(d.reserve.epochEnd(1), end + 3600);
    }

    function test_fork_mainnet_freshCore_rolesToSafe_oneHire() public {
        if (!_fork("MONAD_MAINNET_RPC_URL")) return vm.skip(true);
        HirelingRecipe.Config memory c = _config("monad-mainnet", false);
        HirelingRecipe.Deployed memory d = _deploy(c);
        _assertDeployed(c, d);
        assertTrue(d.coreDeployed);
        assertTrue(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(d.core.hasRole(d.core.ADMIN_ROLE(), safe));
        assertFalse(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), c.admin));
        assertFalse(d.core.hasRole(d.core.ADMIN_ROLE(), c.admin));
        string memory json = vm.readFile(HirelingRecipe.path(vm, "monad-mainnet"));
        IERC20 usdc = IERC20(vm.parseJsonAddressArray(json, ".knownTokens")[0]);
        _hire(c, d, usdc, 5e6);
    }
}

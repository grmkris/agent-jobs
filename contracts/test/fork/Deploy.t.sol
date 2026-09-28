// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {EvidenceReceiver} from "../../src/EvidenceReceiver.sol";
import {FactoryToken} from "../../src/FactoryToken.sol";
import {Recipe} from "../../script/Recipe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {JobHolding} from "../../src/JobHolding.sol";
import {JobsEvaluator} from "../../src/JobsEvaluator.sol";

/// @dev The deployment recipe against a fork of each network with its committed config (spec S7 item 4). Nothing is
///      broadcast. Skipped unless MONAD_TESTNET_RPC_URL / MONAD_MAINNET_RPC_URL are set.
contract DeployForkTest is Test {
    function _fork(string memory rpcVar) internal returns (bool) {
        string memory rpc = vm.envOr(rpcVar, string(""));
        if (bytes(rpc).length == 0) return false;
        vm.createSelectFork(rpc);
        return true;
    }

    function _deploy(Recipe.Config memory c) internal returns (Recipe.Deployed memory d) {
        vm.startBroadcast(c.admin);
        d = Recipe.deploy(c);
        vm.stopBroadcast();
    }

    function _assertCommon(Recipe.Config memory c, Recipe.Deployed memory d) internal view {
        assertTrue(d.core.hasRole(d.core.ADMIN_ROLE(), c.admin), "admin EOA holds the admin role");
        assertEq(d.core.platformFeeBP(), 0);
        assertEq(d.core.evaluatorFeeBP(), 0);
        assertFalse(d.core.allowedPaymentTokens(address(d.factory)), "FACTORY never enters the core");
        for (uint256 i; i < d.rewardTokens.length; ++i) {
            assertTrue(d.core.allowedPaymentTokens(d.rewardTokens[i]));
            assertEq(IERC20Metadata(d.rewardTokens[i]).decimals(), 6);
        }
        for (uint256 i; i < d.holdings.length; ++i) {
            assertEq(d.holdings[i].evaluator(), address(d.evaluators[i]));
            assertEq(address(d.holdings[i].identity()), address(c.identity));
            assertEq(d.holdings[i].admin(), c.admin);
            assertEq(d.evaluators[i].arbitrator(), c.arbitrator);
            assertTrue(d.evaluators[i].verifiers(c.attester));
            assertEq(d.evaluators[i].reviewWindow(), c.reviewWindows[i]);
            assertEq(d.evaluators[i].arbitrationWindow(), c.arbitrationWindows[i]);
            assertEq(address(d.evaluators[i].reputation()), address(c.reputation));
        }
        assertGt(address(c.identity).code.length, 0, "identity registry exists on this chain");
        assertGt(address(c.reputation).code.length, 0, "reputation registry exists on this chain");
    }

    /// @dev The stacks-only redeploy (script/DeployStacks.s.sol): new pairs against the deployed core and FACTORY,
    ///      wired like the recipe's, while the recorded pairs keep their evaluators.
    function test_fork_testnetStacksOnly() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return vm.skip(true);
        Recipe.Config memory c = Recipe.load(vm, "monad-testnet");
        string memory json = vm.readFile(Recipe.path(vm, "monad-testnet"));
        ERC8183WithAuthorization core = ERC8183WithAuthorization(vm.parseJsonAddress(json, ".deployment.core"));
        IERC20 factory = IERC20(vm.parseJsonAddress(json, ".deployment.factory"));
        JobHolding oldMain = JobHolding(vm.parseJsonAddress(json, ".deployment.main.holding"));
        address oldEvaluator = oldMain.evaluator();
        vm.startBroadcast(c.admin);
        (JobHolding[] memory holdings, JobsEvaluator[] memory evaluators) = Recipe.deployStacks(c, core, factory);
        vm.stopBroadcast();
        assertEq(holdings.length, 2);
        for (uint256 i; i < holdings.length; ++i) {
            assertEq(address(holdings[i].core()), address(core));
            assertEq(address(holdings[i].factory()), address(factory));
            assertEq(holdings[i].evaluator(), address(evaluators[i]));
            assertTrue(evaluators[i].verifiers(c.attester));
            assertEq(evaluators[i].reviewWindow(), c.reviewWindows[i]);
            assertTrue(address(holdings[i]) != address(oldMain));
        }
        assertEq(oldMain.evaluator(), oldEvaluator, "the recorded pair is untouched");
    }

    function test_fork_testnetRecipe() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return vm.skip(true);
        Recipe.Config memory c = Recipe.load(vm, "monad-testnet");
        Recipe.Deployed memory d = _deploy(c);
        _assertCommon(c, d);
        assertEq(d.holdings.length, 2, "main and demo stacks");
        assertEq(d.evaluators[1].settlementWindow(), 600, "demo windows 2m/2m/5m + 1m");
        assertEq(IERC20Metadata(d.rewardTokens[0]).symbol(), "mUSD");
        assertEq(IERC20Metadata(d.rewardTokens[1]).symbol(), "mEUR");
        assertTrue(FactoryToken(address(d.factory)).faucetEnabled());
    }

    function test_fork_mainnetRecipeHasNoFaucet() public {
        if (!_fork("MONAD_MAINNET_RPC_URL")) return vm.skip(true);
        Recipe.Config memory c = Recipe.load(vm, "monad-mainnet");
        Recipe.Deployed memory d = _deploy(c);
        _assertCommon(c, d);
        assertEq(d.holdings.length, 1);
        assertEq(d.rewardTokens.length, 1);
        assertEq(IERC20Metadata(d.rewardTokens[0]).symbol(), "USDC", "real USDC allowlisted");
        assertFalse(FactoryToken(address(d.factory)).faucetEnabled(), "no faucet");
        vm.expectRevert(FactoryToken.FaucetDisabled.selector);
        FactoryToken(address(d.factory)).faucet();
    }

    function test_fork_mainnetRecipeRefusesAFaucetConfig() public {
        if (!_fork("MONAD_MAINNET_RPC_URL")) return vm.skip(true);
        Recipe.Config memory c = Recipe.load(vm, "monad-mainnet");
        c.factoryFaucet = true;
        vm.expectRevert(Recipe.FaucetOnMainnet.selector);
        this.deployExternal(c);
    }

    function test_fork_recipeRefusesTheWrongChain() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return vm.skip(true);
        Recipe.Config memory c = Recipe.load(vm, "monad-mainnet");
        vm.expectRevert(abi.encodeWithSelector(Recipe.WrongChain.selector, 143, 10143));
        this.deployExternal(c);
    }

    function test_fork_receiverStepPinsIdentityAndRegisters() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return vm.skip(true);
        Recipe.Config memory c = Recipe.load(vm, "monad-testnet");
        Recipe.Deployed memory d = _deploy(c);
        address forwarder = vm.parseJsonAddress(vm.readFile(Recipe.path(vm, "monad-testnet")), ".cre.forwarder");
        assertGt(forwarder.code.length, 0, "the KeystoneForwarder exists on this chain");
        vm.startBroadcast(c.admin);
        EvidenceReceiver r = Recipe.deployReceiver(d.evaluators[0], forwarder, makeAddr("workflow-owner"), "agent-jobs-evidence");
        vm.stopBroadcast();
        assertTrue(d.evaluators[0].verifiers(address(r)));
        assertEq(r.owner(), address(0), "ownerless: checks can never be weakened");
        assertEq(r.getExpectedAuthor(), makeAddr("workflow-owner"));
    }

    function deployExternal(Recipe.Config memory c) external returns (Recipe.Deployed memory) {
        return Recipe.deploy(c);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../src/vendor/erc8004/IERC8004.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FactoryToken} from "../src/FactoryToken.sol";
import {MockPaymentToken} from "../src/MockPaymentToken.sol";
import {JobHolding} from "../src/JobHolding.sol";
import {JobsEvaluator} from "../src/JobsEvaluator.sol";
import {EvidenceReceiver} from "../src/EvidenceReceiver.sol";

/// @title Recipe
/// @notice The one deployment recipe for every network (spec §4, R114-09). Everything network-specific comes from
///         `config/<network>.json`; no address lives in code. Used by `script/Deploy.s.sol` (real broadcasts) and by
///         the fork tests, which run it against a fork of each network.
///
///         Deploys: our own proxy of the vendored ERC-8183 core (fees 0, no hooks, only the listed reward tokens
///         allowlisted, FACTORY never), `FactoryToken` (testnet: open faucet; production: no faucet, one minter),
///         the testnet faucet reward tokens, and one `JobHolding` + `JobsEvaluator` pair per configured window set
///         ("main" with the real windows; on testnet also "demo"), each with the attester registered as verifier.
///         The CRE `EvidenceReceiver` is a separate step (`deployReceiver`) because it pins the workflow owner.
library Recipe {
    uint256 internal constant MAINNET = 143;

    struct Config {
        string network;
        uint256 chainId;
        address admin;
        address arbitrator;
        address attester;
        IERC8004Identity identity;
        IERC8004Reputation reputation;
        bool factoryFaucet;
        address factoryMinter;
        /// @dev An existing bond token (e.g. FACTORY launched elsewhere); zero deploys our `FactoryToken`.
        address factoryToken;
        uint256 minHoldToPublish;
        uint256 minHoldToClaim;
        string[] faucetTokenNames;
        string[] faucetTokenSymbols;
        address[] allowedTokens;
        string[] stackNames;
        uint256[] reviewWindows;
        uint256[] disputeWindows;
        uint256[] arbitrationWindows;
        uint256[] margins;
    }

    struct Deployed {
        ERC8183WithAuthorization core;
        IERC20 factory;
        address[] rewardTokens;
        JobHolding[] holdings;
        JobsEvaluator[] evaluators;
    }

    error WrongChain(uint256 expected, uint256 actual);
    error FaucetOnMainnet();
    error BadConfig(string what);

    function path(Vm vm, string memory network) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/", network, ".json");
    }

    function load(Vm vm, string memory network) internal view returns (Config memory c) {
        string memory json = vm.readFile(path(vm, network));
        c.network = vm.parseJsonString(json, ".network");
        c.chainId = vm.parseJsonUint(json, ".chainId");
        c.admin = vm.parseJsonAddress(json, ".roles.admin");
        c.arbitrator = vm.parseJsonAddress(json, ".roles.arbitrator");
        c.attester = vm.parseJsonAddress(json, ".roles.attester");
        c.identity = IERC8004Identity(vm.parseJsonAddress(json, ".erc8004.identity"));
        c.reputation = IERC8004Reputation(vm.parseJsonAddress(json, ".erc8004.reputation"));
        c.factoryFaucet = vm.parseJsonBool(json, ".factory.faucet");
        c.factoryMinter = vm.parseJsonAddress(json, ".factory.minter");
        if (vm.keyExistsJson(json, ".factory.address")) c.factoryToken = vm.parseJsonAddress(json, ".factory.address");
        c.minHoldToPublish = vm.parseJsonUint(json, ".holdGates.minHoldToPublish");
        c.minHoldToClaim = vm.parseJsonUint(json, ".holdGates.minHoldToClaim");
        c.faucetTokenNames = vm.parseJsonStringArray(json, ".faucetTokens.names");
        c.faucetTokenSymbols = vm.parseJsonStringArray(json, ".faucetTokens.symbols");
        c.allowedTokens = vm.parseJsonAddressArray(json, ".allowedTokens");
        c.stackNames = vm.parseJsonStringArray(json, ".stacks.names");
        c.reviewWindows = vm.parseJsonUintArray(json, ".stacks.review");
        c.disputeWindows = vm.parseJsonUintArray(json, ".stacks.dispute");
        c.arbitrationWindows = vm.parseJsonUintArray(json, ".stacks.arbitration");
        c.margins = vm.parseJsonUintArray(json, ".stacks.margin");
    }

    /// @dev Runs from the caller's context: under `vm.startBroadcast(admin)` every CREATE and call is the admin's.
    function deploy(Config memory c) internal returns (Deployed memory d) {
        if (block.chainid != c.chainId) revert WrongChain(c.chainId, block.chainid);
        // The production configuration can have no faucet of any kind (R114-09).
        if (c.chainId == MAINNET && (c.factoryFaucet || c.faucetTokenSymbols.length > 0)) revert FaucetOnMainnet();
        uint256 n = c.stackNames.length;
        if (
            n == 0 || c.reviewWindows.length != n || c.disputeWindows.length != n || c.arbitrationWindows.length != n
                || c.margins.length != n || c.faucetTokenNames.length != c.faucetTokenSymbols.length
        ) revert BadConfig("array lengths");

        if (c.factoryToken != address(0)) {
            // An existing token is used as it is: no faucet, and it must be a contract on this chain.
            if (c.factoryFaucet) revert BadConfig("factory.address with a faucet");
            if (c.factoryToken.code.length == 0) revert BadConfig("factory.address has no code");
            d.factory = IERC20(c.factoryToken);
        } else {
            d.factory = IERC20(
                address(
                    new FactoryToken(
                        c.factoryFaucet ? "Factory (testnet)" : "Factory", "FACTORY", c.factoryFaucet, c.factoryMinter
                    )
                )
            );
        }

        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        d.core = ERC8183WithAuthorization(
            address(
                new ERC1967Proxy(address(impl), abi.encodeCall(ERC8183WithAuthorization.initialize, (c.admin, c.admin)))
            )
        );
        d.core.setPlatformFee(0, c.admin);
        d.core.setEvaluatorFee(0);

        d.rewardTokens = new address[](c.faucetTokenSymbols.length + c.allowedTokens.length);
        for (uint256 i; i < c.faucetTokenSymbols.length; ++i) {
            d.rewardTokens[i] = address(new MockPaymentToken(c.faucetTokenNames[i], c.faucetTokenSymbols[i]));
        }
        for (uint256 i; i < c.allowedTokens.length; ++i) {
            d.rewardTokens[c.faucetTokenSymbols.length + i] = c.allowedTokens[i];
        }
        for (uint256 i; i < d.rewardTokens.length; ++i) {
            d.core.setPaymentTokenAllowed(d.rewardTokens[i], true);
        }

        (d.holdings, d.evaluators) = deployStacks(c, d.core, d.factory);
    }

    /// @notice One `JobHolding` + `JobsEvaluator` pair per configured window set, against an existing core and bond
    ///         token, each evaluator with the attester registered as verifier. Used by `deploy` and, to replace the
    ///         pairs alone (the core, tokens and jobs stay), by `script/DeployStacks.s.sol`.
    function deployStacks(Config memory c, ERC8183WithAuthorization core, IERC20 factory)
        internal
        returns (JobHolding[] memory holdings, JobsEvaluator[] memory evaluators)
    {
        uint256 n = c.stackNames.length;
        holdings = new JobHolding[](n);
        evaluators = new JobsEvaluator[](n);
        for (uint256 i; i < n; ++i) {
            JobHolding holding = new JobHolding(core, factory, c.identity, c.minHoldToPublish, c.minHoldToClaim);
            JobsEvaluator evaluator = new JobsEvaluator(
                core,
                holding,
                c.reputation,
                c.arbitrator,
                uint48(c.reviewWindows[i]),
                uint48(c.disputeWindows[i]),
                uint48(c.arbitrationWindows[i]),
                uint48(c.margins[i])
            );
            holding.setEvaluator(address(evaluator));
            evaluator.setVerifier(c.attester, true);
            holdings[i] = holding;
            evaluators[i] = evaluator;
        }
    }

    /// @notice The CRE receiver for one evaluator, pinned to the KeystoneForwarder and our workflow's owner and name,
    ///         then ownerless so the checks can never be weakened; registered as that evaluator's verifier.
    function deployReceiver(
        JobsEvaluator evaluator,
        address forwarder,
        address workflowOwner,
        string memory workflowName
    ) internal returns (EvidenceReceiver receiver) {
        if (forwarder == address(0) || workflowOwner == address(0) || bytes(workflowName).length == 0) {
            revert BadConfig("receiver identity");
        }
        receiver = new EvidenceReceiver(evaluator, forwarder);
        receiver.setExpectedAuthor(workflowOwner);
        receiver.setExpectedWorkflowName(workflowName);
        receiver.renounceOwnership();
        evaluator.setVerifier(address(receiver), true);
    }
}

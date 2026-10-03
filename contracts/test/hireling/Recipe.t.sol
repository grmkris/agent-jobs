// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {IHirelingHolding} from "../../src/hireling/interfaces/IHirelingHolding.sol";
import {IStakeVault} from "../../src/hireling/interfaces/IStakeVault.sol";
import {IEpochDistributor} from "../../src/hireling/interfaces/IEpochDistributor.sol";
import {HirelingRecipe} from "../../script/HirelingRecipe.sol";
import {HirelingOutput} from "../../script/HirelingOutput.sol";
import {HirelingVerify} from "../../script/HirelingVerify.sol";
import {HirelingConstants} from "../../src/hireling/interfaces/HirelingConstants.sol";
import {HirelingHolding} from "../../src/hireling/HirelingHolding.sol";
import {StakeVault} from "../../src/hireling/StakeVault.sol";
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {MockReputation} from "../mocks/MockReputation.sol";
import {UnpromotedTestnet} from "../helpers/UnpromotedTestnet.sol";

/// @dev Calls the recipe's steps one at a time under the deployer, so the test can act as a third party between them.
contract RecipeDriver is Test {
    HirelingRecipe.Config internal c;
    HirelingRecipe.Deployed internal d;

    function configure(HirelingRecipe.Config memory c_) external {
        c = c_;
        HirelingRecipe.check(c);
    }

    function step(uint256 i) external {
        HirelingRecipe.Config memory cc = c;
        HirelingRecipe.Deployed memory dd = d;
        vm.startPrank(cc.admin);
        if (i == 0) HirelingRecipe.stepCore(cc, dd);
        if (i == 1) HirelingRecipe.stepVesting(cc, dd);
        if (i == 2) HirelingRecipe.stepFactory(cc, dd);
        if (i == 3) HirelingRecipe.stepFeeSchedule(cc, dd);
        if (i == 4) HirelingRecipe.stepVault(cc, dd);
        if (i == 5) HirelingRecipe.stepHolding(cc, dd);
        if (i == 6) HirelingRecipe.stepEvaluator(cc, dd);
        if (i == 7) HirelingRecipe.stepWire(cc, dd);
        if (i == 8) HirelingRecipe.stepBootstrap(dd);
        if (i == 9) HirelingRecipe.stepDistributor(dd);
        if (i == 10) HirelingRecipe.stepReserve(dd);
        if (i == 11) HirelingRecipe.stepFundReserve(dd);
        if (i == 12) HirelingRecipe.stepHandover(cc, dd);
        vm.stopPrank();
        d = dd;
    }

    function deployed() external view returns (HirelingRecipe.Deployed memory) {
        return d;
    }
}

contract RecipeTest is Test {
    address admin = makeAddr("deployer");
    address safe = makeAddr("safe");
    address ecosystem = makeAddr("ecosystem");
    address team = makeAddr("team");
    address attester = makeAddr("attester");
    address stranger = makeAddr("stranger");
    address arbitrator;
    uint256 arbitratorPk;
    RecipeDriver driver;
    HirelingRecipe.Config c;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(safe, hex"00"); // the Safe is a contract; the recipe and the promotion check it has code
        vm.createDir(HirelingOutput.candidateDir(vm), true); // gitignored: absent on a clean checkout
        (arbitrator, arbitratorPk) = makeAddrAndKey("arbiter");
        c.network = "local";
        c.chainId = block.chainid;
        c.admin = admin;
        c.attester = attester;
        c.identity = IERC8004Identity(address(new MockIdentity()));
        c.reputation = IERC8004Reputation(address(new MockReputation()));
        c.safe = safe;
        c.defaultArbitrator = arbitrator;
        c.margin = 1 days;
        c.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        c.bps = [uint16(3000), 1000, 300, 100];
        c.feeTreasury = safe;
        c.treasury = safe;
        c.ecosystem = ecosystem;
        c.liquidity = admin;
        c.vestingBeneficiary = team;
        c.vestingStartOffset = 365 days;
        c.vestingDuration = 3 * 365 days;
        c.vestingCliff = 0;
        driver = new RecipeDriver();
        driver.configure(c);
    }

    function _runWithThirdPartyBetweenSteps() internal returns (HirelingRecipe.Deployed memory d) {
        driver.step(0);
        driver.step(1);
        driver.step(2);
        d = driver.deployed();
        // Only genesis recipients hold FACTORY.
        assertEq(d.factory.balanceOf(stranger), 0);
        driver.step(3);
        driver.step(4);
        d = driver.deployed();
        // A FACTORY holder tries to stake ahead of the bootstrap; a donation lands but changes nothing.
        vm.startPrank(ecosystem);
        d.factory.approve(address(d.vault), 1);
        vm.expectRevert(IStakeVault.NotBootstrapped.selector);
        d.vault.stake(1);
        d.factory.transfer(address(d.vault), 1);
        vm.stopPrank();
        driver.step(5);
        d = driver.deployed();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.holding.setEvaluator(stranger);
        IHirelingHolding.PublishParams memory early;
        vm.prank(stranger);
        vm.expectRevert(IHirelingHolding.EvaluatorNotSet.selector);
        d.holding.publish(early);
        driver.step(6);
        d = driver.deployed();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.evaluator.setVerifier(stranger, true);
        driver.step(7);
        // Wired but not yet authorized in the vault: nothing can be published, even unbonded.
        _publishRefused(d);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.vault.bootstrapHolding(stranger);
        driver.step(8);
        driver.step(9);
        d = driver.deployed();
        vm.prank(ecosystem);
        d.factory.transfer(address(d.distributor), 1);
        driver.step(10);
        driver.step(11);
        driver.step(12);
        d = driver.deployed();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        d.vault.acceptOwnership();
    }

    function _publishRefused(HirelingRecipe.Deployed memory d) internal {
        MockPaymentToken usd = new MockPaymentToken("USD", "USD");
        usd.mint(stranger, 1e6);
        uint48 deadline = uint48(vm.getBlockTimestamp() + 7 days);
        IHirelingHolding.PublishParams memory p;
        (p.policyHash, p.token, p.reward, p.deliveryDeadline) =
        (keccak256("early"), IERC20(address(usd)), 1e6, deadline);
        (p.reviewWindow, p.disputeWindow, p.arbitrationWindow) = (1 hours, 1 hours, 12 hours);
        p.expiredAt = deadline + 1 hours + 1 hours + 12 hours + 1 days;
        vm.startPrank(stranger);
        usd.approve(address(d.holding), 1e6);
        vm.expectRevert(IStakeVault.NotHolding.selector);
        d.holding.publish(p);
        vm.stopPrank();
    }

    function _accept(HirelingRecipe.Deployed memory d) internal {
        vm.startPrank(safe);
        d.vault.acceptOwnership();
        d.fees.acceptOwnership();
        d.holding.acceptOwnership();
        d.evaluator.acceptOwnership();
        d.distributor.acceptOwnership();
        d.reserve.acceptOwnership();
        vm.stopPrank();
    }

    function test_recipe_stepsWithThirdPartyGaps_handoverAndAllocation() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        assertEq(d.vault.owner(), admin, "handover is not complete until the Safe accepts");
        assertEq(d.vault.pendingOwner(), safe);
        _accept(d);
        assertEq(d.vault.owner(), safe);
        assertEq(d.fees.owner(), safe);
        assertEq(d.holding.owner(), safe);
        assertEq(d.evaluator.owner(), safe);
        assertEq(d.distributor.owner(), safe);
        assertEq(d.reserve.owner(), safe);

        // A fresh core: the Safe holds both roles, the deployer none, fees 0 to the Safe.
        assertTrue(d.coreDeployed);
        assertTrue(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(d.core.hasRole(d.core.ADMIN_ROLE(), safe));
        assertFalse(d.core.hasRole(d.core.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(d.core.hasRole(d.core.ADMIN_ROLE(), admin));
        assertEq(d.core.platformFeeBP(), 0);
        assertEq(d.core.evaluatorFeeBP(), 0);
        bytes32 adminRole = d.core.ADMIN_ROLE();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, adminRole)
        );
        d.core.pause();

        // Genesis.
        assertEq(d.factory.totalSupply(), 1_000_000_000e18);
        assertEq(d.factory.balanceOf(address(d.reserve)), 500_000_000e18);
        assertEq(d.factory.balanceOf(safe), 200_000_000e18);
        assertEq(d.factory.balanceOf(address(d.vesting)), 150_000_000e18);
        assertEq(d.factory.balanceOf(ecosystem), 100_000_000e18 - 2, "minus the two test donations");
        assertEq(d.factory.balanceOf(admin), 50_000_000e18, "liquidity only; the mining share was forwarded");
        assertEq(d.vesting.owner(), team);
        assertEq(d.vesting.start(), d.t0 + 365 days);

        // Wiring.
        assertEq(d.holding.evaluator(), address(d.evaluator));
        assertTrue(d.evaluator.verifiers(attester));
        assertTrue(d.vault.isHolding(address(d.holding)));
        assertEq(d.holding.defaultArbitrator(), arbitrator);
        assertEq(d.fees.treasury(), safe);
        assertEq(d.fees.feeBps(10_000e18), 1000);
        assertEq(d.reserve.genesis(), d.t0);
        assertEq(d.distributor.genesis(), d.t0);
        assertEq(address(d.reserve.distributor()), address(d.distributor));
    }

    /// @dev The fresh deployment runs one hire end to end.
    function test_recipe_oneHire() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        _accept(d);
        (address creator, uint256 creatorPk) = makeAddrAndKey("creator");
        (address worker, uint256 workerPk) = makeAddrAndKey("worker");
        MockIdentity(address(c.identity)).setAgentWallet(7, worker);
        MockPaymentToken usd = new MockPaymentToken("USD", "USD");
        usd.mint(creator, 100e6);
        vm.prank(admin);
        d.factory.transfer(worker, 20_000e18);
        vm.startPrank(worker);
        d.factory.approve(address(d.vault), type(uint256).max);
        d.vault.stake(20_000e18);
        vm.stopPrank();

        uint48 deadline = uint48(vm.getBlockTimestamp() + 7 days);
        IHirelingHolding.PublishParams memory p = IHirelingHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256("m"),
            policyHash: keccak256("p"),
            token: IERC20(address(usd)),
            reward: 100e6,
            creatorBond: 0,
            workerBond: 10e18,
            deliveryDeadline: deadline,
            expiredAt: deadline + 1 days + 1 days + 1 days + 1 days,
            reviewWindow: 1 days,
            disputeWindow: 1 days,
            arbitrationWindow: 1 days
        });
        vm.startPrank(creator);
        usd.approve(address(d.holding), 100e6);
        uint256 jobId = d.holding.publish(p);
        vm.stopPrank();

        IHirelingHolding.Selection memory sel =
            IHirelingHolding.Selection(jobId, worker, 7, keccak256("p"), deadline - 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, d.holding.selectionDigest(sel));
        (, uint256 fee, uint256 net) = d.holding.quoteActivation(jobId, worker);
        assertEq(fee, 10e6, "20k staked: the 10 % tier");
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(d.core, workerPk, worker, jobId, address(usd), net);
        vm.prank(worker);
        d.holding.activate(sel, abi.encodePacked(r, s, v), auth);
        vm.prank(worker);
        d.core.submit(jobId, keccak256("work"), "");
        vm.prank(creator);
        d.evaluator.accept(jobId);
        d.holding.settle(jobId);
        assertEq(usd.balanceOf(worker), net);
        assertEq(usd.balanceOf(safe), fee);
        assertEq(d.vault.reservedOf(worker), 0);
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

    function test_recipe_checkRefusals() public {
        HirelingRecipe.Config memory bad = c;
        bad.safe = address(0);
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "zero address"));
        driver.configure(bad);
        bad = c;
        bad.reuseCore = true;
        bad.existingCore = stranger;
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "deployment.core has no code"));
        driver.configure(bad);
        bad = c;
        bad.chainId = 1;
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.WrongChain.selector, 1, block.chainid));
        driver.configure(bad);
        bad = c;
        bad.safe = makeAddr("no-code-safe");
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "safe has no code"));
        driver.configure(bad);
        bad = c;
        bad.thresholds[3] = 1_000_000e18;
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "threshold above supply"));
        driver.configure(bad);
        bad = c;
        bad.genesis = uint48(block.timestamp - 2 days);
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "genesis out of range"));
        driver.configure(bad);
        bad = c;
        bad.defaultArbitrator = admin;
        vm.expectRevert(
            abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "arbitrator must not be the deployer")
        );
        driver.configure(bad);
    }

    /// @dev LAUNCH-AUDIT-FIX-001: on chain 143 the v1 default arbitrator is `roles.arbitrator` and no retired 1 Oct key;
    ///      a fresh pair deploys a Holding whose default arbitrator is that role.
    function test_recipe_mainnetDefaultArbitratorIsTheFreshRole() public {
        vm.chainId(143);
        HirelingRecipe.Config memory m = c;
        m.chainId = 143;
        address fresh = makeAddr("fresh-arbiter");
        address[3] memory old = HirelingRecipe.retiredKeys();

        m.arbitrator = fresh;
        m.defaultArbitrator = makeAddr("another-fresh-arbiter");
        vm.expectRevert(
            abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "defaultArbitrator is not roles.arbitrator")
        );
        driver.configure(m);
        m.arbitrator = address(0); // a config without roles.arbitrator
        m.defaultArbitrator = fresh;
        vm.expectRevert(
            abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "defaultArbitrator is not roles.arbitrator")
        );
        driver.configure(m);
        for (uint256 i; i < 3; ++i) {
            m.arbitrator = fresh; // a rotated role, a stale default
            m.defaultArbitrator = old[i];
            vm.expectRevert(
                abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "defaultArbitrator is a retired 1 Oct key")
            );
            driver.configure(m);
            m.arbitrator = old[i]; // neither rotated
            vm.expectRevert(
                abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "defaultArbitrator is a retired 1 Oct key")
            );
            driver.configure(m);
        }

        m.arbitrator = fresh;
        m.defaultArbitrator = fresh;
        RecipeDriver mainnet = new RecipeDriver();
        mainnet.configure(m);
        for (uint256 i; i < 13; ++i) {
            mainnet.step(i);
        }
        assertEq(mainnet.deployed().holding.defaultArbitrator(), fresh);
    }

    /// @dev Off mainnet the default arbitrator is not tied to roles.arbitrator (testnet keeps its legacy roles).
    function test_recipe_testnetDefaultArbitratorIsFree() public {
        HirelingRecipe.Config memory t = c;
        t.arbitrator = makeAddr("some-role");
        driver.configure(t);
        t.defaultArbitrator = HirelingRecipe.retiredKeys()[2];
        driver.configure(t);
    }

    /// @dev The recipe's retired keys are the API preflight's RETIRED_ROLE_ADDRESSES, and there are three of each.
    function test_recipe_retiredKeysMatchTheApiDenylist() public view {
        string memory api = vm.readFile(string.concat(vm.projectRoot(), "/../apps/api/src/prod-config.ts"));
        uint256 start = vm.indexOf(api, "export const RETIRED_ROLE_ADDRESSES = [");
        uint256 end = vm.indexOf(api, "] as const");
        assertTrue(start < end && end != type(uint256).max, "no RETIRED_ROLE_ADDRESSES in prod-config.ts");
        bytes memory list = new bytes(end - start);
        for (uint256 i; i < list.length; ++i) {
            list[i] = bytes(api)[start + i];
        }
        string[] memory quoted = vm.split(string(list), "'");
        assertEq(quoted.length, 7, "prod-config.ts lists other than three retired keys");
        address[3] memory keys = HirelingRecipe.retiredKeys();
        for (uint256 i; i < 3; ++i) {
            assertEq(vm.parseAddress(quoted[2 * i + 1]), keys[i]);
        }
    }

    // ------------------------------------------------------------------------------------------
    // The D1 record
    // ------------------------------------------------------------------------------------------

    function _temp(string memory name, string memory json) internal returns (string memory path) {
        path = string.concat(vm.projectRoot(), "/config/.test-", name, ".json");
        vm.writeFile(path, json);
    }

    /// @dev The shipped mainnet config as an unpromoted record (`.deployment` reset to `{}`), so these tests hold before
    ///      and after the coordinator fills R2 and commits the real promotion (LAUNCH-AUDIT-FIX-002).
    function _mainnetTemp(string memory name) internal returns (string memory path) {
        path = _temp(name, vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json")));
        vm.writeJson("{}", path, ".deployment");
    }

    function test_output_testnetShape_movesMainAndDemoToLegacy() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        d.coreDeployed = false;
        string memory shipped = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory path = _temp("testnet", shipped);
        string memory real = UnpromotedTestnet.write(vm, path, shipped);
        HirelingOutput.write(vm, path, d, safe, 0, 123);
        string memory out = vm.readFile(path);
        vm.removeFile(path);

        address oldFactory = vm.parseJsonAddress(real, ".deployment.factory");
        assertEq(vm.parseJsonAddress(out, ".deployment.core"), vm.parseJsonAddress(real, ".deployment.core"));
        assertEq(vm.parseJsonUint(out, ".deployment.block"), vm.parseJsonUint(real, ".deployment.block"));
        assertEq(vm.parseJsonAddress(out, ".deployment.factory"), address(d.factory));
        assertEq(vm.parseJsonAddress(out, ".deployment.hireling.vault"), address(d.vault));
        assertEq(vm.parseJsonAddress(out, ".deployment.hireling.miningReserve"), address(d.reserve));
        assertEq(vm.parseJsonUint(out, ".deployment.hireling.t0"), d.t0);
        assertEq(vm.parseJsonUint(out, ".deployment.hireling.block"), 123);
        assertEq(vm.parseJsonAddress(out, ".deployment.hireling.safe"), safe, "D5");
        assertEq(vm.parseJsonString(out, ".deployment.main.kind"), "hireling-v1");
        assertEq(vm.parseJsonAddress(out, ".deployment.main.holding"), address(d.holding));
        assertTrue(vm.parseJsonBool(out, ".deployment.main.openTokens"));
        assertFalse(vm.keyExistsJson(out, ".deployment.demo"));
        assertEq(
            vm.parseJsonAddress(out, ".deployment.legacy.main-v3.holding"),
            vm.parseJsonAddress(real, ".deployment.main.holding")
        );
        assertTrue(vm.parseJsonBool(out, ".deployment.legacy.main-v3.openTokens"));
        assertEq(
            vm.parseJsonAddress(out, ".deployment.legacy.demo-v2.evaluator"),
            vm.parseJsonAddress(real, ".deployment.demo.evaluator")
        );
        assertFalse(vm.keyExistsJson(out, ".deployment.legacy.demo-v2.openTokens"));
        assertEq(vm.parseJsonString(out, ".deployment.legacy.main-v1.kind"), "legacy");
        assertEq(vm.parseJsonAddress(out, ".deployment.legacy.main-v1.factory"), oldFactory);
        assertEq(vm.parseJsonAddress(out, ".deployment.legacy.main-v3.factory"), oldFactory);
        assertEq(
            vm.parseJsonAddressArray(out, ".deployment.rewardTokens").length,
            vm.parseJsonAddressArray(real, ".deployment.rewardTokens").length
        );
        assertEq(
            vm.parseJsonAddress(out, ".deployment.poolFactory"), vm.parseJsonAddress(real, ".deployment.poolFactory")
        );
        // Inputs are untouched.
        assertEq(vm.parseJsonAddress(out, ".roles.admin"), vm.parseJsonAddress(real, ".roles.admin"));

        // A second v1 record is refused.
        path = _temp("testnet2", out);
        vm.expectRevert(HirelingOutput.AlreadyDeployed.selector);
        this.writeExternal(path, d);
        vm.removeFile(path);
    }

    function test_output_shippedPromotedTestnet_refusesAnotherDeployment() public {
        string memory shipped = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        if (!vm.keyExistsJson(shipped, ".deployment.hireling")) return vm.skip(true);
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _temp("testnet-promoted-guard", shipped);
        vm.expectRevert(HirelingOutput.AlreadyDeployed.selector);
        this.writeExternal(path, d);
        assertEq(vm.readFile(path), shipped, "guard preserves the promoted record");
        vm.removeFile(path);
    }

    function test_output_mainnetShape_noLegacy() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory path = _mainnetTemp("mainnet");
        HirelingOutput.write(vm, path, d, safe, 456, 457);
        string memory out = vm.readFile(path);
        vm.removeFile(path);
        assertEq(vm.parseJsonAddress(out, ".deployment.core"), address(d.core));
        assertEq(vm.parseJsonUint(out, ".deployment.block"), 456);
        assertEq(vm.parseJsonUint(out, ".deployment.hireling.block"), 457);
        assertEq(vm.parseJsonString(out, ".deployment.main.kind"), "hireling-v1");
        assertFalse(vm.keyExistsJson(out, ".deployment.legacy"));
        assertEq(vm.parseJsonString(out, ".deployment.network"), "monad-mainnet");
        // LAUNCH-AUDIT-004: an unpromoted config has knownTokens only; the record carries USDC as its reward token.
        address[] memory rewards = vm.parseJsonAddressArray(out, ".deployment.rewardTokens");
        assertEq(rewards.length, 1);
        assertEq(rewards[0], vm.parseJsonAddress(real, ".x402.usdc"));
        assertEq(rewards[0], vm.parseJsonAddressArray(real, ".knownTokens")[0]);
    }

    /// @dev LAUNCH-AUDIT-004: on mainnet a reward list without USDC, or no list and not exactly one known token, refuses
    ///      before anything is written; an explicit list with USDC is kept as it is.
    function test_output_mainnetRewardTokensKeepUsdc() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory usdc = vm.toString(vm.parseJsonAddress(real, ".x402.usdc"));

        string memory path = _mainnetTemp("rewards-no-usdc");
        vm.writeJson('{"rewardTokens":["0x0000000000000000000000000000000000000Bad"]}', path, ".deployment");
        vm.expectRevert(HirelingOutput.MainnetRewardTokens.selector);
        this.writeExternal(path, d);
        vm.removeFile(path);

        path = _mainnetTemp("rewards-two-known");
        vm.writeJson(string.concat('["', usdc, '","0x0000000000000000000000000000000000000Bad"]'), path, ".knownTokens");
        vm.expectRevert(HirelingOutput.MainnetRewardTokens.selector);
        this.writeExternal(path, d);
        vm.removeFile(path);

        path = _mainnetTemp("rewards-kept");
        vm.writeJson(
            string.concat('{"rewardTokens":["0x0000000000000000000000000000000000000Bad","', usdc, '"]}'),
            path,
            ".deployment"
        );
        this.writeExternal(path, d);
        address[] memory kept = vm.parseJsonAddressArray(vm.readFile(path), ".deployment.rewardTokens");
        vm.removeFile(path);
        assertEq(kept.length, 2);
        assertEq(vm.toString(kept[1]), usdc);
    }

    function test_output_refusesUnknownKeys() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _temp(
            "unknown",
            '{"network":"x","deployment":{"core":"0x0000000000000000000000000000000000000001","block":1,"surprise":1}}'
        );
        vm.expectRevert(abi.encodeWithSelector(HirelingOutput.UnknownKey.selector, "deployment", "surprise"));
        this.writeExternal(path, d);
        vm.removeFile(path);
    }

    /// @dev The `hireling` input block the coordinator writes (schema in SURFACE.md), parsed by `load`.
    function test_load_hirelingInputBlock() public {
        string memory base = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory block_ = string.concat(
            '{"reuseCore":true,"safe":"0x00000000000000000000000000000000000000a1",',
            '"defaultArbitrator":"0x00000000000000000000000000000000000000a2","margin":86400,',
            '"schedule":{"thresholds":[0,10000,100000,1000000],"bps":[3000,1000,300,100],',
            '"treasury":"0x00000000000000000000000000000000000000a1"},',
            '"allocation":{"treasury":"0x00000000000000000000000000000000000000a1",',
            '"ecosystem":"0x00000000000000000000000000000000000000a3","liquidity":"0x00000000000000000000000000000000000000a4"},',
            '"vesting":{"beneficiary":"0x00000000000000000000000000000000000000a5","startOffset":31536000,',
            '"duration":94608000,"cliff":0},"mining":{"genesis":0}}'
        );
        string memory path = string.concat(vm.projectRoot(), "/config/.test-load.json");
        vm.writeFile(path, base);
        vm.writeJson(block_, path, ".hireling");
        string memory name = ".test-load";
        HirelingRecipe.Config memory l = HirelingRecipe.load(vm, name);
        vm.removeFile(path);
        assertTrue(l.reuseCore);
        assertEq(l.existingCore, vm.parseJsonAddress(base, ".deployment.core"));
        assertEq(l.safe, address(0xa1));
        assertEq(l.defaultArbitrator, address(0xa2));
        assertEq(l.margin, 86400);
        assertEq(l.thresholds[3], 1_000_000);
        assertEq(l.bps[1], 1000);
        assertEq(l.feeTreasury, address(0xa1));
        assertEq(l.ecosystem, address(0xa3));
        assertEq(l.liquidity, address(0xa4));
        assertEq(l.vestingBeneficiary, address(0xa5));
        assertEq(l.vestingStartOffset, 365 days);
        assertEq(l.vestingDuration, 3 * 365 days);
        assertEq(l.genesis, 0);
        assertEq(l.admin, vm.parseJsonAddress(base, ".roles.admin"));
    }

    function guardExt(string memory json, bool sends) external view returns (uint256) {
        return HirelingRecipe.guardChain(vm, json, sends);
    }

    /// @dev Review C10-001: a testnet config on a mainnet RPC is refused before anything is sent or read; chain 143
    ///      needs MAINNET_GO=yes to send, judged by the connected chain; a read-only check needs only the match.
    function test_guardChain_rpcMustMatchTheConfig() public {
        string memory testnet = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory mainnet = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        vm.setEnv("MAINNET_GO", "");
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.WrongChain.selector, 10143, 143));
        this.guardExt(testnet, true);
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.WrongChain.selector, 10143, 143));
        this.guardExt(testnet, false);
        vm.expectRevert(HirelingRecipe.MainnetNotGo.selector);
        this.guardExt(mainnet, true);
        assertEq(this.guardExt(mainnet, false), 143);
        vm.setEnv("MAINNET_GO", "yes");
        assertEq(this.guardExt(mainnet, true), 143);
        vm.setEnv("MAINNET_GO", "");
        vm.chainId(10143);
        assertEq(this.guardExt(testnet, true), 10143);
        vm.expectRevert(abi.encodeWithSelector(HirelingRecipe.WrongChain.selector, 143, 10143));
        this.guardExt(mainnet, true);
    }

    function writeExternal(string memory path, HirelingRecipe.Deployed memory d) external {
        HirelingOutput.write(vm, path, d, safe, 1, 1);
    }

    // ------------------------------------------------------------------------------------------
    // Promotion (review C8-001): candidate, live verification, receipt blocks, idempotency
    // ------------------------------------------------------------------------------------------

    function verifyExternal(HirelingRecipe.Config memory cc, HirelingRecipe.Deployed memory d) external view {
        HirelingVerify.verify(cc, d);
    }

    function blocksExternal(string memory path, HirelingRecipe.Deployed memory d)
        external
        view
        returns (uint256, uint256)
    {
        return HirelingVerify.blocks(vm, path, d);
    }

    function _expectNotLive(HirelingRecipe.Config memory cc, HirelingRecipe.Deployed memory d, string memory what)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(HirelingVerify.NotLive.selector, what));
        this.verifyExternal(cc, d);
    }

    function test_promotion_candidateRoundTrip() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = string.concat(vm.projectRoot(), "/broadcast/hireling/.test.candidate.json");
        HirelingOutput.writeCandidate(vm, path, block.chainid, d, safe);
        (HirelingRecipe.Deployed memory r, address s, uint256 chainId) = HirelingOutput.readCandidate(vm, path);
        vm.removeFile(path);
        assertEq(chainId, block.chainid);
        assertEq(s, safe);
        assertEq(r.coreDeployed, d.coreDeployed);
        assertEq(r.t0, d.t0);
        assertEq(address(r.core), address(d.core));
        assertEq(address(r.vesting), address(d.vesting));
        assertEq(address(r.factory), address(d.factory));
        assertEq(address(r.fees), address(d.fees));
        assertEq(address(r.vault), address(d.vault));
        assertEq(address(r.holding), address(d.holding));
        assertEq(address(r.evaluator), address(d.evaluator));
        assertEq(address(r.distributor), address(d.distributor));
        assertEq(address(r.reserve), address(d.reserve));
    }

    /// @dev Pending and accepted handovers both verify; every gap the promotion must catch is refused.
    function test_promotion_verifyLiveState() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        this.verifyExternal(c, d);
        _accept(d);
        this.verifyExternal(c, d);

        HirelingRecipe.Deployed memory bad = driver.deployed(); // a fresh copy, not an alias of d
        bad.holding = HirelingHolding(stranger);
        _expectNotLive(c, bad, "holding code");

        HirelingRecipe.Config memory cc = c;
        cc.defaultArbitrator = stranger;
        _expectNotLive(cc, d, "holding.defaultArbitrator");

        // A deployer-key action in the handover window (review ACL-3) blocks promotion.
        vm.warp(d.reserve.epochEnd(0) + 1);
        vm.prank(safe);
        d.reserve.fund(0, 1);
        _expectNotLive(c, d, "reserve balance");
    }

    /// @dev Review C8-002: unsolicited dust to the reserve or the vesting wallet, before or after their allocation,
    ///      cannot block promotion; a short allocation still refuses.
    function test_promotion_dustDoesNotBlock_shortfallRefuses() public {
        driver.step(0);
        driver.step(1);
        HirelingRecipe.Deployed memory d = driver.deployed();
        // Dust to the vesting wallet before FACTORY exists is impossible; right after genesis, from a holder:
        driver.step(2);
        d = driver.deployed();
        vm.prank(ecosystem);
        d.factory.transfer(address(d.vesting), 1);
        for (uint256 i = 3; i < 11; ++i) {
            driver.step(i);
        }
        d = driver.deployed();
        // Dust to the reserve before its 500M arrives, then after.
        vm.prank(ecosystem);
        d.factory.transfer(address(d.reserve), 1);
        driver.step(11);
        driver.step(12);
        vm.prank(ecosystem);
        d.factory.transfer(address(d.reserve), 1);
        d = driver.deployed();
        this.verifyExternal(c, d);

        // A reserve below 500M (the allocation never fully arrived) refuses.
        HirelingRecipe.Deployed memory e = _runShortReserve();
        _expectNotLive(c, e, "reserve balance");
    }

    /// @dev A deployment whose reserve received 1 wei less than 500M (simulates a short allocation).
    function _runShortReserve() internal returns (HirelingRecipe.Deployed memory e) {
        RecipeDriver other = new RecipeDriver();
        other.configure(c);
        for (uint256 i; i < 13; ++i) {
            other.step(i);
        }
        e = other.deployed();
        // Move 1 wei out of the reserve's balance by rewriting it (no contract path can).
        bytes32 slot = keccak256(abi.encode(address(e.reserve), uint256(0)));
        uint256 bal = e.factory.balanceOf(address(e.reserve));
        vm.store(address(e.factory), slot, bytes32(bal - 1));
        require(e.factory.balanceOf(address(e.reserve)) == bal - 1, "balance slot");
    }

    function test_promotion_refusesAnIncompleteHandover() public {
        driver.step(0);
        for (uint256 i = 1; i < 12; ++i) {
            driver.step(i);
        }
        HirelingRecipe.Deployed memory d = driver.deployed();
        // Step 12 (handover) not sent: the deployer still holds the core roles and every owner.
        _expectNotLive(c, d, "core admin role: safe");
    }

    function test_promotion_receiptBlocks() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = string.concat(vm.projectRoot(), "/broadcast/hireling/.test-run.json");
        vm.writeFile(path, _runLog(d, "0x1", false));
        (uint256 coreBlock, uint256 hirelingBlock) = this.blocksExternal(path, d);
        assertEq(coreBlock, 0x101);
        assertEq(hirelingBlock, 0x100);

        vm.writeFile(path, _runLog(d, "0x0", false));
        vm.expectRevert(
            abi.encodeWithSelector(HirelingVerify.BadBroadcast.selector, "transaction without a successful receipt")
        );
        this.blocksExternal(path, d);

        vm.writeFile(path, _runLog(d, "0x1", true));
        vm.expectRevert(
            abi.encodeWithSelector(HirelingVerify.BadBroadcast.selector, "transaction without a successful receipt")
        );
        this.blocksExternal(path, d);
        vm.removeFile(path);
    }

    /// @dev A minimal forge run log: one CALL, then a CREATE for each deployed contract (the core proxy in block
    ///      0x101, the rest in 0x102); `dropLast` leaves the last transaction without a receipt.
    function _runLog(HirelingRecipe.Deployed memory d, string memory status, bool dropLast)
        internal
        view
        returns (string memory)
    {
        return _runLog(d, status, dropLast, HirelingConstants.FACTORY_SUPPLY);
    }

    /// @dev The Factory's creation receipt carries two genesis mints adding up to `minted`.
    function _runLog(HirelingRecipe.Deployed memory d, string memory status, bool dropLast, uint256 minted)
        internal
        view
        returns (string memory)
    {
        address[9] memory created = [
            address(d.core),
            address(d.vesting),
            address(d.factory),
            address(d.fees),
            address(d.vault),
            address(d.holding),
            address(d.evaluator),
            address(d.distributor),
            address(d.reserve)
        ];
        string memory txs = string.concat(
            '{"hash":"',
            vm.toString(bytes32(uint256(1000))),
            '","transactionType":"CALL","contractAddress":"',
            vm.toString(address(d.core)),
            '"}'
        );
        string memory receipts = string.concat(
            '{"transactionHash":"',
            vm.toString(bytes32(uint256(1000))),
            '","status":"',
            status,
            '","blockNumber":"0x100"}'
        );
        for (uint256 i; i < created.length; ++i) {
            string memory hash = vm.toString(bytes32(uint256(1001 + i)));
            txs = string.concat(
                txs,
                ',{"hash":"',
                hash,
                '","transactionType":"CREATE","contractAddress":"',
                vm.toString(created[i]),
                '"}'
            );
            if (dropLast && i == created.length - 1) continue;
            string memory logs = i == 2 ? _mintLogs(address(d.factory), minted) : "";
            receipts = string.concat(
                receipts,
                ',{"transactionHash":"',
                hash,
                '","status":"0x1","blockNumber":"',
                i == 0 ? "0x101" : "0x102",
                '","logs":[',
                logs,
                "]}"
            );
        }
        return string.concat('{"transactions":[', txs, '],"receipts":[', receipts, '],"pending":[]}');
    }

    function _mintLogs(address factory, uint256 minted) internal view returns (string memory) {
        string memory topic0 = vm.toString(keccak256("Transfer(address,address,uint256)"));
        string memory zero = vm.toString(bytes32(0));
        string memory one = vm.toString(bytes32(uint256(uint160(admin))));
        string memory a = vm.toString(abi.encode(minted / 2));
        string memory b = vm.toString(abi.encode(minted - minted / 2));
        return string.concat(
            '{"address":"',
            vm.toString(factory),
            '","topics":["',
            topic0,
            '","',
            zero,
            '","',
            one,
            '"],"data":"',
            a,
            '"},{"address":"',
            vm.toString(factory),
            '","topics":["',
            topic0,
            '","',
            zero,
            '","',
            one,
            '"],"data":"',
            b,
            '"}'
        );
    }

    /// @dev Review C8-002: a holder burning FACTORY before promotion cannot block it; a genesis that minted anything
    ///      but the 1e9 supply is refused.
    function test_promotion_supplyFromTheGenesisReceipt() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        vm.prank(ecosystem);
        d.factory.burn(1e18);
        this.verifyExternal(c, d);
        string memory path = string.concat(vm.projectRoot(), "/broadcast/hireling/.test-supply.json");
        vm.writeFile(path, _runLog(d, "0x1", false));
        this.blocksExternal(path, d);
        vm.writeFile(path, _runLog(d, "0x1", false, HirelingConstants.FACTORY_SUPPLY + 1));
        vm.expectRevert(
            abi.encodeWithSelector(HirelingVerify.BadBroadcast.selector, "factory genesis is not the 1e9 supply")
        );
        this.blocksExternal(path, d);
        vm.removeFile(path);
    }

    function test_promotion_isIdempotent() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory path = _mainnetTemp("promote");
        assertFalse(HirelingOutput.isPromoted(vm, vm.readFile(path), d, safe));
        HirelingOutput.write(vm, path, d, safe, 10, 11);
        string memory once = vm.readFile(path);
        assertTrue(HirelingOutput.isPromoted(vm, once, d, safe));
        HirelingRecipe.Deployed memory other = driver.deployed();
        other.vault = StakeVault(stranger);
        vm.expectRevert(HirelingOutput.AlreadyDeployed.selector);
        this.isPromotedExternal(once, other);
        vm.removeFile(path);
    }

    function isPromotedExternal(string memory json, HirelingRecipe.Deployed memory d) external view returns (bool) {
        return HirelingOutput.isPromoted(vm, json, d, safe);
    }
}

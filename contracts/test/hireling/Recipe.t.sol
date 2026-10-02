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
import {MockIdentity} from "../mocks/MockIdentity.sol";
import {MockReputation} from "../mocks/MockReputation.sol";

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
        bad.defaultArbitrator = admin;
        vm.expectRevert(
            abi.encodeWithSelector(HirelingRecipe.BadConfig.selector, "arbitrator must not be the deployer")
        );
        driver.configure(bad);
    }

    // ------------------------------------------------------------------------------------------
    // The D1 record
    // ------------------------------------------------------------------------------------------

    function _temp(string memory name, string memory json) internal returns (string memory path) {
        path = string.concat(vm.projectRoot(), "/config/.test-", name, ".json");
        vm.writeFile(path, json);
    }

    function test_output_testnetShape_movesMainAndDemoToLegacy() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        d.coreDeployed = false;
        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-testnet.json"));
        string memory path = _temp("testnet", real);
        HirelingOutput.write(vm, path, d, safe, 123);
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

    function test_output_mainnetShape_noLegacy() public {
        HirelingRecipe.Deployed memory d = _runWithThirdPartyBetweenSteps();
        string memory real = vm.readFile(string.concat(vm.projectRoot(), "/config/monad-mainnet.json"));
        string memory path = _temp("mainnet", real);
        HirelingOutput.write(vm, path, d, safe, 456);
        string memory out = vm.readFile(path);
        vm.removeFile(path);
        assertEq(vm.parseJsonAddress(out, ".deployment.core"), address(d.core));
        assertEq(vm.parseJsonUint(out, ".deployment.block"), 456);
        assertEq(vm.parseJsonString(out, ".deployment.main.kind"), "hireling-v1");
        assertFalse(vm.keyExistsJson(out, ".deployment.legacy"));
        assertEq(vm.parseJsonString(out, ".deployment.network"), "monad-mainnet");
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

    function writeExternal(string memory path, HirelingRecipe.Deployed memory d) external {
        HirelingOutput.write(vm, path, d, safe, 1);
    }
}

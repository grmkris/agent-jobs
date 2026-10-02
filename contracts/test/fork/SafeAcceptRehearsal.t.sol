// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HirelingRecipe} from "../../script/HirelingRecipe.sol";
import {HirelingOutput} from "../../script/HirelingOutput.sol";
import {HirelingSafeAccept, ISafe} from "../../script/SafeAccept.s.sol";
import {RecipeDriver} from "../hireling/Recipe.t.sol";

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

/// @dev C10 dry run on a local fork of Monad testnet (nothing is sent): the recipe runs with the live testnet Safe as
///      `safe`, the record is promoted into a scratch config, and one of the Safe's real owners accepts all six
///      handovers through `execTransaction` with a pre-validated signature. Skipped unless MONAD_TESTNET_RPC_URL is
///      set (the public RPC works).
contract SafeAcceptRehearsalForkTest is Test {
    address stranger = makeAddr("stranger");

    function acceptExt(ISafe safe, address[6] memory t, address sender) external returns (uint256) {
        return HirelingSafeAccept.accept(safe, t, sender);
    }

    function verifyExt(address safe, address[6] memory t) external view {
        HirelingSafeAccept.verify(safe, t);
    }

    function test_fork_testnet_safeAcceptsAllSix() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return vm.skip(true);
        vm.createSelectFork(rpc);
        string memory real = vm.readFile(HirelingRecipe.path(vm, "monad-testnet"));
        address safe = vm.parseJsonAddress(real, ".hireling.safe");
        assertGt(safe.code.length, 0, "the live testnet Safe");

        HirelingRecipe.Config memory c = HirelingRecipe.loadBase(vm, "monad-testnet");
        c.reuseCore = true;
        c.safe = safe;
        c.defaultArbitrator = makeAddr("arbiter");
        c.margin = 1 hours;
        c.thresholds = [uint256(0), 10_000, 100_000, 1_000_000];
        c.bps = [uint16(3000), 1000, 300, 100];
        c.feeTreasury = safe;
        c.treasury = safe;
        c.ecosystem = c.admin;
        c.liquidity = c.admin;
        c.vestingBeneficiary = makeAddr("team");
        c.vestingStartOffset = 365 days;
        c.vestingDuration = 3 * 365 days;
        RecipeDriver driver = new RecipeDriver();
        driver.configure(c);
        for (uint256 i; i < 13; ++i) {
            driver.step(i);
        }
        HirelingRecipe.Deployed memory d = driver.deployed();

        // The promoted record, as PromoteHireling writes it, in a scratch copy of the config.
        string memory path = string.concat(vm.projectRoot(), "/config/.test-safeaccept.json");
        vm.writeFile(path, real);
        HirelingOutput.write(vm, path, d, safe, 0, block.number);
        (address recorded, address[6] memory t) = HirelingSafeAccept.targets(vm, vm.readFile(path));
        vm.removeFile(path);
        assertEq(recorded, safe);
        assertEq(t[2], address(d.holding));
        assertEq(t[5], address(d.reserve));

        vm.expectRevert(abi.encodeWithSelector(HirelingSafeAccept.NotOwned.selector, t[0], c.admin));
        this.verifyExt(safe, t);
        vm.expectRevert(abi.encodeWithSelector(HirelingSafeAccept.NotSafeOwner.selector, stranger));
        this.acceptExt(ISafe(safe), t, stranger);

        address owner = ISafeOwners(safe).getOwners()[1];
        uint256 nonceBefore = ISafe(safe).nonce();
        vm.startPrank(owner, owner);
        uint256 accepted = HirelingSafeAccept.accept(ISafe(safe), t, owner);
        vm.stopPrank();
        assertEq(accepted, 6);
        assertEq(ISafe(safe).nonce(), nonceBefore + 6, "one Safe transaction per contract");
        HirelingSafeAccept.verify(safe, t);
        assertEq(d.vault.owner(), safe);
        assertEq(d.fees.owner(), safe);
        assertEq(d.holding.owner(), safe);
        assertEq(d.evaluator.owner(), safe);
        assertEq(d.distributor.owner(), safe);
        assertEq(d.reserve.owner(), safe);

        // Running it again sends nothing.
        vm.prank(owner, owner);
        assertEq(this.acceptExt(ISafe(safe), t, owner), 0);
    }
}

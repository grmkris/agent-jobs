// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";
import {Factory} from "../../src/sidequest/Factory.sol";
import {TeamVesting} from "../../src/sidequest/TeamVesting.sol";

contract FactoryTest is Test {
    uint256 constant SUPPLY = 1_000_000_000e18;

    address reserve = makeAddr("miningReserve");
    address treasury = makeAddr("treasury");
    address ecosystem = makeAddr("ecosystem");
    address liquidity = makeAddr("liquidity");
    address teamBeneficiary = makeAddr("team");
    TeamVesting vesting;
    Factory token;
    uint256 t0;

    function setUp() public {
        t0 = vm.getBlockTimestamp();
        vesting = new TeamVesting(teamBeneficiary, uint64(block.timestamp + 365 days), 3 * 365 days, 0);
        (address[] memory to, uint256[] memory amounts) = _allocation(address(vesting));
        token = new Factory("Factory", "SIDE", to, amounts);
    }

    function _allocation(address team) internal view returns (address[] memory to, uint256[] memory amounts) {
        to = new address[](5);
        amounts = new uint256[](5);
        (to[0], amounts[0]) = (reserve, 500_000_000e18);
        (to[1], amounts[1]) = (treasury, 200_000_000e18);
        (to[2], amounts[2]) = (team, 150_000_000e18);
        (to[3], amounts[3]) = (ecosystem, 100_000_000e18);
        (to[4], amounts[4]) = (liquidity, 50_000_000e18);
    }

    function test_genesis_supplyExactAndAllocated() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.balanceOf(reserve), 500_000_000e18);
        assertEq(token.balanceOf(treasury), 200_000_000e18);
        assertEq(token.balanceOf(address(vesting)), 150_000_000e18);
        assertEq(token.balanceOf(ecosystem), 100_000_000e18);
        assertEq(token.balanceOf(liquidity), 50_000_000e18);
        assertEq(token.symbol(), "SIDE");
    }

    function test_genesis_refusesShortSupply() public {
        (address[] memory to, uint256[] memory amounts) = _allocation(address(vesting));
        amounts[4] -= 1;
        vm.expectRevert(abi.encodeWithSelector(Factory.SupplyMismatch.selector, SUPPLY - 1, SUPPLY));
        new Factory("Factory", "SIDE", to, amounts);
    }

    function test_genesis_refusesExcessSupply() public {
        (address[] memory to, uint256[] memory amounts) = _allocation(address(vesting));
        amounts[0] += 1;
        vm.expectRevert(abi.encodeWithSelector(Factory.SupplyMismatch.selector, SUPPLY + 1, SUPPLY));
        new Factory("Factory", "SIDE", to, amounts);
    }

    function test_genesis_refusesLengthMismatchAndZeroRecipient() public {
        (address[] memory to, uint256[] memory amounts) = _allocation(address(vesting));
        address[] memory shortTo = new address[](4);
        for (uint256 i; i < 4; ++i) {
            shortTo[i] = to[i];
        }
        vm.expectRevert(Factory.LengthMismatch.selector);
        new Factory("Factory", "SIDE", shortTo, amounts);

        to[1] = address(0);
        vm.expectRevert(Factory.ZeroRecipient.selector);
        new Factory("Factory", "SIDE", to, amounts);
    }

    function testFuzz_genesis_anySplitSummingToSupply(uint256 a, uint256 b) public {
        a = bound(a, 0, SUPPLY);
        b = bound(b, 0, SUPPLY - a);
        address[] memory to = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        (to[0], amounts[0]) = (reserve, a);
        (to[1], amounts[1]) = (treasury, b);
        (to[2], amounts[2]) = (ecosystem, SUPPLY - a - b);
        Factory t = new Factory("Factory", "SIDE", to, amounts);
        assertEq(t.totalSupply(), SUPPLY);
    }

    /// @dev No owner and no mint: none of the usual selectors exist, and nothing raises the supply.
    function test_noMintNoOwner() public {
        bytes[] memory calls = new bytes[](5);
        calls[0] = abi.encodeWithSignature("mint(address,uint256)", address(this), 1);
        calls[1] = abi.encodeWithSignature("owner()");
        calls[2] = abi.encodeWithSignature("pause()");
        calls[3] = abi.encodeWithSignature("transferOwnership(address)", address(this));
        calls[4] = abi.encodeWithSignature("faucet()");
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = address(token).call(calls[i]);
            assertFalse(ok, "unexpected admin selector");
        }
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_burn_reducesSupply() public {
        vm.prank(treasury);
        token.burn(1_000e18);
        assertEq(token.totalSupply(), SUPPLY - 1_000e18);
        assertEq(token.balanceOf(treasury), 200_000_000e18 - 1_000e18);
    }

    function test_burnFrom_needsAllowance() public {
        address spender = makeAddr("spender");
        vm.prank(spender);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, 0, uint256(1e18))
        );
        token.burnFrom(treasury, 1e18);

        vm.prank(treasury);
        token.approve(spender, 1e18);
        vm.prank(spender);
        token.burnFrom(treasury, 1e18);
        assertEq(token.totalSupply(), SUPPLY - 1e18);
        assertEq(token.allowance(treasury, spender), 0);
    }

    function test_permit_setsAllowanceOnceAndExpires() public {
        (address owner, uint256 key) = makeAddrAndKey("permitOwner");
        address spender = makeAddr("relay");
        vm.prank(treasury);
        token.transfer(owner, 10e18);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(key, owner, spender, 10e18, 0, deadline);
        token.permit(owner, spender, 10e18, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), 10e18);
        assertEq(token.nonces(owner), 1);

        // Replay: the nonce moved on, so the same signature recovers a different signer.
        vm.expectRevert();
        token.permit(owner, spender, 10e18, deadline, v, r, s);

        (v, r, s) = _signPermit(key, owner, spender, 1, 1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, deadline));
        token.permit(owner, spender, 1, deadline, v, r, s);
    }

    function _signPermit(uint256 key, address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    // ---------------------------------------------------------------------------------------------
    // Team vesting (parameters from config)
    // ---------------------------------------------------------------------------------------------

    function test_vesting_defaultReading_nothingForAYearThenLinear() public {
        assertEq(vesting.owner(), teamBeneficiary);
        assertEq(vesting.releasable(address(token)), 0);

        vm.warp(t0 + 365 days - 1);
        assertEq(vesting.releasable(address(token)), 0);

        vm.warp(t0 + 365 days + (3 * 365 days) / 2);
        assertEq(vesting.releasable(address(token)), 75_000_000e18);
        vesting.release(address(token));
        assertEq(token.balanceOf(teamBeneficiary), 75_000_000e18);

        vm.warp(t0 + 4 * 365 days);
        vesting.release(address(token));
        assertEq(token.balanceOf(teamBeneficiary), 150_000_000e18);
    }

    function test_vesting_alternativeReading_quarterAtCliff() public {
        TeamVesting alt = new TeamVesting(teamBeneficiary, uint64(t0), 4 * 365 days, 365 days);
        vm.prank(address(vesting));
        token.transfer(address(alt), 150_000_000e18);

        vm.warp(t0 + 365 days - 1);
        assertEq(alt.releasable(address(token)), 0);
        vm.warp(t0 + 365 days);
        assertEq(alt.releasable(address(token)), 37_500_000e18);
    }

    function test_vesting_refusesCliffLongerThanDuration() public {
        vm.expectRevert(
            abi.encodeWithSelector(VestingWalletCliff.InvalidCliffDuration.selector, uint64(2 days), uint64(1 days))
        );
        new TeamVesting(teamBeneficiary, uint64(block.timestamp), 1 days, 2 days);
    }
}

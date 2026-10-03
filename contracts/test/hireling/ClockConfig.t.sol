// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HirelingRecipe} from "../../script/HirelingRecipe.sol";
import {HirelingClocks} from "../../src/hireling/HirelingClocks.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract ClockConfigTest is Test {
    string network;
    string path;

    function _scratch(string memory name) internal {
        network = string.concat(".test-clocks-input-", name);
        path = HirelingRecipe.path(vm, network);
        vm.writeFile(path, vm.readFile(HirelingRecipe.path(vm, "monad-testnet")));
    }

    function loadExternal() external view returns (HirelingRecipe.Config memory c) {
        c = HirelingRecipe.load(vm, network);
        HirelingClocks.validate(c.clocks);
    }

    function test_loadApprovedFastClocks() public {
        _scratch("fast");
        vm.chainId(10143);
        HirelingRecipe.Config memory c = this.loadExternal();
        assertEq(
            keccak256(abi.encode(c.clocks)),
            keccak256(abi.encode(HirelingClocks.Config(120, 120, 300, 600, 900, 300, 1800, 1800, 3600)))
        );
        vm.removeFile(path);
    }

    function test_loadPartialAndNullBlockRefuse() public {
        _scratch("partial");
        vm.writeJson('{"minReviewWindow":120}', path, ".hireling.clocks");
        vm.expectRevert();
        this.loadExternal();
        vm.writeJson("null", path, ".hireling.clocks");
        vm.expectRevert();
        this.loadExternal();
        vm.removeFile(path);
    }

    function test_loadOverflowCannotWrap() public {
        _scratch("overflow");
        vm.writeJson("4294967296", path, ".hireling.clocks.minReviewWindow");
        vm.expectRevert(
            abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, uint8(32), uint256(4294967296))
        );
        this.loadExternal();
        vm.writeJson("120", path, ".hireling.clocks.minReviewWindow");
        vm.writeJson("281474976710656", path, ".hireling.clocks.unstakeDelay");
        vm.expectRevert(
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector, uint8(48), uint256(281474976710656)
            )
        );
        this.loadExternal();
        vm.removeFile(path);
    }

    function test_143_fastBlockRefusesProductionBlockPasses() public {
        _scratch("mainnet");
        vm.chainId(143);
        vm.expectRevert(
            abi.encodeWithSelector(HirelingClocks.InvalidClock.selector, bytes32("minReviewWindow"), uint256(120))
        );
        this.loadExternal();
        vm.writeJson(
            '{"minReviewWindow":3600,"minDisputeWindow":3600,"minArbitrationWindow":43200,"unstakeDelay":604800,"holdingDelay":691200,"feeDelay":259200,"proposalGrace":604800,"epochZeroDuration":259200,"epochDuration":604800}',
            path,
            ".hireling.clocks"
        );
        this.loadExternal();
        vm.removeFile(path);
    }
}

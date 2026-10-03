// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SeedPoolRecipe} from "../../script/SeedPoolRecipe.sol";

contract SeedPoolMathTest is Test {
    function _config(bool factoryFirst) internal pure returns (SeedPoolRecipe.Config memory c) {
        c.factory = IERC20(factoryFirst ? address(1) : address(2));
        c.quote = IERC20(factoryFirst ? address(2) : address(1));
        c.factoryAmount = 1e18;
        c.quoteAmount = 3e6;
        c.maxRepairCost = 2e6;
        c.fee = 3000;
        c.tickSpacing = 60;
    }

    /// @dev The same plan is used by mainnet SeedPool. Rounding must retain fractional whole FACTORY tokens.
    function test_fractionalRepairCap_factoryFirst() public pure {
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(_config(true));
        assertEq(p.repairMax0, 666666666666666666);
        assertEq(p.amount0 + p.repairMax0, 1666666666666666666);
        assertEq(p.amount1 + p.repairMax1, 5e6);
    }

    function test_fractionalRepairCap_quoteFirst() public pure {
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(_config(false));
        assertEq(p.repairMax1, 666666666666666666);
        assertEq(p.amount1 + p.repairMax1, 1666666666666666666);
        assertEq(p.amount0 + p.repairMax0, 5e6);
    }

    function test_committedTestnetRatio_requiresTwentyThousandFactory() public pure {
        SeedPoolRecipe.Config memory c = _config(true);
        c.factoryAmount = 10_000e18;
        c.quoteAmount = 1e6;
        c.maxRepairCost = 1e6;
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        assertEq(p.amount0 + p.repairMax0, 20_000e18);
        assertEq(p.amount1 + p.repairMax1, 2e6);
    }

    function testFuzz_repairCapRoundsOnlyAtTheRawUnit(uint256 factory, uint256 quote, uint256 repair, bool first)
        public
        pure
    {
        SeedPoolRecipe.Config memory c = _config(first);
        c.factoryAmount = bound(factory, 1, 500_000) * 1e18;
        c.quoteAmount = bound(quote, 1, 10) * 1e6;
        c.maxRepairCost = bound(repair, 1, c.quoteAmount / 1e6) * 1e6;
        SeedPoolRecipe.Plan memory p = SeedPoolRecipe.plan(c);
        uint256 cap = first ? p.repairMax0 : p.repairMax1;
        uint256 value = c.maxRepairCost * c.factoryAmount;
        assertLe(cap * c.quoteAmount, value);
        assertGt((cap + 1) * c.quoteAmount, value, "less than one raw FACTORY unit may be truncated");
    }
}

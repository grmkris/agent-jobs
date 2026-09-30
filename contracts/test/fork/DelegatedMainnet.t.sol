pragma solidity ^0.8.28;

import {MainnetRehearsalForkTest} from "./MainnetRehearsal.t.sol";
import {Refusing1271} from "../Signatures.t.sol";

contract DelegatedMainnetForkTest is MainnetRehearsalForkTest {
    function setUp() public override {
        super.setUp();
        if (!forked) return;
        Refusing1271 implementation = new Refusing1271();
        vm.attachDelegation(vm.signDelegation(address(implementation), creatorPk));
        vm.attachDelegation(vm.signDelegation(address(implementation), workerPk));
        vm.attachDelegation(vm.signDelegation(address(implementation), arbitratorPk));
        assertEq(block.chainid, 143);
        assertGt(creator.code.length, 0);
        assertGt(worker.code.length, 0);
        assertGt(c.arbitrator.code.length, 0);
    }
}

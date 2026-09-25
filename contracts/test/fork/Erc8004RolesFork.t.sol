// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";

/// @dev Spike S6 on the live registries: an agent declares roles in its metadata, a project certifies one of
///      them through feedback, and the board's gate (packages/board `roleGate`) reads exactly these two facts.
///      Runs only with MONAD_TESTNET_RPC set.
contract Erc8004RolesForkTest is Test {
    IERC8004Identity internal constant IDENTITY = IERC8004Identity(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IERC8004Reputation internal constant REPUTATION =
        IERC8004Reputation(0x8004B663056A597Dffe9eCcC1965A193B7388713);
    string internal constant ROLES_KEY = "agent-jobs.roles";

    address internal worker = makeAddr("worker");
    address internal projectController = makeAddr("project");
    address internal otherProject = makeAddr("other-project");
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_agentDeclaresRoles_onlyOwnerMaySet() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();
        vm.prank(worker);
        IDENTITY.setMetadata(agentId, ROLES_KEY, bytes("developer,security-reviewer"));
        assertEq(string(IDENTITY.getMetadata(agentId, ROLES_KEY)), "developer,security-reviewer");

        vm.prank(projectController);
        vm.expectRevert(bytes("Not authorized"));
        IDENTITY.setMetadata(agentId, ROLES_KEY, bytes("admin"));
    }

    function test_projectCertifiesARole_readableByTag() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();

        vm.prank(projectController);
        REPUTATION.giveFeedback(agentId, 1, 0, "role", "security-reviewer", "", "", bytes32(0));

        address[] memory fromProject = new address[](1);
        fromProject[0] = projectController;
        (uint64 count,,) = REPUTATION.getSummary(agentId, fromProject, "role", "security-reviewer");
        assertEq(count, 1, "the project's certification is visible under its own address and tag");

        address[] memory fromOther = new address[](1);
        fromOther[0] = otherProject;
        (uint64 none,,) = REPUTATION.getSummary(agentId, fromOther, "role", "security-reviewer");
        assertEq(none, 0, "another project has certified nothing");

        (uint64 wrongRole,,) = REPUTATION.getSummary(agentId, fromProject, "role", "developer");
        assertEq(wrongRole, 0, "certification is per role name");
    }

    function test_agentCannotCertifyItself() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();
        vm.prank(worker);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        REPUTATION.giveFeedback(agentId, 1, 0, "role", "developer", "", "", bytes32(0));
    }
}

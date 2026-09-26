// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183} from "../../src/vendor/erc8183/ERC8183.sol";
import {ERC8183WithAuthorization} from "../../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity, IERC8004Reputation} from "../../src/vendor/erc8004/IERC8004.sol";
import {FactoryToken} from "../../src/FactoryToken.sol";
import {MockPaymentToken} from "../../src/MockPaymentToken.sol";
import {JobHolding} from "../../src/JobHolding.sol";
import {JobsEvaluator} from "../../src/JobsEvaluator.sol";

/// @dev The admission check against the real ERC-8004 Identity Registry on Monad testnet (a local fork; nothing is
///      sent): a registered agent's wallet activates a hire or wins a contest award, an unregistered or foreign agent
///      id is refused, and each settlement writes feedback to the real Reputation Registry. Skipped unless MONAD_TESTNET_RPC_URL is set.
contract AdmissionForkTest is Test {
    IERC8004Identity internal constant IDENTITY = IERC8004Identity(0x8004A818BFB912233c491871b3d84c89A494BD9e);
    IERC8004Reputation internal constant REPUTATION =
        IERC8004Reputation(0x8004B663056A597Dffe9eCcC1965A193B7388713);
    uint256 internal constant REWARD = 100e6;

    bool internal forked;
    address internal creator;
    uint256 internal creatorPk;
    address internal worker;
    uint256 internal workerPk;
    address internal arbitrator = makeAddr("arbitrator");

    ERC8183WithAuthorization internal core;
    FactoryToken internal factory;
    MockPaymentToken internal pay;
    JobHolding internal holding;
    JobsEvaluator internal evaluator;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        (creator, creatorPk) = makeAddrAndKey("fork-creator");
        (worker, workerPk) = makeAddrAndKey("fork-worker");

        factory = new FactoryToken();
        pay = new MockPaymentToken();
        ERC8183WithAuthorization impl = new ERC8183WithAuthorization();
        core = ERC8183WithAuthorization(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeCall(ERC8183WithAuthorization.initialize, (address(this), address(this)))
                )
            )
        );
        core.setPaymentTokenAllowed(address(pay), true);
        holding = new JobHolding(core, factory, IDENTITY, 0, 0);
        evaluator = new JobsEvaluator(core, holding, REPUTATION, arbitrator, 3 days, 3 days, 7 days, 1 days);
        holding.setEvaluator(address(evaluator));

        pay.mint(creator, REWARD);
        vm.prank(creator);
        pay.approve(address(holding), REWARD);
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _publish() internal returns (uint256 jobId) {
        uint48 dd = uint48(block.timestamp + 7 days);
        JobHolding.PublishParams memory p = JobHolding.PublishParams({
            approver: address(0),
            manifestHash: keccak256("fork-manifest"),
            policyHash: keccak256(abi.encode("fork-policy", block.timestamp)),
            token: IERC20(address(pay)),
            reward: REWARD,
            creatorBond: 0,
            workerBond: 0,
            deliveryDeadline: dd,
            expiredAt: dd + evaluator.settlementWindow(),
            mode: JobHolding.Mode.HireFirst,
            selectionDeadline: 0
        });
        vm.prank(creator);
        jobId = holding.publish(p);
    }

    function _args(uint256 jobId, uint256 agentId)
        internal
        view
        returns (JobHolding.Selection memory sel, bytes memory sig, ERC8183WithAuthorization.Authorization memory auth)
    {
        sel = JobHolding.Selection({
            jobId: jobId,
            worker: worker,
            agentId: agentId,
            termsHash: holding.policyHashOf(jobId),
            activateBy: holding.deliveryDeadlineOf(jobId) - 1,
            nonce: jobId
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, holding.selectionDigest(sel));
        sig = abi.encodePacked(r, s, v);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                core.SET_BUDGET_AUTHORIZATION_TYPEHASH(),
                worker,
                jobId,
                address(pay),
                REWARD,
                keccak256(""),
                uint72(jobId),
                deadline
            )
        );
        (v, r, s) = vm.sign(workerPk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        auth = ERC8183WithAuthorization.Authorization(worker, uint72(jobId), deadline, abi.encodePacked(r, s, v));
    }

    function test_fork_registeredAgentWalletActivatesAndSettles() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();
        assertEq(IDENTITY.getAgentWallet(agentId), worker);

        uint256 jobId = _publish();
        (JobHolding.Selection memory sel, bytes memory sig, ERC8183WithAuthorization.Authorization memory auth) =
            _args(jobId, agentId);
        vm.prank(worker);
        holding.activate(sel, sig, auth);
        assertEq(uint256(core.getJob(jobId).status), uint256(ERC8183.JobStatus.Funded));

        vm.prank(worker);
        core.submit(jobId, keccak256("deliverable"), "");
        vm.prank(creator);
        evaluator.accept(jobId);
        assertEq(pay.balanceOf(worker), REWARD);
        (int128 value,,, string memory tag2,) = REPUTATION.readFeedback(agentId, address(evaluator), 1);
        assertEq(value, 1);
        assertEq(tag2, "completed");
    }

    function _coreSig(bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(workerPk, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_fork_awardPaysTheRegisteredEntrant() public onFork {
        vm.prank(worker);
        uint256 agentId = IDENTITY.register();
        uint48 sd = uint48(block.timestamp + 2 days);
        uint48 dd = uint48(block.timestamp + 7 days);
        JobHolding.PublishParams memory p = JobHolding.PublishParams({
            approver: address(0),
            manifestHash: keccak256("fork-contest"),
            policyHash: keccak256(abi.encode("fork-contest-policy", block.timestamp)),
            token: IERC20(address(pay)),
            reward: REWARD,
            creatorBond: 0,
            workerBond: 0,
            deliveryDeadline: dd,
            expiredAt: dd + evaluator.settlementWindow(),
            mode: JobHolding.Mode.Contest,
            selectionDeadline: sd
        });
        vm.prank(creator);
        uint256 jobId = holding.publish(p);

        bytes32 deliverable = keccak256("fork-entry");
        JobHolding.Candidate memory c;
        c.worker = worker;
        c.agentId = agentId;
        c.deliverable = deliverable;
        c.budgetAuth = ERC8183WithAuthorization.Authorization(
            worker,
            1,
            sd,
            _coreSig(
                keccak256(
                    abi.encode(
                        core.SET_BUDGET_AUTHORIZATION_TYPEHASH(), worker, jobId, address(pay), REWARD, keccak256(""), 1, sd
                    )
                )
            )
        );
        c.submitAuth = ERC8183WithAuthorization.Authorization(
            worker,
            2,
            sd,
            _coreSig(
                keccak256(abi.encode(core.SUBMIT_AUTHORIZATION_TYPEHASH(), worker, jobId, deliverable, keccak256(""), 2, sd))
            )
        );
        vm.prank(creator);
        holding.award(jobId, c);
        assertEq(uint256(core.getJob(jobId).status), uint256(ERC8183.JobStatus.Completed));
        assertEq(pay.balanceOf(worker), REWARD);
        (int128 value,,,,) = REPUTATION.readFeedback(agentId, address(evaluator), 1);
        assertEq(value, 1);
    }

    function test_fork_foreignAgentIdRefused() public onFork {
        address other = makeAddr("fork-other");
        vm.prank(other);
        uint256 foreign = IDENTITY.register();
        uint256 jobId = _publish();
        (JobHolding.Selection memory sel, bytes memory sig, ERC8183WithAuthorization.Authorization memory auth) =
            _args(jobId, foreign);
        vm.prank(worker);
        vm.expectRevert(JobHolding.NotAgentWallet.selector);
        holding.activate(sel, sig, auth);
    }

    function test_fork_unregisteredAgentIdRefused() public onFork {
        uint256 jobId = _publish();
        (JobHolding.Selection memory sel, bytes memory sig, ERC8183WithAuthorization.Authorization memory auth) =
            _args(jobId, type(uint128).max);
        vm.prank(worker);
        vm.expectRevert();
        holding.activate(sel, sig, auth);
    }
}

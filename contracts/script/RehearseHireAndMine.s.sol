// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183WithAuthorization} from "../src/vendor/erc8183/ERC8183WithAuthorization.sol";
import {IERC8004Identity} from "../src/vendor/erc8004/IERC8004.sol";
import {IHirelingHolding} from "../src/hireling/interfaces/IHirelingHolding.sol";
import {IHirelingEvaluator} from "../src/hireling/interfaces/IHirelingEvaluator.sol";
import {IStakeVault} from "../src/hireling/interfaces/IStakeVault.sol";
import {IMiningReserve} from "../src/hireling/interfaces/IMiningReserve.sol";
import {IEpochDistributor} from "../src/hireling/interfaces/IEpochDistributor.sol";
import {HirelingRecipe} from "./HirelingRecipe.sol";
import {ISafe} from "./HirelingSafeAccept.sol";

/// @dev Safe v1.4.1's SafeTx hash, which an owner's ECDSA signature commits to (nonce included).
interface ISafeTxHash {
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
}

/// @dev Launch rehearsal only (R7, `script/rehearse-launch.sh`): runs against a scratch `config/rehearsal-*.json` on a
///      local anvil fork, with throwaway keys passed in the environment. Refuses any other config name.
abstract contract RehearsalScript is Script {
    string internal json;

    function _load() internal {
        string memory network = vm.envString("NETWORK");
        bytes memory n = bytes(network);
        require(
            n.length > 10 && keccak256(bytes(vm.split(network, "-")[0])) == keccak256("rehearsal"),
            "rehearsal configs only (config/rehearsal-*.json)"
        );
        json = vm.readFile(HirelingRecipe.path(vm, network));
        HirelingRecipe.guardChain(vm, json, true);
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }
}

/// @notice One direct hire through the v1 pair: the worker registers and stakes, the creator publishes in USDC and
///         signs the selection, the worker activates and submits, the creator accepts, anyone settles.
///         Keys: DEPLOYER_KEY (holds FACTORY and USDC), CREATOR_KEY, WORKER_KEY.
contract RehearseHire is RehearsalScript {
    function run() external {
        _load();
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        uint256 creatorKey = vm.envUint("CREATOR_KEY");
        uint256 workerKey = vm.envUint("WORKER_KEY");
        address creator = vm.addr(creatorKey);
        address worker = vm.addr(workerKey);
        IHirelingHolding holding = IHirelingHolding(_addr(".deployment.main.holding"));
        IHirelingEvaluator evaluator = IHirelingEvaluator(_addr(".deployment.main.evaluator"));
        ERC8183WithAuthorization core = ERC8183WithAuthorization(_addr(".deployment.core"));
        IStakeVault vault = IStakeVault(_addr(".deployment.hireling.vault"));
        IERC20 factory = IERC20(_addr(".deployment.hireling.factory"));
        IERC20 usdc = IERC20(_addr(".liquidity.quote"));
        IERC8004Identity identity = IERC8004Identity(_addr(".erc8004.identity"));
        uint256 reward = 25e6;

        vm.startBroadcast(deployerKey);
        factory.transfer(worker, 20_000e18);
        usdc.transfer(creator, reward);
        vm.stopBroadcast();

        vm.startBroadcast(workerKey);
        uint256 agentId = identity.register();
        factory.approve(address(vault), 20_000e18);
        vault.stake(20_000e18);
        vm.stopBroadcast();

        uint48 deadline = uint48(block.timestamp + 2 days);
        bytes32 policy = keccak256(abi.encode("rehearsal-policy", block.timestamp));
        IHirelingHolding.PublishParams memory p = IHirelingHolding.PublishParams({
            approver: address(0),
            arbitrator: address(0),
            manifestHash: keccak256("rehearsal-manifest"),
            policyHash: policy,
            token: usdc,
            reward: reward,
            creatorBond: 0,
            workerBond: 10e18,
            deliveryDeadline: deadline,
            expiredAt: deadline + 1 hours + 1 hours + 12 hours + 1 days,
            reviewWindow: 1 hours,
            disputeWindow: 1 hours,
            arbitrationWindow: 12 hours
        });
        vm.startBroadcast(creatorKey);
        usdc.approve(address(holding), reward);
        uint256 jobId = holding.publish(p);
        vm.stopBroadcast();

        IHirelingHolding.Selection memory sel =
            IHirelingHolding.Selection(jobId, worker, agentId, policy, deadline - 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorKey, holding.selectionDigest(sel));
        bytes memory creatorSig = abi.encodePacked(r, s, v);
        (, uint256 fee, uint256 net) = holding.quoteActivation(jobId, worker);
        ERC8183WithAuthorization.Authorization memory auth =
            _budgetAuth(core, workerKey, worker, jobId, address(usdc), net);

        vm.startBroadcast(workerKey);
        holding.activate(sel, creatorSig, auth);
        core.submit(jobId, keccak256("rehearsal-work"), "");
        vm.stopBroadcast();

        vm.startBroadcast(creatorKey);
        evaluator.accept{gas: 1_200_000}(jobId);
        holding.settle{gas: 1_000_000}(jobId);
        vm.stopBroadcast();

        console2.log("job", jobId);
        console2.log("agentId", agentId);
        console2.log("fee to treasury", fee);
        console2.log("net to worker", net);
    }

    function _budgetAuth(
        ERC8183WithAuthorization core,
        uint256 key,
        address signer,
        uint256 jobId,
        address token,
        uint256 amount
    ) internal view returns (ERC8183WithAuthorization.Authorization memory) {
        uint256 deadline = block.timestamp + 1 hours;
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
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", core.DOMAIN_SEPARATOR(), structHash)));
        return ERC8183WithAuthorization.Authorization(signer, 1, deadline, abi.encodePacked(r, s, v));
    }
}

/// @notice Mining after epoch 0 has ended, from the B8 tool's output (`scripts/mining`, `epoch-0.json`): the Safe sends
///         the tool's own `fund` and `setRoot` calldata, then the worker's and the creator's claims, with the tool's
///         proofs, stake their rewards into the vault. Keys: SAFE_OWNER_KEY (a threshold-1 Safe owner), WORKER_KEY,
///         CREATOR_KEY. From the epoch JSON: FUND_DATA, SETROOT_DATA, WORKER_AMOUNT/WORKER_PROOF and
///         CREATOR_AMOUNT/CREATOR_PROOF (proofs comma-separated).
contract RehearseMining is RehearsalScript {
    function run() external {
        _load();
        uint256 ownerKey = vm.envUint("SAFE_OWNER_KEY");
        ISafe safe = ISafe(_addr(".deployment.hireling.safe"));
        IMiningReserve reserve = IMiningReserve(_addr(".deployment.hireling.miningReserve"));
        IEpochDistributor distributor = IEpochDistributor(_addr(".deployment.hireling.distributor"));
        IStakeVault vault = IStakeVault(_addr(".deployment.hireling.vault"));
        require(block.timestamp >= reserve.epochEnd(0), "epoch 0 has not ended; warp first");
        address worker = vm.addr(vm.envUint("WORKER_KEY"));
        address creator = vm.addr(vm.envUint("CREATOR_KEY"));
        uint256 workerAmount = vm.envUint("WORKER_AMOUNT");
        uint256 creatorAmount = vm.envUint("CREATOR_AMOUNT");
        uint256 workerBefore = vault.stakeOf(worker);
        uint256 creatorBefore = vault.stakeOf(creator);

        // D18, as /admin sends it: fund is additive, so it goes out with an owner's ECDSA signature of the SafeTx at the
        // Safe nonce read together with totalFunded, and only while totalFunded is still what mining:epoch read
        // (calls.fund.expect). Never a pre-validated (v = 1) signature: that binds no nonce. setRoot stays pre-validated.
        bytes memory fundData = vm.envBytes("FUND_DATA");
        uint256 nonce = safe.nonce();
        require(
            reserve.totalFunded() == vm.envUint("FUND_EXPECT_TOTAL"), "totalFunded moved since mining:epoch; rerun it"
        );
        bytes32 fundHash = ISafeTxHash(address(safe))
            .getTransactionHash(address(reserve), 0, fundData, 0, 0, 0, 0, address(0), address(0), nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, fundHash);
        bytes memory fundSig = abi.encodePacked(r, s, v);

        vm.startBroadcast(ownerKey);
        require(
            safe.execTransaction(address(reserve), 0, fundData, 0, 0, 0, 0, address(0), payable(address(0)), fundSig),
            "fund"
        );
        _exec(safe, vm.addr(ownerKey), address(distributor), vm.envBytes("SETROOT_DATA"));
        // Claims are permissionless and stake for the leaf's account; the owner sends both.
        distributor.claim(0, worker, workerAmount, vm.envBytes32("WORKER_PROOF", ","));
        distributor.claim(0, creator, creatorAmount, vm.envBytes32("CREATOR_PROOF", ","));
        vm.stopBroadcast();

        // A second funding signed for that same nonce (a stale draft or a retry) now reverts with GS026 and moves
        // nothing: the nonce it commits to is spent. Simulated only, never sent.
        uint256 fundedAfter = reserve.totalFunded();
        (bool again, bytes memory reason) = address(safe)
            .call(
                abi.encodeCall(
                    ISafe.execTransaction,
                    (address(reserve), 0, fundData, 0, 0, 0, 0, address(0), payable(address(0)), fundSig)
                )
            );
        require(!again, "a second fund at the spent Safe nonce executed");
        require(keccak256(reason) == keccak256(abi.encodeWithSignature("Error(string)", "GS026")), "not GS026");
        require(reserve.totalFunded() == fundedAfter, "the second fund moved totalFunded");
        console2.log("D18: fund was ECDSA-signed at Safe nonce", nonce, "; the same signature again reverts GS026");

        require(vault.stakeOf(worker) == workerBefore + workerAmount, "worker claim did not stake");
        require(vault.stakeOf(creator) == creatorBefore + creatorAmount, "creator claim did not stake");
        console2.log("claimed and staked: worker", workerAmount, "creator", creatorAmount);
    }

    function _exec(ISafe safe, address owner, address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        require(safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig), "safe tx");
    }
}

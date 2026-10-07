pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Signatures} from "../src/Signatures.sol";

contract Refusing1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

contract Reverting1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert();
    }
}

contract Contract1271 {
    bytes32 internal immutable accepted;

    constructor(bytes32 digest) {
        accepted = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return digest == accepted && keccak256(signature) == keccak256("contract-signature")
            ? bytes4(0x1626ba7e)
            : bytes4(0xffffffff);
    }
}

contract SignaturesTest is Test {
    bytes32 internal constant DIGEST = keccak256("signature-order");

    function verify(address signer, bytes32 digest, bytes calldata signature) external view returns (bool) {
        return Signatures.isValid(signer, digest, signature);
    }

    function test_rawSignatureWorksBeforeAndAfter7702Delegation() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("signature-order-signer");
        (uint8 recovery, bytes32 first, bytes32 second) = vm.sign(signerKey, DIGEST);
        bytes memory signature = abi.encodePacked(first, second, recovery);
        assertTrue(this.verify(signer, DIGEST, signature));
        Refusing1271 implementation = new Refusing1271();
        vm.attachDelegation(vm.signDelegation(address(implementation), signerKey));
        assertGt(signer.code.length, 0);
        assertTrue(this.verify(signer, DIGEST, signature));
        assertFalse(this.verify(signer, keccak256("wrong-domain"), signature));
        assertFalse(this.verify(signer, DIGEST, hex"00"));
    }

    function test_contractWalletFallbackAndRefusals() public {
        Contract1271 wallet = new Contract1271(DIGEST);
        assertTrue(this.verify(address(wallet), DIGEST, bytes("contract-signature")));
        assertFalse(this.verify(address(wallet), keccak256("other"), bytes("contract-signature")));
        assertFalse(this.verify(address(wallet), DIGEST, hex"00"));
        assertFalse(this.verify(address(0), DIGEST, hex"00"));
        assertFalse(this.verify(address(new Refusing1271()), DIGEST, bytes("contract-signature")));
        assertFalse(this.verify(address(new Reverting1271()), DIGEST, bytes("contract-signature")));
    }

    function test_malleableAndInvalidRecoveryAreRefused() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("canonical-signature-signer");
        (uint8 recovery, bytes32 first, bytes32 second) = vm.sign(signerKey, DIGEST);
        uint256 curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes32 highSecond = bytes32(curveOrder - uint256(second));
        assertFalse(
            this.verify(signer, DIGEST, abi.encodePacked(first, highSecond, recovery == 27 ? uint8(28) : uint8(27)))
        );
        assertFalse(this.verify(signer, DIGEST, abi.encodePacked(first, second, uint8(0))));
        assertFalse(this.verify(signer, DIGEST, bytes("")));
    }
}

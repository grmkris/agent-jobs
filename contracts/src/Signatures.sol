pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

library Signatures {
    function isValid(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        if (signer == address(0)) return false;
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        return (error == ECDSA.RecoverError.NoError && recovered == signer)
            || SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
    }
}

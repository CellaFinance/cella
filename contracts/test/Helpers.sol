// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test only. Accepts every proof, so tree limits can be reached without real proofs.
contract AcceptAllVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[16] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// Test only. On receiving ETH it calls the pool again with stored calldata.
contract Reenter {
    address public pool;
    bytes public data;
    bool public tried;
    bool public innerCallSucceeded;

    function arm(address pool_, bytes calldata data_) external {
        pool = pool_;
        data = data_;
        tried = false;
        innerCallSucceeded = false;
    }

    receive() external payable {
        if (!tried && pool != address(0)) {
            tried = true;
            (bool ok,) = pool.call(data);
            innerCallSucceeded = ok;
        }
    }
}

/// Test only. Pushes ETH into an address that has no way to refuse it.
contract ForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

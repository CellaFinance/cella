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

    /// Collects a held payment. claim() pays with all the gas left, so the receive below can run.
    function collect() external {
        (bool ok,) = pool.call(abi.encodeWithSignature("claim()"));
        require(ok, "claim failed");
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

/// Test only. Refuses ETH until told to accept it, and can collect what it is owed.
contract Refuser {
    bool public accepting;

    function setAccepting(bool on) external {
        accepting = on;
    }

    function collect(address pool) external {
        (bool ok, bytes memory why) = pool.call(abi.encodeWithSignature("claim()"));
        if (!ok) {
            assembly {
                revert(add(why, 32), mload(why))
            }
        }
    }

    receive() external payable {
        require(accepting, "no thanks");
    }
}

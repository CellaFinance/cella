// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Cella address book
/// @notice Lets a wallet publish the two public keys others need to pay it
///         privately: the note owner key and the note encryption key.
///         Holds no funds and has no owner.
contract CellaRegistry {
    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct Entry {
        uint256 pubKey;
        bytes32 encKey;
    }

    mapping(address => Entry) public entries;

    event Registered(address indexed account, uint256 pubKey, bytes32 encKey);

    error BadKey();

    function register(uint256 pubKey, bytes32 encKey) external {
        if (pubKey == 0 || pubKey >= FIELD || encKey == bytes32(0)) revert BadKey();
        entries[msg.sender] = Entry(pubKey, encKey);
        emit Registered(msg.sender, pubKey, encKey);
    }
}

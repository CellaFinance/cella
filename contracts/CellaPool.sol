// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[16] calldata pubSignals
    ) external view returns (bool);
}

interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @title Cella shielded pool
/// @notice Holds ETH against note commitments. Every movement of value needs a
///         zero-knowledge proof from the `transact` circuit. There is no
///         upgrade path and no function that moves ETH without a valid proof.
contract CellaPool {
    uint256 public constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant AUDITOR_DELAY = 7 days;
    uint256 internal constant AMOUNT_LIMIT = 1 << 96;
    /// Gas handed to a payee. Enough for a wallet contract to accept ETH, too little to do harm.
    uint256 internal constant PAYOUT_GAS = 50_000;
    uint256 internal constant BABYJUB_A = 168700;
    uint256 internal constant BABYJUB_D = 168696;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256 root;
        uint256[2] nullifiers;
        uint256[2] commitments;
        uint256[2] auditEphemeral;
        uint256[5] auditCipher;
    }

    /// Everything outside the proof that the proof is bound to.
    struct ExtData {
        address recipient; // receives a withdrawal
        int256 extAmount; // > 0 deposit, < 0 withdrawal, 0 transfer
        address relayer; // receives `fee`
        uint256 fee;
        bytes note0; // encrypted note for the owner of commitment 0
        bytes note1;
    }

    IVerifier public immutable verifier;
    IHasher public immutable hasher;
    uint32 public immutable levels;
    uint32 public immutable rootHistorySize;

    address public owner;
    address public pendingOwner;

    bool public depositsPaused;
    uint256 public maxDeposit;
    uint256 public poolCap;
    /// ETH owed to notes. Tracked here so ETH forced into the contract changes nothing.
    uint256 public totalHeld;

    uint256[2] internal _auditorKey;
    uint256[2] internal _pendingAuditorKey;
    uint256 public pendingAuditorEta;

    /// ETH a payee could not accept when it was sent; they collect it with claim().
    mapping(address => uint256) public owed;

    mapping(uint256 => bool) public nullifierSpent;
    mapping(uint256 => uint256) public roots;
    mapping(uint256 => uint256) internal _zeros;
    mapping(uint256 => uint256) internal _filled;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    uint256 private _lock = 1;

    event NewCommitment(uint256 indexed commitment, uint32 index, bytes note);
    event NewNullifier(uint256 indexed nullifier);
    event AuditRecord(uint256 indexed nullifier0, uint256[2] ephemeral, uint256[5] cipher, uint256[2] auditorKey);
    event Deposit(address indexed from, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount);
    event RelayerPaid(address indexed relayer, uint256 fee);
    event PaymentHeld(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);
    event AuditorProposed(uint256 x, uint256 y, uint256 eta);
    event AuditorChanged(uint256 x, uint256 y);
    event DepositsPaused(bool paused);
    event LimitsChanged(uint256 maxDeposit, uint256 poolCap);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error Reentered();
    error UnknownRoot();
    error NullifierUsed();
    error OutOfField();
    error AmountOutOfRange();
    error InvalidProof();
    error WrongValue();
    error DepositsArePaused();
    error DepositTooLarge();
    error PoolCapReached();
    error NoRecipient();
    error TransferFailed();
    error NothingOwed();
    error TreeFull();
    error BadAuditorKey();
    error NothingPending();
    error TooEarly();
    error BadConfig();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        IVerifier verifier_,
        IHasher hasher_,
        uint32 levels_,
        uint32 rootHistorySize_,
        uint256[2] memory auditorKey_,
        uint256 maxDeposit_,
        uint256 poolCap_,
        address owner_
    ) {
        if (levels_ == 0 || levels_ > 31 || rootHistorySize_ == 0 || owner_ == address(0)) revert BadConfig();
        if (!_onCurve(auditorKey_[0], auditorKey_[1])) revert BadAuditorKey();
        verifier = verifier_;
        hasher = hasher_;
        levels = levels_;
        rootHistorySize = rootHistorySize_;
        _auditorKey = auditorKey_;
        maxDeposit = maxDeposit_;
        poolCap = poolCap_;
        owner = owner_;

        // Empty leaf is 0; _zeros[i] is the root of an empty subtree of height i.
        uint256 zero = 0;
        for (uint32 i = 0; i < levels_; i++) {
            _zeros[i] = zero;
            zero = hasher_.poseidon([zero, zero]);
        }
        roots[0] = zero;

        emit AuditorChanged(auditorKey_[0], auditorKey_[1]);
        emit LimitsChanged(maxDeposit_, poolCap_);
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------
    // The only way value moves
    // ------------------------------------------------------------------

    function transact(Proof calldata p, ExtData calldata e) external payable nonReentrant {
        if (!isKnownRoot(p.root)) revert UnknownRoot();
        if (e.fee >= AMOUNT_LIMIT) revert AmountOutOfRange();
        if (e.extAmount >= int256(AMOUNT_LIMIT) || e.extAmount <= -int256(AMOUNT_LIMIT)) revert AmountOutOfRange();

        // Marking the first before checking the second also refuses a repeated nullifier.
        for (uint256 i = 0; i < 2; i++) {
            uint256 n = p.nullifiers[i];
            if (n >= FIELD) revert OutOfField();
            if (nullifierSpent[n]) revert NullifierUsed();
            nullifierSpent[n] = true;
            emit NewNullifier(n);
        }

        if (!verifier.verifyProof(p.a, p.b, p.c, _publicSignals(p, e))) revert InvalidProof();

        if (e.extAmount > 0) {
            uint256 amount = uint256(e.extAmount);
            if (depositsPaused) revert DepositsArePaused();
            if (msg.value != amount) revert WrongValue();
            if (amount > maxDeposit) revert DepositTooLarge();
            totalHeld += amount;
            if (totalHeld > poolCap) revert PoolCapReached();
            emit Deposit(msg.sender, amount);
        } else if (msg.value != 0) {
            revert WrongValue();
        }

        uint32 index = _insertPair(p.commitments[0], p.commitments[1]);
        emit NewCommitment(p.commitments[0], index, e.note0);
        emit NewCommitment(p.commitments[1], index + 1, e.note1);
        emit AuditRecord(p.nullifiers[0], p.auditEphemeral, p.auditCipher, _auditorKey);

        // Books first, payments last. A payee that refuses its ETH cannot undo the
        // transaction: the amount waits for it in `owed`. Without this, a recipient
        // contract could make a relayer's transaction fail after the relayer had
        // checked it, costing the relayer gas for nothing, again and again.
        uint256 withdrawn = 0;
        if (e.extAmount < 0) {
            if (e.recipient == address(0)) revert NoRecipient();
            withdrawn = uint256(-e.extAmount);
        }
        if (e.fee > 0 && e.relayer == address(0)) revert NoRecipient();
        totalHeld -= withdrawn + e.fee;

        if (withdrawn > 0) {
            _pay(e.recipient, withdrawn);
            emit Withdrawal(e.recipient, withdrawn);
        }
        if (e.fee > 0) {
            _pay(e.relayer, e.fee);
            emit RelayerPaid(e.relayer, e.fee);
        }
    }

    /// Collects ETH that could not be delivered earlier.
    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// The hash every proof commits to. Includes this chain and this contract,
    /// so a proof cannot be replayed anywhere else.
    function extDataHash(ExtData calldata e) public view returns (uint256) {
        return uint256(
            keccak256(
                abi.encode(
                    e.recipient, e.extAmount, e.relayer, e.fee,
                    keccak256(e.note0), keccak256(e.note1),
                    block.chainid, address(this)
                )
            )
        ) % FIELD;
    }

    function _publicSignals(Proof calldata p, ExtData calldata e) internal view returns (uint256[16] memory s) {
        int256 pa = e.extAmount - int256(e.fee);
        s[0] = p.root;
        s[1] = pa >= 0 ? uint256(pa) : FIELD - uint256(-pa);
        s[2] = extDataHash(e);
        s[3] = p.nullifiers[0];
        s[4] = p.nullifiers[1];
        s[5] = p.commitments[0];
        s[6] = p.commitments[1];
        s[7] = _auditorKey[0];
        s[8] = _auditorKey[1];
        s[9] = p.auditEphemeral[0];
        s[10] = p.auditEphemeral[1];
        for (uint256 i = 0; i < 5; i++) s[11 + i] = p.auditCipher[i];
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) {
            owed[to] += amount;
            emit PaymentHeld(to, amount);
        }
    }

    // ------------------------------------------------------------------
    // Commitment tree
    // ------------------------------------------------------------------

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        for (uint32 n = 0; n < rootHistorySize; n++) {
            if (roots[i] == root) return true;
            i = i == 0 ? rootHistorySize - 1 : i - 1;
        }
        return false;
    }

    function lastRoot() external view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// Adds two leaves side by side. Every transaction adds exactly two, so the
    /// pair always starts at an even position.
    function _insertPair(uint256 leaf0, uint256 leaf1) internal returns (uint32 index) {
        index = nextIndex;
        if (uint256(index) + 2 > (uint256(1) << levels)) revert TreeFull();

        uint256 node = hasher.poseidon([leaf0, leaf1]);
        uint32 pos = index >> 1;
        for (uint32 level = 1; level < levels; level++) {
            if (pos & 1 == 0) {
                _filled[level] = node;
                node = hasher.poseidon([node, _zeros[level]]);
            } else {
                node = hasher.poseidon([_filled[level], node]);
            }
            pos >>= 1;
        }

        uint32 next = (currentRootIndex + 1) % rootHistorySize;
        currentRootIndex = next;
        roots[next] = node;
        nextIndex = index + 2;
    }

    // ------------------------------------------------------------------
    // Auditor key: read-only for the auditor, slow to change
    // ------------------------------------------------------------------

    function auditorKey() external view returns (uint256[2] memory) {
        return _auditorKey;
    }

    function pendingAuditorKey() external view returns (uint256[2] memory) {
        return _pendingAuditorKey;
    }

    function proposeAuditor(uint256 x, uint256 y) external onlyOwner {
        if (!_onCurve(x, y)) revert BadAuditorKey();
        _pendingAuditorKey = [x, y];
        pendingAuditorEta = block.timestamp + AUDITOR_DELAY;
        emit AuditorProposed(x, y, pendingAuditorEta);
    }

    /// Anyone may finish a change once the delay has passed.
    function activateAuditor() external {
        if (pendingAuditorEta == 0) revert NothingPending();
        if (block.timestamp < pendingAuditorEta) revert TooEarly();
        _auditorKey = _pendingAuditorKey;
        pendingAuditorEta = 0;
        emit AuditorChanged(_auditorKey[0], _auditorKey[1]);
    }

    /// On the Baby Jubjub curve and not the identity. Does not check the subgroup:
    /// the owner is responsible for proposing a key made the normal way.
    function _onCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= FIELD || y >= FIELD) return false;
        if (x == 0) return false;
        uint256 x2 = mulmod(x, x, FIELD);
        uint256 y2 = mulmod(y, y, FIELD);
        uint256 lhs = addmod(mulmod(BABYJUB_A, x2, FIELD), y2, FIELD);
        uint256 rhs = addmod(1, mulmod(BABYJUB_D, mulmod(x2, y2, FIELD), FIELD), FIELD);
        return lhs == rhs;
    }

    // ------------------------------------------------------------------
    // Owner: may slow deposits, never withdrawals
    // ------------------------------------------------------------------

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function setLimits(uint256 maxDeposit_, uint256 poolCap_) external onlyOwner {
        maxDeposit = maxDeposit_;
        poolCap = poolCap_;
        emit LimitsChanged(maxDeposit_, poolCap_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}

#!/usr/bin/env python3
"""Stagenet-only reference harness for the Nysiris Monero escrow spec (doc 17).

It talks to *external* monero-wallet-rpc processes and never handles seeds,
spend keys, or wallet files. The PWA is not involved: signed envelopes are
produced by a Nysiris client from the JSON summaries this script prints.

Every command requires --stagenet; configured wallets and payout addresses are
validated through the wallet RPC as stagenet. The harness has no mainnet mode.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LIMITS = ROOT / "crates/escrow-format/src/limits.rs"
MIN_CONFIRMATIONS = 10
ROLES = ("buyer", "seller", "arbiter")
KIND_RELEASE = 0
KIND_REFUND = 1


class HarnessError(Exception):
    pass


def rust_const(name: str) -> int:
    match = re.search(rf"pub const {name}:\s*u64\s*=\s*([\d_]+)\s*;", LIMITS.read_text())
    if not match:
        raise HarnessError(f"cannot read {name} from {LIMITS}")
    return int(match.group(1).replace("_", ""))


MAX_ESCROW_ATOMIC = rust_const("MAX_ESCROW_ATOMIC")
XMR_ATOMIC_UNITS = rust_const("XMR_ATOMIC_UNITS")


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def env_config(role: str) -> dict[str, str]:
    prefix = f"MONERO_{role.upper()}_RPC"
    cfg = {
        "url": os.environ.get(f"{prefix}_URL", "").rstrip("/"),
        "user": os.environ.get(f"{prefix}_USER", ""),
        "pass": os.environ.get(f"{prefix}_PASS", ""),
    }
    if not all(cfg.values()):
        raise HarnessError(
            f"set {prefix}_URL, {prefix}_USER and {prefix}_PASS (RPC basic auth is mandatory)"
        )
    return cfg


def rpc(cfg: dict[str, str], method: str, params: dict[str, Any] | None = None) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 0, "method": method, "params": params or {}}).encode()
    token = base64.b64encode(f"{cfg['user']}:{cfg['pass']}".encode()).decode()
    request = urllib.request.Request(
        f"{cfg['url']}/json_rpc",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Basic {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read())
    except Exception as exc:  # network/auth failures are deliberately opaque
        raise HarnessError(f"{method} failed: {type(exc).__name__}") from exc
    if "error" in payload:
        raise HarnessError(f"{method} error: {payload['error'].get('message', payload['error'])}")
    if "result" not in payload:
        raise HarnessError(f"{method} returned no result")
    return payload["result"]


def validate_stagenet_address(cfg: dict[str, str], address: str, label: str) -> str:
    """Fail closed unless the wallet RPC itself calls this a stagenet address."""
    if not isinstance(address, str) or not address:
        raise HarnessError(f"{label} is missing or not a string")
    result = rpc(cfg, "validate_address", {"address": address, "any_net_type": True})
    if result.get("valid") is not True or result.get("nettype") != "stagenet":
        raise HarnessError(f"{label} is not a valid stagenet address")
    return address


def wallet_address(cfg: dict[str, str], role: str) -> str:
    result = rpc(cfg, "get_address", {"account_index": 0, "address_index": [0]})
    address = result.get("address", "")
    if not isinstance(address, str) or not address.startswith("5"):
        raise HarnessError(f"{role} wallet is not a stagenet primary address (got {address[:8]}…)")
    return validate_stagenet_address(cfg, address, f"{role} primary address")


def require_stagenet(cfgs: dict[str, dict[str, str]]) -> dict[str, str]:
    return {role: wallet_address(cfg, role) for role, cfg in cfgs.items()}


def multisig_info(result: dict[str, Any]) -> str:
    for key in ("multisig_info", "info"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    raise HarnessError("multisig RPC response had no info blob")


def txset(result: dict[str, Any]) -> str:
    for key in ("txset", "unsigned_txset", "tx_data_hex"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    raise HarnessError("transfer RPC response had no multisig txset")


def read_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise HarnessError(f"no state at {path}; run setup first")
    state = json.loads(path.read_text())
    if state.get("network") != "stagenet":
        raise HarnessError("state file is not marked stagenet")
    return state


def write_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle, sort_keys=True, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def hex16(value: str, label: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F]{32}", value):
        raise HarnessError(f"{label} must be 16 bytes of hex")
    return value.lower()


def amount_arg(value: str) -> int:
    amount = int(value, 10)
    if amount <= 0 or amount > MAX_ESCROW_ATOMIC:
        raise HarnessError(f"amount must be 1..{MAX_ESCROW_ATOMIC} atomic units")
    return amount


def funding_message(state: dict[str, Any]) -> str:
    # The proof message binds the frozen amount as well as the session, so a
    # proof for an underpayment cannot be replayed as full funding.
    return f"nysiris-escrow:{state['order']}:{state['nonce']}:funded:{state['amount']}"


def transfer_atomic(transfer: dict[str, Any]) -> int:
    """Absolute atomic-unit amount of a wallet transfer (outgoing may be negative)."""
    raw = transfer.get("amount", 0)
    if isinstance(raw, list):
        total = sum(int(part) for part in raw)
    else:
        total = int(raw)
    return abs(total)


def hex32(value: str, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise HarnessError(f"{label} must be 32 bytes of hex")
    return value.lower()


def setup(args: argparse.Namespace) -> None:
    if args.amount <= 0 or args.amount > MAX_ESCROW_ATOMIC:
        raise HarnessError(f"amount outside the {MAX_ESCROW_ATOMIC} atomic-unit reference cap")
    order = hex16(args.order, "order")
    cfgs = {role: env_config(role) for role in ROLES}
    addresses = require_stagenet(cfgs)

    prepared = {}
    for role in ROLES:
        prepared[role] = multisig_info(rpc(cfgs[role], "prepare_multisig"))

    made: dict[str, str] = {}
    for role in ROLES:
        others = [prepared[r] for r in ROLES if r != role]
        made[role] = multisig_info(rpc(cfgs[role], "make_multisig", {
            "threshold": 2,
            "multisig_info": others,
            "password": "",
        }))

    # 2-of-3 needs both exchange_multisig_keys rounds. Each round consumes
    # the previous round's blobs from the *other* two wallets.
    current = made
    for _ in range(2):
        exchanged: dict[str, str] = {}
        for role in ROLES:
            others = [current[r] for r in ROLES if r != role]
            exchanged[role] = multisig_info(rpc(cfgs[role], "exchange_multisig_keys", {
                "multisig_info": others,
                "password": "",
            }))
        current = exchanged

    # Output sync is required before a multisig wallet can spend its deposits.
    # Skipping it leaves describe_transfer/transfer unable to see the outputs.
    exported = {
        role: multisig_info(rpc(cfgs[role], "export_multisig_info"))
        for role in ROLES
    }
    for role in ROLES:
        imported = rpc(cfgs[role], "import_multisig_info", {
            "info": [exported[r] for r in ROLES if r != role],
        })
        count = imported.get("n_outputs_imported")
        if not isinstance(count, int) or count < 0:
            raise HarnessError("multisig output import returned an invalid count")

    final_addresses = require_stagenet(cfgs)
    if len(set(final_addresses.values())) != 1:
        raise HarnessError("participants report different multisig addresses; discard and restart")
    address = final_addresses["buyer"]
    nonce = secrets.token_bytes(16).hex()
    # SHA-256(order || nonce || address): the same byte sequence is verified by
    # escrow-format's state machine and mirrored in web/src/domain/escrow.ts.
    transcript_hash = sha256_bytes(bytes.fromhex(order) + bytes.fromhex(nonce) + address.encode())
    state = {
        "network": "stagenet",
        "phase": "setup",
        "order": order,
        "nonce": nonce,
        "amount": args.amount,
        "address": address,
        "transcript_hash": transcript_hash,
        "participants": dict(sorted(final_addresses.items())),
        "inputs_seen": [],
        "signed_inputs": None,
        "txid": None,
    }
    write_state(Path(args.state), state)
    print_json({
        "command": "setup",
        "summary": {
            "order": order,
            "nonce": nonce,
            "address": address,
            "round": 3,
            "transcript_hash": transcript_hash,
            "amount": args.amount,
        },
        "next": "Sign commit envelopes in the Nysiris client; then run funding-proof on the sender wallet.",
    })


def cmd_check(args: argparse.Namespace) -> None:
    cfgs = {role: env_config(role) for role in ROLES}
    addresses = require_stagenet(cfgs)
    print_json({"command": "check", "network": "stagenet", "addresses": addresses})


def funding_proof(args: argparse.Namespace) -> None:
    state = read_state(Path(args.state))
    cfg = env_config("sender")
    require_stagenet({"sender": cfg})
    proof = rpc(cfg, "get_tx_proof", {
        "txid": args.txid.lower(),
        "address": state["address"],
        "message": funding_message(state),
    }).get("signature", "")
    if not proof:
        raise HarnessError("get_tx_proof returned no signature")
    print_json({
        "command": "funding-proof",
        "proof": proof,
        "message": funding_message(state),
        "amount": state["amount"],
        "note": "Put proof in a funded envelope; do not paste it into the shop relay.",
    })


def verify_funding(args: argparse.Namespace) -> None:
    state = read_state(Path(args.state))
    if args.amount != state["amount"]:
        raise HarnessError("funding amount does not match the frozen escrow terms")
    txid = args.txid.lower()

    # Sender-side check: the outgoing transfer must really pay the frozen
    # escrow address and amount, with no lock or seen double spend.
    sender_cfg = env_config("sender")
    require_stagenet({"sender": sender_cfg})
    sender_tx = rpc(sender_cfg, "get_transfer_by_txid", {"txid": txid})
    transfers = [
        t for t in (sender_tx.get("transfers") or [])
        if str(t.get("txid", "")).lower() == txid
    ]
    if not transfers:
        raise HarnessError("sender wallet has no transfer with this txid")
    outgoing = [t for t in transfers if t.get("type") == "out" or transfer_atomic(t) > 0]
    if not outgoing:
        raise HarnessError("sender transfer is not an outgoing payment")
    for transfer in outgoing:
        if transfer_atomic(transfer) != state["amount"]:
            raise HarnessError("sender transfer amount does not match the frozen terms")
        if transfer.get("unlock_time", 0) != 0 or transfer.get("locked") is True:
            raise HarnessError("funding transfer is time-locked or not yet spendable")
        if transfer.get("double_spend_seen") is True:
            raise HarnessError("sender reports a double spend for the funding transfer")
    destinations = outgoing[0].get("destinations")
    if destinations:
        if not any(
            d.get("address") == state["address"] and int(d.get("amount", 0)) == state["amount"]
            for d in destinations
        ):
            raise HarnessError("sender transfer destinations do not include the frozen escrow address")

    # check_tx_proof proves payment, not spendability. Each escrow signer also
    # checks its own wallet state before the harness marks the order fundable.
    checks: dict[str, Any] = {}
    for role in ROLES:
        cfg = env_config(role)
        require_stagenet({role: cfg})
        result = rpc(cfg, "check_tx_proof", {
            "txid": txid,
            "address": state["address"],
            "message": funding_message(state),
            "signature": args.proof,
        })
        if result.get("good") is not True:
            raise HarnessError(f"{role} wallet rejected the funding proof")
        if result.get("in_pool") is True:
            raise HarnessError(f"{role} says the funding transaction is still in the pool")
        received = int(result.get("received", 0))
        if received != state["amount"]:
            raise HarnessError(f"{role} proof amount {received} does not match the frozen terms")
        confirmations = int(result.get("confirmations", 0))
        if confirmations < MIN_CONFIRMATIONS:
            raise HarnessError(f"only {confirmations} confirmations; need {MIN_CONFIRMATIONS}")

        incoming = rpc(cfg, "get_transfer_by_txid", {"txid": txid, "all_accounts": True})
        spendable = [
            t for t in (incoming.get("transfers") or [])
            if t.get("type") == "in"
            and transfer_atomic(t) == state["amount"]
            and t.get("unlock_time", 0) == 0
            and t.get("locked") is False
            and t.get("double_spend_seen") is not True
        ]
        if not spendable:
            raise HarnessError(f"{role} wallet has no spendable, unlocked incoming funding output")
        balance = rpc(cfg, "get_balance", {"account_index": 0})
        if balance.get("multisig_import_needed") is True:
            raise HarnessError(f"{role} wallet still needs a multisig output import")
        if int(balance.get("unlocked_balance", 0)) < state["amount"]:
            raise HarnessError(f"{role} wallet has no unlocked balance for the escrow amount")
        if int(balance.get("blocks_to_unlock", 0)) != 0:
            raise HarnessError(f"{role} wallet reports blocked outputs")
        checks[role] = {
            "confirmations": confirmations,
            "received": received,
            "spendable_outputs": len(spendable),
        }

    state["phase"] = "awaiting_spend"
    state["funding_txid"] = txid
    write_state(Path(args.state), state)
    print_json({
        "command": "verify-funding",
        "confirmations": checks,
        "unlock_time": 0,
        "amount": state["amount"],
    })


def describe_txset(txset_hex: str, cfg: dict[str, str]) -> tuple[str, str, dict[str, Any]]:
    """Fail closed on any spend-relevant change to a multisig transaction.

    The txset hash bound by `release` is the SHA-256 of the full canonical
    `describe_transfer.desc` list: inputs, recipients, change, fee, unlock
    time, ring size, and extra. Comparing only inputs is not enough.
    """
    result = rpc(cfg, "describe_transfer", {"multisig_txset": txset_hex})
    descriptions = result.get("desc", [])
    if not isinstance(descriptions, list) or len(descriptions) != 1:
        raise HarnessError("describe_transfer did not return exactly one transfer")
    item = descriptions[0]
    if not isinstance(item, dict):
        raise HarnessError("describe_transfer returned a malformed description")
    inputs_hash = sha256_bytes(canonical(item.get("inputs", [])))
    txset_hash = sha256_bytes(canonical(descriptions))
    return inputs_hash, txset_hash, item


def propose(args: argparse.Namespace) -> None:
    state = read_state(Path(args.state))
    if state["phase"] != "awaiting_spend":
        raise HarnessError("propose requires a verified funding proof")
    cfg = env_config(args.role)
    require_stagenet({args.role: cfg})
    payout = validate_stagenet_address(cfg, args.payout, "payout address")
    if args.amount != state["amount"]:
        raise HarnessError("payout amount does not match the frozen escrow terms")
    result = rpc(cfg, "transfer", {
        "destinations": [{"address": payout, "amount": args.amount}],
        "account_index": 0,
        "priority": 0,
        "unlock_time": 0,
        "do_not_relay": True,
    })
    unsigned = txset(result)
    inputs_hash, txset_hash, desc = describe_txset(unsigned, cfg)
    if int(desc.get("unlock_time", 0)) != 0:
        raise HarnessError("proposed transfer has a non-zero unlock_time")
    recipients = desc.get("recipients", [])
    if len(recipients) != 1 or int(recipients[0].get("amount", 0)) != args.amount:
        raise HarnessError("proposed transfer does not pay the frozen amount to one recipient")
    if inputs_hash in state["inputs_seen"]:
        raise HarnessError("inputs were already used in this escrow session")
    state["inputs_seen"] = state["inputs_seen"] + [inputs_hash]
    state["phase"] = "proposed"
    state["proposed"] = {
        "role": args.role,
        "payout": payout,
        "amount": args.amount,
        "inputs_hash": inputs_hash,
        "txset_hash": txset_hash,
        "inputs": desc.get("inputs", []),
    }
    write_state(Path(args.state), state)
    print_json({
        "command": "propose",
        "unsigned_txset": unsigned,
        "inputs_hash": inputs_hash,
        "txset_hash": txset_hash,
        "next": "Put txset_hash in the signed release; cosign/submit require --release-txset-hash.",
    })


def cosign(args: argparse.Namespace) -> None:
    state = read_state(Path(args.state))
    if state["phase"] != "proposed":
        raise HarnessError("cosign requires a locally proposed transfer")
    cfg = env_config(args.role)
    require_stagenet({args.role: cfg})
    expected = hex32(args.release_txset_hash, "release txset hash")
    inputs_hash, txset_hash, _ = describe_txset(args.txset, cfg)
    if txset_hash != state["proposed"]["txset_hash"]:
        raise HarnessError("describe_transfer details changed; refusing to sign a different txset")
    if txset_hash != expected:
        raise HarnessError("txset does not match the hash in the signed release envelope")
    if inputs_hash != state["proposed"]["inputs_hash"]:
        raise HarnessError("describe_transfer inputs changed; refusing to sign a second transfer")
    if state.get("signed_inputs") and state["signed_inputs"] != inputs_hash:
        raise HarnessError("this transfer set was already signed with different inputs")
    result = rpc(cfg, "sign_multisig", {"tx_data_hex": args.txset})
    signed = result.get("tx_data_hex") or ""
    if not signed:
        raise HarnessError("sign_multisig returned no signed txset")
    _, signed_hash, _ = describe_txset(signed, cfg)
    if signed_hash != expected:
        raise HarnessError("sign_multisig changed the spend-relevant transaction details")
    state["signed_inputs"] = inputs_hash
    state["signed_txset_hash"] = signed_hash
    write_state(Path(args.state), state)
    print_json({
        "command": "cosign",
        "signed_txset": signed,
        "inputs_hash": inputs_hash,
        "txset_hash": signed_hash,
        "next": "Run submit --broadcast from any signer once both signatures are present.",
    })


def submit(args: argparse.Namespace) -> None:
    state = read_state(Path(args.state))
    cfg = env_config(args.role)
    require_stagenet({args.role: cfg})
    expected = hex32(args.release_txset_hash, "release txset hash")
    inputs_hash, txset_hash, _ = describe_txset(args.txset, cfg)
    if txset_hash != state["proposed"]["txset_hash"] or txset_hash != expected:
        raise HarnessError("submitted txset does not match the signed release")
    if state.get("signed_inputs") != inputs_hash:
        raise HarnessError("submitted txset inputs do not match the signed transfer")
    if not args.broadcast:
        raise HarnessError("refusing to broadcast without the explicit --broadcast flag")
    result = rpc(cfg, "submit_multisig", {"tx_data_hex": args.txset})
    txids = result.get("tx_hash_list", [])
    if not txids:
        raise HarnessError("submit_multisig returned no transaction id")
    state["phase"] = "submitted"
    state["txid"] = txids[0]
    write_state(Path(args.state), state)
    print_json({"command": "submit", "txid": txids[0], "kind": args.kind})


def print_json(value: Any) -> None:
    print(json.dumps(value, sort_keys=True, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stagenet", action="store_true", required=True,
                        help="acknowledge that this harness never operates on mainnet")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("check", help="verify every configured wallet is stagenet").set_defaults(func=cmd_check)

    p = sub.add_parser("setup", help="create one fresh 2-of-3 multisig wallet per order")
    p.add_argument("--order", required=True, help="shop order id, 16 bytes hex")
    p.add_argument("--amount", required=True, type=amount_arg, help="piconeros, integer")
    p.add_argument("--state", required=True, help="state file (created 0600)")
    p.set_defaults(func=setup)

    p = sub.add_parser("funding-proof", help="get_tx_proof from the sender wallet")
    p.add_argument("--state", required=True)
    p.add_argument("--txid", required=True)
    p.set_defaults(func=funding_proof)

    p = sub.add_parser("verify-funding", help="check_tx_proof on all three escrow wallets")
    p.add_argument("--state", required=True)
    p.add_argument("--txid", required=True)
    p.add_argument("--amount", required=True, type=amount_arg)
    p.add_argument("--proof", required=True)
    p.set_defaults(func=verify_funding)

    p = sub.add_parser("propose", help="create an unsigned, unbroadcast payout transfer")
    p.add_argument("--state", required=True)
    p.add_argument("--role", choices=ROLES, default="seller")
    p.add_argument("--payout", required=True)
    p.add_argument("--amount", required=True, type=amount_arg)
    p.set_defaults(func=propose)

    p = sub.add_parser("cosign", help="sign a transfer after re-checking its full description")
    p.add_argument("--state", required=True)
    p.add_argument("--role", choices=ROLES, required=True)
    p.add_argument("--txset", required=True, help="hex returned by propose")
    p.add_argument("--release-txset-hash", required=True,
                   help="txset_hash from the signed release envelope being cosigned")
    p.set_defaults(func=cosign)

    p = sub.add_parser("submit", help="broadcast a fully signed multisig transfer")
    p.add_argument("--state", required=True)
    p.add_argument("--role", choices=ROLES, default="seller")
    p.add_argument("--txset", required=True)
    p.add_argument("--release-txset-hash", required=True,
                   help="txset_hash from the signed release envelope being submitted")
    p.add_argument("--kind", type=int, choices=(KIND_RELEASE, KIND_REFUND), default=KIND_RELEASE)
    p.add_argument("--broadcast", action="store_true", required=True,
                   help="explicitly allow the irreversible broadcast")
    p.set_defaults(func=submit)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        args.func(args)
        return 0
    except HarnessError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

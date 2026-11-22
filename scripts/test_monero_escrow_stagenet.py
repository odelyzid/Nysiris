#!/usr/bin/env python3
"""Offline fail-closed checks for the stagenet escrow harness.

Run with: python3 -m unittest scripts.test_monero_escrow_stagenet
No wallet RPC, network, or stagenet funds are involved: every RPC call is
mocked, and only refusal paths (plus hash derivation) are exercised.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HARNESS = Path(__file__).with_name("monero_escrow_stagenet.py")
spec = importlib.util.spec_from_file_location("monero_escrow_stagenet", HARNESS)
assert spec and spec.loader
escrow = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = escrow
spec.loader.exec_module(escrow)

STATE = {
    "network": "stagenet",
    "phase": "proposed",
    "order": "ab" * 16,
    "nonce": "cd" * 16,
    "amount": 500,
    "address": "5StagenetEscrow",
    "inputs_seen": [],
    "signed_inputs": None,
    "proposed": {"inputs_hash": "11" * 32, "txset_hash": "22" * 32},
}
CFG = {"url": "http://127.0.0.1:1", "user": "u", "pass": "p"}
TXID = "33" * 32


def args(**overrides: object) -> SimpleNamespace:
    values = {
        "state": str(HARNESS),
        "txid": TXID,
        "amount": STATE["amount"],
        "proof": "tx-proof",
        "role": "buyer",
        "txset": "aabb",
        "release_txset_hash": "22" * 32,
        "broadcast": False,
        "kind": 0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def funding_rpc(cfg: dict, method: str, params: dict | None = None) -> dict:
    """Minimal happy-path wallet responses; individual tests override one call."""
    if method == "get_transfer_by_txid":
        incoming = params is not None and params.get("all_accounts") is True
        transfer = {
            "txid": TXID,
            "type": "in" if incoming else "out",
            "amount": STATE["amount"],
            "unlock_time": 0,
            "double_spend_seen": False,
            "destinations": [{"address": STATE["address"], "amount": STATE["amount"]}],
        }
        if incoming:
            transfer["locked"] = False
        return {"transfers": [transfer]}
    if method == "check_tx_proof":
        return {"good": True, "in_pool": False, "received": STATE["amount"], "confirmations": 20}
    if method == "get_balance":
        return {"multisig_import_needed": False, "unlocked_balance": STATE["amount"], "blocks_to_unlock": 0}
    if method == "validate_address":
        return {"valid": True, "nettype": "stagenet"}
    raise AssertionError(f"unexpected RPC: {method}")


class HarnessFailClosed(unittest.TestCase):
    def test_proof_message_binds_the_frozen_amount(self) -> None:
        message = escrow.funding_message(STATE)
        self.assertTrue(message.endswith(f":funded:{STATE['amount']}"))
        changed = dict(STATE, amount=STATE["amount"] + 1)
        self.assertNotEqual(message, escrow.funding_message(changed))

    def test_address_validation_trusts_the_wallet_rpc(self) -> None:
        with patch.object(escrow, "rpc", return_value={"valid": True, "nettype": "stagenet"}):
            self.assertEqual(
                escrow.validate_stagenet_address(CFG, "5Stagenet", "payout"), "5Stagenet"
            )
        with patch.object(escrow, "rpc", return_value={"valid": True, "nettype": "mainnet"}):
            with self.assertRaises(escrow.HarnessError):
                escrow.validate_stagenet_address(CFG, "4Mainnet", "payout")

    def test_verify_funding_rejects_amount_drift(self) -> None:
        with patch.object(escrow, "read_state", return_value=dict(STATE)):
            with self.assertRaises(escrow.HarnessError):
                escrow.verify_funding(args(amount=STATE["amount"] + 1))

    def test_verify_funding_rejects_bad_incomplete_or_unspendable_proofs(self) -> None:
        cases = [
            ({"good": False}, "rejected"),
            ({"good": True, "in_pool": True}, "pool"),
            ({"good": True, "received": STATE["amount"] - 1}, "amount"),
            ({"good": True, "confirmations": 1}, "confirmations"),
        ]
        for override, label in cases:
            with self.subTest(label=label):
                def rpc(cfg: dict, method: str, params: dict | None = None, _o: dict = override) -> dict:
                    result = funding_rpc(cfg, method, params)
                    if method == "check_tx_proof":
                        result.update(_o)
                    return result

                with patch.object(escrow, "read_state", return_value=dict(STATE)), \
                     patch.object(escrow, "env_config", return_value=CFG), \
                     patch.object(escrow, "require_stagenet"), \
                     patch.object(escrow, "rpc", side_effect=rpc), \
                     self.assertRaises(escrow.HarnessError):
                    escrow.verify_funding(args())

    def test_verify_funding_rejects_locked_receiving_output(self) -> None:
        def rpc(cfg: dict, method: str, params: dict | None = None) -> dict:
            result = funding_rpc(cfg, method, params)
            if method == "get_transfer_by_txid" and params and params.get("all_accounts"):
                result["transfers"][0]["locked"] = True
            return result

        with patch.object(escrow, "read_state", return_value=dict(STATE)), \
             patch.object(escrow, "env_config", return_value=CFG), \
             patch.object(escrow, "require_stagenet"), \
             patch.object(escrow, "rpc", side_effect=rpc), \
             self.assertRaises(escrow.HarnessError):
            escrow.verify_funding(args())

    def test_full_description_hash_binds_recipients_not_only_inputs(self) -> None:
        desc = {"inputs": [{"id": "aa"}], "recipients": [{"address": "5Pay", "amount": 500}]}
        with patch.object(escrow, "rpc", return_value={"desc": [desc]}):
            inputs_a, hash_a, _ = escrow.describe_txset("aabb", CFG)
        changed = {"inputs": [{"id": "aa"}], "recipients": [{"address": "5Other", "amount": 500}]}
        with patch.object(escrow, "rpc", return_value={"desc": [changed]}):
            inputs_b, hash_b, _ = escrow.describe_txset("aabb", CFG)
        self.assertEqual(inputs_a, inputs_b)
        self.assertNotEqual(hash_a, hash_b)

    def test_cosign_and_submit_refuse_a_different_release_hash(self) -> None:
        with patch.object(escrow, "read_state", return_value=dict(STATE)), \
             patch.object(escrow, "env_config", return_value=CFG), \
             patch.object(escrow, "require_stagenet"), \
             patch.object(escrow, "rpc", return_value={"desc": [{"inputs": [], "recipients": []}]}), \
             self.assertRaises(escrow.HarnessError):
            escrow.cosign(args(release_txset_hash="99" * 32))
        with patch.object(escrow, "read_state", return_value=dict(STATE)), \
             patch.object(escrow, "env_config", return_value=CFG), \
             patch.object(escrow, "require_stagenet"), \
             patch.object(escrow, "rpc", return_value={"desc": [{"inputs": [], "recipients": []}]}), \
             self.assertRaises(escrow.HarnessError):
            escrow.submit(args(release_txset_hash="99" * 32, broadcast=True))

    def test_submit_requires_explicit_broadcast(self) -> None:
        with patch.object(escrow, "read_state", return_value=dict(STATE)), \
             patch.object(escrow, "env_config", return_value=CFG), \
             patch.object(escrow, "require_stagenet"), \
             patch.object(escrow, "rpc", return_value={"desc": []}), \
             self.assertRaises(escrow.HarnessError):
            escrow.submit(args())


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""XOR-obfuscate/deobfuscate the omp-web release provider-secrets bundle.

This is OBFUSCATION, not encryption: the ciphertext and the key both ship
inside the .deb, so anyone who can read the package (or the installed
/opt/omp-web/secrets directory) can recover the plaintext. See
docs/plans/2026-08-20-omp-web-release-pipeline.md, "Security notes".
"""

from __future__ import annotations

import argparse
import base64
import os
import sys
import tempfile
from pathlib import Path


def _xor(data: bytes, key: bytes) -> bytes:
    if not key:
        raise ValueError("key must not be empty")
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def cmd_seal(args: argparse.Namespace) -> None:
    plain_path = Path(args.plain)
    plaintext = plain_path.read_bytes()
    key = os.urandom(args.key_bytes)
    ciphertext = _xor(plaintext, key)

    out_cipher = Path(args.out_cipher)
    out_key = Path(args.out_key)
    out_cipher.parent.mkdir(parents=True, exist_ok=True)
    out_key.parent.mkdir(parents=True, exist_ok=True)
    out_cipher.write_text(base64.b64encode(ciphertext).decode("ascii") + "\n")
    out_key.write_bytes(key)
    print(f"sealed {plain_path} -> {out_cipher} ({len(plaintext)} bytes, {args.key_bytes}-byte key)")


def _decrypt(cipher_path: Path, key_path: Path) -> str:
    ciphertext = base64.b64decode(cipher_path.read_text().strip())
    key = key_path.read_bytes()
    return _xor(ciphertext, key).decode("utf-8")


def _parse_env(text: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        pairs.append((key.strip(), value))
    return pairs


def cmd_merge(args: argparse.Namespace) -> None:
    plaintext = _decrypt(Path(args.cipher), Path(args.key))
    secrets = dict(_parse_env(plaintext))
    for skip in args.skip_var:
        secrets.pop(skip, None)

    target_path = Path(args.target)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    existing_text = target_path.read_text() if target_path.exists() else ""
    existing_keys = {k for k, _ in _parse_env(existing_text)}

    to_append = [(k, v) for k, v in secrets.items() if k not in existing_keys]
    if not to_append:
        print(f"{target_path}: all {len(secrets)} sealed keys already present, nothing to merge")
        return

    lines = existing_text.splitlines()
    if lines and lines[-1].strip():
        lines.append("")
    lines.append("# added by tools/xor-secrets.py merge (existing keys always win)")
    for key, value in to_append:
        lines.append(f"{key}={value}")
    fd, tmp_name = tempfile.mkstemp(dir=str(target_path.parent), prefix=f".{target_path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp_name, target_path)  # same-directory rename is atomic
    os.chmod(target_path, 0o600)
    print(f"{target_path}: merged {len(to_append)} key(s): {', '.join(k for k, _ in to_append)}")


def cmd_get(args: argparse.Namespace) -> None:
    plaintext = _decrypt(Path(args.cipher), Path(args.key))
    secrets = dict(_parse_env(plaintext))
    if args.var not in secrets:
        print(f"error: {args.var} not present in sealed bundle", file=sys.stderr)
        sys.exit(1)
    print(secrets[args.var])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    seal = sub.add_parser("seal", help="XOR-obfuscate a plaintext KEY=VALUE env file")
    seal.add_argument("--plain", required=True)
    seal.add_argument("--out-cipher", required=True)
    seal.add_argument("--out-key", required=True)
    seal.add_argument("--key-bytes", type=int, default=4096)
    seal.set_defaults(func=cmd_seal)

    merge = sub.add_parser("merge", help="Decrypt and merge sealed keys into a target .env file")
    merge.add_argument("--cipher", required=True)
    merge.add_argument("--key", required=True)
    merge.add_argument("--target", required=True)
    merge.add_argument("--skip-var", action="append", default=[])
    merge.set_defaults(func=cmd_merge)

    get = sub.add_parser("get", help="Print one decrypted key's value to stdout")
    get.add_argument("--cipher", required=True)
    get.add_argument("--key", required=True)
    get.add_argument("--var", required=True)
    get.set_defaults(func=cmd_get)

    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()

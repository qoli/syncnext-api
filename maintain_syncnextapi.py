#!/usr/bin/env python3
"""Run SyncnextAPI maintenance: CI data export flow + syncnextPlugin play test."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def log(message: str) -> None:
    print(message, flush=True)


def run_cmd(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    shown = " ".join(shlex.quote(part) for part in cmd)
    location = f" (cwd={cwd})" if cwd else ""
    log(f"$ {shown}{location}")
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, check=True)


def fetch_mdd_version(timeout_sec: int = 20) -> str:
    url = f"https://itunes.apple.com/lookup?id=1314769817&country=cn&_={int(time.time())}"
    try:
        with urllib.request.urlopen(url, timeout=timeout_sec) as resp:
            payload = json.load(resp)
        if payload.get("resultCount", 0) > 0:
            return str(payload["results"][0].get("version", "")).strip()
        log("[warn] MDD lookup returned zero results.")
        return ""
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        log(f"[warn] Failed to fetch MDD version: {exc}")
        return ""


def update_mdd_app_version(app_data_path: Path, version: str) -> bool:
    if not version:
        log("[warn] Empty MDD version; skip mddAppVersion update.")
        return False

    with app_data_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        log(f"[warn] appData.json is not an array ({type(data).__name__}); skip update.")
        return False

    updated = False
    for item in data:
        if isinstance(item, dict) and item.get("Key") == "mddAppVersion":
            item["Text"] = version
            updated = True
            break

    if not updated:
        log("[warn] Key 'mddAppVersion' not found in appData.json; skip update.")
        return False

    with app_data_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
        f.write("\n")

    log(f"[ok] Updated mddAppVersion -> {version}")
    return True


def run_export_json(api_root: Path, notion_token: str | None, skip_bun_install: bool) -> None:
    worker_dir = api_root / "notion-api-worker"
    env = os.environ.copy()
    if notion_token:
        env["NOTION_TOKEN"] = notion_token

    if not env.get("NOTION_TOKEN"):
        raise RuntimeError("NOTION_TOKEN is required for export-json. Use --notion-token or env NOTION_TOKEN.")

    if not skip_bun_install:
        run_cmd(["bun", "install", "--frozen-lockfile"], cwd=worker_dir, env=env)

    run_cmd(["bun", "run", "export-json", "--", "--out-dir", ".."], cwd=worker_dir, env=env)


def run_play_test(api_root: Path, sources: Path, output_dir: Path, extra_args: str) -> None:
    cmd = [
        "node",
        str(api_root / "node_test_syncnextplugin_play.js"),
        f"--sources={sources}",
        f"--output-dir={output_dir}",
    ]
    if extra_args.strip():
        cmd.extend(shlex.split(extra_args.strip()))
    run_cmd(cmd, cwd=api_root)


def git_commit_if_needed(api_root: Path, message: str) -> None:
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(api_root),
        check=True,
        capture_output=True,
        text=True,
    )
    if not status.stdout.strip():
        log("[info] No git changes; skip commit.")
        return

    run_cmd(["git", "add", "."], cwd=api_root)
    run_cmd(["git", "commit", "-m", message], cwd=api_root)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="SyncnextAPI maintenance runner (CI export flow + plugin play test)."
    )
    parser.add_argument(
        "--api-root",
        default=str(Path(__file__).resolve().parent),
        help="SyncnextAPI repository root. Default: script directory.",
    )
    parser.add_argument(
        "--notion-token",
        default=os.environ.get("NOTION_TOKEN", ""),
        help="Notion token for export-json. Default: env NOTION_TOKEN.",
    )
    parser.add_argument(
        "--sources",
        default="sourcesv3.json",
        help="Sources JSON path for node_test_syncnextplugin_play.js (relative to api-root).",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Output dir for node_test_syncnextplugin_play.js (relative to api-root).",
    )
    parser.add_argument(
        "--play-test-extra",
        default="",
        help="Extra raw args appended to play test command, e.g. \"--max-plugins=1 --limit-medias=1\".",
    )
    parser.add_argument(
        "--skip-export",
        action="store_true",
        help="Skip notion-api-worker export-json step.",
    )
    parser.add_argument(
        "--skip-bun-install",
        action="store_true",
        help="Skip bun install before export-json.",
    )
    parser.add_argument(
        "--skip-mdd-update",
        action="store_true",
        help="Skip mddAppVersion fetch/update in appData.json.",
    )
    parser.add_argument(
        "--skip-play-test",
        action="store_true",
        help="Skip node_test_syncnextplugin_play.js step.",
    )
    parser.add_argument(
        "--commit",
        action="store_true",
        help="Commit changed files at the end (same repo).",
    )
    parser.add_argument(
        "--commit-message",
        default="Apply downloaded JSON",
        help="Commit message used with --commit.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    api_root = Path(args.api_root).resolve()
    sources = (api_root / args.sources).resolve()
    output_dir = (api_root / args.output_dir).resolve()

    log(f"[root] {api_root}")
    log("[flow] export-json -> mddAppVersion update -> plugin play test")

    try:
        if not args.skip_export:
            log("[step] export-json")
            run_export_json(api_root, args.notion_token.strip(), args.skip_bun_install)
        else:
            log("[skip] export-json")

        if not args.skip_mdd_update:
            log("[step] update mddAppVersion")
            version = fetch_mdd_version()
            update_mdd_app_version(api_root / "appData.json", version)
        else:
            log("[skip] update mddAppVersion")

        if not args.skip_play_test:
            log("[step] plugin play test")
            run_play_test(api_root, sources, output_dir, args.play_test_extra)
        else:
            log("[skip] plugin play test")

        if args.commit:
            log("[step] git commit")
            git_commit_if_needed(api_root, args.commit_message)
        else:
            log("[skip] git commit")

        log("[done] maintenance flow finished.")
        return 0
    except subprocess.CalledProcessError as exc:
        log(f"[fatal] command failed (exit={exc.returncode}): {exc.cmd}")
        return exc.returncode
    except Exception as exc:  # noqa: BLE001
        log(f"[fatal] {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

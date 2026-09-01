#!/usr/bin/env python3
"""omp-web-restart-service: a minimal, loopback-only trigger daemon.

Runs as its own systemd --user unit, independent of omp-web.service's cgroup,
so a POST /run request can kick off a fixed restart/upgrade script that is
detached from both this daemon and the calling HTTP request and survives
omp-web.service being torn down mid-restart (which sends SIGTERM to its
whole cgroup, including any shell that issued the restart from inside it).

See docs/fleet-deployment.md for the full protocol and the real gateway
self-upgrade recipe. This is intentionally a single fixed-script trigger,
not a generic task runner.

All configuration comes from the process environment, normally populated by
systemd's EnvironmentFile= on the unit:

  RESTART_SERVICE_TOKEN    required. Must match the X-Restart-Token header
                            on every POST /run. The daemon refuses to start
                            without this set.
  RESTART_SERVICE_PORT     optional, default 8799. Bind is always 127.0.0.1
                            — loopback-only by design, not configurable.
  RESTART_SERVICE_SCRIPT   optional, default ~/omp/ops/scripts/restart-payload.sh
  RESTART_SERVICE_LOG_DIR  optional, default ~/omp/ops/logs/restart-service
"""
from __future__ import annotations

import hmac
import json
import os
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
DEFAULT_PORT = 8799
DEFAULT_SCRIPT = os.path.expanduser("~/omp/ops/scripts/restart-payload.sh")
DEFAULT_LOG_DIR = os.path.expanduser("~/omp/ops/logs/restart-service")
LOG_TAIL_LINES = 50

TOKEN = os.environ.get("RESTART_SERVICE_TOKEN", "")
SCRIPT_PATH = os.environ.get("RESTART_SERVICE_SCRIPT", DEFAULT_SCRIPT)
LOG_DIR = Path(os.environ.get("RESTART_SERVICE_LOG_DIR", DEFAULT_LOG_DIR))
PORT = int(os.environ.get("RESTART_SERVICE_PORT", str(DEFAULT_PORT)))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RunInProgress(Exception):
    """Raised when /run is hit while a previous run hasn't finished."""


class RunState:
    """Tracks the single most recent (or currently in-flight) run.

    Only one run may be in flight at a time; `begin()` is the atomic
    check-and-claim that enforces that before anything is spawned.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running = False
        self.run_id: str | None = None
        self.pid: int | None = None
        self.exit_code: int | None = None
        self.started_at: str | None = None
        self.ended_at: str | None = None
        self.log_path: str | None = None

    def begin(self, run_id: str, log_path: str) -> bool:
        with self._lock:
            if self._running:
                return False
            self._running = True
            self.run_id = run_id
            self.pid = None
            self.exit_code = None
            self.started_at = _now_iso()
            self.ended_at = None
            self.log_path = log_path
            return True

    def set_pid(self, run_id: str, pid: int) -> None:
        with self._lock:
            if self.run_id == run_id:
                self.pid = pid

    def abort(self, run_id: str) -> None:
        """Spawn failed after begin() claimed the slot; release it."""
        with self._lock:
            if self.run_id == run_id:
                self._running = False

    def finish(self, run_id: str, exit_code: int) -> None:
        with self._lock:
            if self.run_id == run_id:
                self._running = False
                self.exit_code = exit_code
                self.ended_at = _now_iso()

    def snapshot(self) -> dict:
        with self._lock:
            log_path = self.log_path
            data = {
                "run_id": self.run_id,
                "pid": self.pid,
                "running": self._running,
                "exit_code": self.exit_code,
                "started_at": self.started_at,
                "ended_at": self.ended_at,
                "log_path": log_path,
            }
        data["log_tail"] = _tail(log_path, LOG_TAIL_LINES) if log_path else []
        return data


STATE = RunState()


def _tail(path: str, n: int) -> list[str]:
    try:
        with open(path, "r", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return []
    return [line.rstrip("\n") for line in lines[-n:]]


def _reap(run_id: str, proc: subprocess.Popen) -> None:
    exit_code = proc.wait()
    STATE.finish(run_id, exit_code)


def _start_run() -> dict:
    if not os.path.isfile(SCRIPT_PATH):
        raise FileNotFoundError(SCRIPT_PATH)

    run_id = "{}-{}".format(
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"), uuid.uuid4().hex[:8]
    )
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{run_id}.log"

    # Claim the "one run at a time" slot before spawning anything, so two
    # concurrent POST /run requests can never both start a process.
    if not STATE.begin(run_id, str(log_path)):
        raise RunInProgress()

    try:
        log_fh = open(log_path, "ab", buffering=0)
        try:
            proc = subprocess.Popen(
                ["bash", SCRIPT_PATH],
                stdin=subprocess.DEVNULL,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # own session: outlives this daemon too
            )
        finally:
            log_fh.close()
    except Exception:
        STATE.abort(run_id)
        raise

    STATE.set_pid(run_id, proc.pid)
    threading.Thread(target=_reap, args=(run_id, proc), daemon=True).start()
    return {"run_id": run_id, "pid": proc.pid}


class Handler(BaseHTTPRequestHandler):
    server_version = "omp-web-restart-service/1.0"

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/status":
            self._send_json(200, STATE.snapshot())
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/run":
            self._send_json(404, {"error": "not found"})
            return

        supplied = self.headers.get("X-Restart-Token", "")
        if not TOKEN or not hmac.compare_digest(supplied, TOKEN):
            self._send_json(401, {"error": "unauthorized"})
            return

        try:
            result = _start_run()
        except RunInProgress:
            self._send_json(409, {"error": "run already in progress", **STATE.snapshot()})
        except FileNotFoundError as exc:
            self._send_json(500, {"error": f"script not found: {exc}"})
        except Exception as exc:  # a bad script/spawn must never crash the daemon
            self._send_json(500, {"error": f"failed to start run: {exc}"})
        else:
            self._send_json(202, {"status": "started", **result})

    def log_message(self, fmt: str, *args) -> None:  # terse journald output
        sys.stderr.write(
            "%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), fmt % args)
        )


def main() -> None:
    if not TOKEN:
        print("RESTART_SERVICE_TOKEN is not set; refusing to start.", file=sys.stderr)
        sys.exit(1)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"omp-web-restart-service listening on {HOST}:{PORT}, script={SCRIPT_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

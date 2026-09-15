# Isolate validation subprocesses; never mutate the resident runner environment.
import json
import os
import pathlib
import subprocess
import sys
import tempfile

if len(sys.argv) < 2:
    raise SystemExit("Usage: run-isolated-validation.py <command> [args...]")

root = pathlib.Path(tempfile.mkdtemp(prefix="fly2557-validation-", dir="/tmp"))
(root / "home").mkdir()
env = {
    key: os.environ[key]
    for key in ("PATH", "TMPDIR", "LANG", "LC_ALL", "TERM")
    if key in os.environ
}
env.update({
    "HOME": str(root / "home"),
    "FLYWHEEL_CODEX_HOMES_ROOT": str(root / "codex-homes"),
    "FLYWHEEL_CODEX_SESSION_DIR": str(root / "codex-sessions"),
    "FLYWHEEL_COMM_DIR": str(root / "comm"),
    "VITEST_MAX_FORKS": "1",
    "CI": "true",
})
receipt = root / "receipt.json"
data = {
    "cwd": os.getcwd(),
    "command": sys.argv[1:],
    "isolatedRoot": str(root),
    "environmentKeys": sorted(env),
    "status": "running",
}
receipt.write_text(json.dumps(data, indent=2))
print("ISOLATION_RECEIPT=" + str(receipt), flush=True)
try:
    result = subprocess.run(sys.argv[1:], env=env)
except OSError as error:
    data.update(status="spawn_failed", error=str(error))
    receipt.write_text(json.dumps(data, indent=2))
    raise
data.update(status="finished", exitCode=result.returncode)
receipt.write_text(json.dumps(data, indent=2))
sys.exit(result.returncode)

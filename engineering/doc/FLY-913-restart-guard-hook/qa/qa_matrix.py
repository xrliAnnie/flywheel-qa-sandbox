import json, subprocess, sys, os, tempfile

HOOK = "scripts/hooks/flywheel-restart-guard.py"
# isolate audit log + neuter alert so bypass tests don't hit real Discord
LOG = tempfile.NamedTemporaryFile(delete=False, suffix=".log").name
env = dict(os.environ)
env["FLYWHEEL_RESTART_GUARD_LOG"] = LOG
env["FLYWHEEL_RESTART_GUARD_ALERT_CMD"] = "/bin/echo"  # prints nothing useful -> not sent/queued -> bypass denies

def run(cmd):
    payload = {"tool_name":"Bash","tool_input":{"command":cmd},"session_id":"qa","cwd":"/x"}
    r = subprocess.run(["python3",HOOK], input=json.dumps(payload), capture_output=True, text=True, env=env)
    out = (r.stdout or "").strip()
    if not out:
        return "ALLOW"
    try:
        d = json.loads(out)
        return d["hookSpecificOutput"]["permissionDecision"].upper()
    except Exception:
        return f"?? {out[:60]}"

# (label, command, expected)
CASES = [
  # --- P3 wrapper bypasses (this round's fixes) — must DENY ---
  ("sudo -E node run-bridge",       "sudo -E node scripts/run-bridge.ts", "DENY"),
  ("env node run-bridge",           "env node scripts/run-bridge.ts", "DENY"),
  ("nohup direct script",           "nohup scripts/run-bridge.ts &", "DENY"),
  ("env -S split-string",           "env -S 'node scripts/run-bridge.ts'", "DENY"),
  ("env --split-string=",           "env --split-string='node scripts/run-bridge.ts'", "DENY"),
  ("env -iS cluster",               "env -iS 'node scripts/run-bridge.ts'", "DENY"),
  ("env -P altpath",                "env -P /usr/bin node scripts/run-bridge.ts", "DENY"),
  # --- package-manager exec forms — must DENY ---
  ("pnpm tsx run-bridge",           "pnpm tsx scripts/run-bridge.ts", "DENY"),
  ("pnpm exec tsx run-bridge",      "pnpm exec tsx scripts/run-bridge.ts", "DENY"),
  ("npm exec tsx run-bridge",       "npm exec tsx scripts/run-bridge.ts", "DENY"),
  ("yarn tsx run-bridge",           "yarn tsx scripts/run-bridge.ts", "DENY"),
  ("pnpx run-bridge",               "pnpx tsx scripts/run-bridge.ts", "DENY"),
  ("bunx run-bridge",               "bunx tsx scripts/run-bridge.ts", "DENY"),
  ("corepack pnpm tsx run-bridge",  "corepack pnpm tsx scripts/run-bridge.ts", "DENY"),
  # --- shell/utility wrappers — must DENY ---
  ("command node run-bridge",       "command node scripts/run-bridge.ts", "DENY"),
  ("exec node run-bridge",          "exec node scripts/run-bridge.ts", "DENY"),
  ("time node run-bridge",          "time node scripts/run-bridge.ts", "DENY"),
  ("nice node run-bridge",          "nice -n 10 node scripts/run-bridge.ts", "DENY"),
  ("caffeinate node run-bridge",    "caffeinate node scripts/run-bridge.ts", "DENY"),
  ("timeout node run-bridge",       "timeout 30 node scripts/run-bridge.ts", "DENY"),
  ("setsid node run-bridge",        "setsid node scripts/run-bridge.ts", "DENY"),
  # --- shell -c merged clusters — must DENY ---
  ("bash -lc run-bridge",           "bash -lc 'node scripts/run-bridge.ts'", "DENY"),
  ("sh -lec run-bridge",            "sh -lec 'node scripts/run-bridge.ts'", "DENY"),
  # --- P1/P2 sanity — must DENY ---
  ("launchctl kickstart flywheel",  "launchctl kickstart -k gui/501/com.flywheel.bridge", "DENY"),
  ("pkill run-bridge",              "pkill -f run-bridge", "DENY"),
  ("pgrep|xargs kill run-bridge",   "pgrep -f run-bridge | xargs kill -9", "DENY"),
  ("cd && launchctl flywheel",      "cd /tmp && launchctl bootout gui/501/com.flywheel.lead.eng", "DENY"),
  # --- legit paths — must ALLOW ---
  ("restart-services.sh",           "bash ~/Dev/flywheel/scripts/restart-services.sh", "ALLOW"),
  ("restart-services --force",      "bash scripts/restart-services.sh --force", "ALLOW"),
  ("pnpm build",                    "pnpm build", "ALLOW"),
  ("pnpm run lint",                 "pnpm run lint", "ALLOW"),
  ("grep run-bridge (read)",        "grep -rn run-bridge scripts/", "ALLOW"),
  ("cat run-bridge (read)",         "cat scripts/run-bridge.ts", "ALLOW"),
  ("rg run-bridge (read)",          "rg run-bridge packages/", "ALLOW"),
  ("launchctl print (readonly)",    "launchctl print gui/501/com.flywheel.bridge", "ALLOW"),
  ("git commit unrelated",          "git commit -m 'restart run-bridge doc'", "ALLOW"),
  ("kill unrelated pid",            "kill -9 12345", "ALLOW"),
]

fails=0
for label,cmd,exp in CASES:
    got=run(cmd)
    ok = got==exp
    if not ok: fails+=1
    print(f"{'PASS' if ok else 'FAIL'}  [{exp:5}] {label:32} -> {got}")
print(f"\n{len(CASES)-fails}/{len(CASES)} passed, {fails} failed")
sys.exit(1 if fails else 0)

import json, subprocess, os, tempfile, textwrap, stat

HOOK = "scripts/hooks/flywheel-restart-guard.py"
BYPASS_CMD = "FLYWHEEL_RESTART_GUARD_BYPASS='prod incident, manual restart' launchctl kickstart -k gui/501/com.flywheel.bridge"

def run(cmd, alert_cmd, log_path):
    env = dict(os.environ)
    env["FLYWHEEL_RESTART_GUARD_LOG"] = log_path
    env["FLYWHEEL_RESTART_GUARD_ALERT_CMD"] = alert_cmd
    payload = {"tool_name":"Bash","tool_input":{"command":cmd},"session_id":"qa","cwd":"/x"}
    r = subprocess.run(["python3",HOOK], input=json.dumps(payload), capture_output=True, text=True, env=env)
    out=(r.stdout or "").strip()
    if not out: return "ALLOW"
    try: return json.loads(out)["hookSpecificOutput"]["permissionDecision"].upper()
    except Exception: return f"?? {out[:60]}"

# mock alert that prints "sent"
sent = tempfile.NamedTemporaryFile(delete=False, suffix=".sh", mode="w"); sent.write("#!/bin/bash\necho sent\n"); sent.close(); os.chmod(sent.name, 0o755)
# mock alert that prints "dead_lettered"
dead = tempfile.NamedTemporaryFile(delete=False, suffix=".sh", mode="w"); dead.write("#!/bin/bash\necho dead_lettered\n"); dead.close(); os.chmod(dead.name, 0o755)

fails=0
def check(label, got, exp, extra_ok=True):
    global fails
    ok = got==exp and extra_ok
    if not ok: fails+=1
    print(f"{'PASS' if ok else 'FAIL'}  {label:48} -> {got}  (exp {exp})")

# 1) valid bypass, alert=sent -> ALLOW, audit written
log1 = tempfile.NamedTemporaryFile(delete=False).name; os.remove(log1)
g = run(BYPASS_CMD, sent.name, log1)
audit_ok = os.path.exists(log1) and '"decision": "bypass"' in open(log1).read()
check("bypass + alert=sent -> ALLOW (audit written)", g, "ALLOW", audit_ok)

# 2) valid bypass, alert=dead_lettered -> DENY
log2 = tempfile.NamedTemporaryFile(delete=False).name
g = run(BYPASS_CMD, dead.name, log2)
check("bypass + alert=dead_lettered -> DENY", g, "DENY")

# 3) valid bypass, alert missing (nonexistent) -> DENY
log3 = tempfile.NamedTemporaryFile(delete=False).name
g = run(BYPASS_CMD, "/nonexistent/alert.sh", log3)
check("bypass + alert missing -> DENY", g, "DENY")

# 4) valid bypass but audit log unwritable -> DENY (fail-closed, alert never rescues)
unwritable = "/proc/nonexistent-dir/x.log"  # macOS: no /proc, mkdir fails
g = run(BYPASS_CMD, sent.name, unwritable)
check("bypass + audit unwritable -> DENY", g, "DENY")

# 5) fake bypass (echo prefix, not a real env assignment) -> DENY (still a hit)
log5 = tempfile.NamedTemporaryFile(delete=False).name
g = run("echo FLYWHEEL_RESTART_GUARD_BYPASS=x; launchctl kickstart gui/501/com.flywheel.bridge", sent.name, log5)
check("fake echo-prefix bypass -> DENY", g, "DENY")

# 6) empty-reason bypass -> DENY
log6 = tempfile.NamedTemporaryFile(delete=False).name
g = run("FLYWHEEL_RESTART_GUARD_BYPASS='' launchctl kickstart gui/501/com.flywheel.bridge", sent.name, log6)
check("empty-reason bypass -> DENY", g, "DENY")

print(f"\n{6-fails}/6 passed, {fails} failed")
import sys; sys.exit(1 if fails else 0)

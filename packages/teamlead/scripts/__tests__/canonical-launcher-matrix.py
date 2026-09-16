"""Run specialized launchers with fixture identity and a capture-only child."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

scripts = Path(__file__).resolve().parents[1]
root = Path(sys.argv[1]) / "launcher-matrix"
rt = root / "packages/teamlead"
for directory in ["scripts/lib", "dist/lead-backends/codex/gateway"]:
    (rt / directory).mkdir(parents=True)
for directory in ["packages/flywheel-comm/dist", "scripts/lib", "bin", "home"]:
    (root / directory).mkdir(parents=True)
for name in ["codex-lead-runtime.js", "codex-lead-tui-runtime.js", "gateway/gateway-main.js"]:
    (rt / "dist/lead-backends/codex" / name).write_text("// fixture only\n")
(root / "packages/flywheel-comm/dist/index.js").write_text("// fixture only\n")
(rt / "scripts/codex-lead-tui-home.sh").write_text("exit 0\n")
for source, target in [
    (scripts / "lib/canonical-lead-identity.sh", rt / "scripts/lib/canonical-lead-identity.sh"),
    (scripts / "lead-rules-bundle.sh", rt / "scripts/lead-rules-bundle.sh"),
    (scripts.parent / "lead-rules-base", rt / "lead-rules-base"),
    (scripts.parents[2] / "scripts/lib/lead-address.sh", root / "scripts/lib/lead-address.sh"),
]:
    target.symlink_to(source)
node = root / "bin/node"
node.write_text('''#!/bin/bash
case " $* " in
  *" lead-identity resolve "*) printf '%s\\n' "$MATRIX_IDENTITY" ;;
  *" lead-registry generic-codex-profile "*) echo full-access ;;
  *) printf '%s\\n' "${FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION-unset}" "${FLYWHEEL_CODEX_LEAD_SANDBOX-unset}" > "$MATRIX_OUTPUT" ;;
esac
''')
node.chmod(0o755)
failures = 0
for name in ["run-codex-infra-bot-tui.sh", "run-codex-lead-mufasa-tui-fullaccess.sh", "run-codex-lead-mufasa-tui.sh", "run-codex-lead-mufasa-fullaccess.sh", "run-codex-lead-mufasa-writecapable.sh"]:
    launcher = rt / "scripts" / name
    shutil.copyfile(scripts / name, launcher)
    for version in [1, 2]:
        infra = "infra-bot" in name
        lead = "codex-infra-bot-lead" if infra else "mufasa-lead"
        project = "flywheel" if infra else "growth"
        identity = dict(schemaVersion=1, codexCapabilities=dict(runnerActionsEnabled=False), leadId=lead, projectName=project, leadKey=f"{project}-{lead}", agentTeamName=lead, botUserId="12345678901234567", botTokenEnv="MATRIX_TOKEN", discordStateDir=str(root / "discord"), backend="codex-app-server", role="dept", summaryRole="exempt", summaryGranularity="per-lead", hasSummaryDuty=False, summaryAssignmentDigest="c"*64, projectsDigest="b"*64, identityDigest="a"*64)
        if version == 2:
            identity["codexCapabilities"]["capabilityBundleVersion"] = 2
        output = root / f"{name}.{version}.out"
        env = dict(PATH=f"{root / 'bin'}:{os.environ['PATH']}", HOME=str(root / "home"), MATRIX_IDENTITY=json.dumps(identity), MATRIX_TOKEN="fixture-token", MATRIX_OUTPUT=str(output), FLYWHEEL_TEAMLEAD_ROOT=str(rt), FLY224_WORKTREE=str(root), FLYWHEEL_LEAD_DRY_RUN="1", FLYWHEEL_CODEX_BIN="/usr/bin/true", FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID="C123", FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID="C456", FLYWHEEL_BRIDGE_URL="http://127.0.0.1:1", TEAMLEAD_API_TOKEN="fixture-token")
        result = subprocess.run(["/bin/bash", str(launcher)], env=env, capture_output=True, text=True, timeout=15)
        expected = ["2", "unset"] if version == 2 else ["unset", "read-only" if name == "run-codex-lead-mufasa-tui.sh" else "workspace-write"]
        actual = output.read_text().splitlines() if output.exists() else []
        if result.returncode or actual != expected:
            failures += 1
            print(f"FAIL {name} v{version}: child={actual}, expected={expected}, exit={result.returncode} {result.stderr}")
        else:
            print(f"PASS {name} v{version}")
assert failures == 0, f"{failures} launcher contracts failed"

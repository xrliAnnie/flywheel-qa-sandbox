"""Replay only FLY-2597's reviewed shared duties over the pinned OFF bundle."""
import hashlib
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE = "6556b07518eec4323cef2067b73b5a27081329d0"
HISTORICAL = "f022a0a7ee5a4cf42f590cbd0c90b12b84e2c854"
PATCH_HASH = "264fdb3fe18956ea507a190d65e55bef523adbb80da216664c1fc6bffa20499d"
RULES = "packages/teamlead/lead-rules-base/"
SOURCES = "engineering/doc/FLY-2567-lead-token-savings/evidence/rework-legacy-sources.json"
GOLDEN = "packages/teamlead/src/__tests__/fixtures/fly2567/legacy-bundle.json"


def git_bytes(revision, path):
    return subprocess.check_output(["git", "show", revision + ":" + path], cwd=ROOT)


def digest(content):
    return hashlib.sha256(content).hexdigest()


patch = pathlib.Path(__file__).with_name("attention-rules-evolution.patch").read_bytes()
if digest(patch) != PATCH_HASH:
    raise SystemExit("unexpected_attention_rule_patch")
sources = json.loads(git_bytes(BASE, SOURCES))
golden = json.loads(git_bytes(BASE, GOLDEN))
with tempfile.TemporaryDirectory(prefix="fly2597-rule-replay-") as directory:
    temporary = pathlib.Path(directory)
    paths = subprocess.check_output([
        "git", "ls-tree", "-r", "--name-only", HISTORICAL,
        RULES, "packages/teamlead/scripts/lead-rules-bundle.sh",
        "packages/teamlead/scripts/inbox-ack-rule.md",
    ], cwd=ROOT, text=True).splitlines()
    for path in paths:
        target = temporary / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git_bytes(HISTORICAL, path))
    # The baseline includes the previously approved FLY-2557 intake overlay.
    for name in ["department-lead-rules.md", "runner-messaging-rules.md", "runner-patrol-rules.md"]:
        (temporary / RULES / name).write_bytes(git_bytes(BASE, RULES + "legacy-token-savings/" + name))
    (temporary / "packages/teamlead/scripts/inbox-ack-rule.md").write_bytes(
        git_bytes(BASE, RULES + "legacy-token-savings/inbox-ack-rule.md"))

    def capture():
        script = ('source "$1/scripts/lead-rules-bundle.sh"; '
                  'FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1; rules_bundle_reset; '
                  'while IFS= read -r path; do rules_bundle_add "$path" governance || exit $?; '
                  'done < <(compute_lead_rule_bundle dept "$1/lead-rules-base" mailbox 1); '
                  'rules_bundle_add "$1/scripts/inbox-ack-rule.md" launcher || exit $?; '
                  'rules_bundle_materialize "$2" dept fixture flywheel')
        output = temporary / "bundle.md"
        subprocess.check_output(["bash", "-c", script, "fixture",
                                 str(temporary / "packages/teamlead"), str(output)])
        data = output.read_bytes()
        return data[data.index("═══ RULE SOURCE".encode()):]

    before = capture()
    if len(before) != golden["bodyBytes"] or digest(before) != golden["sha256"]:
        raise SystemExit("historical_bundle_baseline_mismatch")
    subprocess.run(["git", "apply", "-"], cwd=temporary, input=patch, check=True)
    for name in ["department-lead-rules.md", "runner-patrol-rules.md"]:
        replayed = (temporary / RULES / name).read_bytes()
        if replayed != (ROOT / RULES / "legacy-token-savings" / name).read_bytes():
            raise SystemExit("off_source_not_exact_reviewed_evolution: " + name)
        entry = next(item for item in sources["sources"] if item["path"] == RULES + name)
        entry.update(bytes=len(replayed), sha256=digest(replayed))
    after = capture()
    evolution = {
        "base": BASE, "patchSha256": PATCH_HASH,
        "beforeBundleSha256": digest(before), "afterBundleSha256": digest(after),
        "meaning": "FLY-2597 approved plan: identical explicit founder attention and quiet receipt duties in ON/OFF; all other historical bytes preserved.",
    }
    sources["attentionEvolution"] = evolution
    golden.update(bodyBytes=len(after), sha256=digest(after), attentionEvolution=evolution)
    golden["meaning"] += " FLY-2597 shared attention/quiet receipt patch replayed over that baseline."
    (ROOT / SOURCES).write_text(json.dumps(sources, indent=2) + "\n")
    (ROOT / GOLDEN).write_text(json.dumps(golden, indent="\t") + "\n")
    print(json.dumps(evolution, indent=2))

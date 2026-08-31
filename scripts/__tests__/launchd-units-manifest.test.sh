#!/usr/bin/env bash
# FLY-1814 D1: close the repo-owned launchd plist set against units.manifest.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$REPO_ROOT/scripts/launchd/units.manifest"
LAUNCHD_DIR="$REPO_ROOT/scripts/launchd"
CONVERGE_LIB="$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh"

if [[ ! -r "$MANIFEST" ]]; then
  printf 'FAIL: units manifest is missing or unreadable: %s\n' "$MANIFEST" >&2
  exit 1
fi

# Runtime Bash is the manifest grammar authority used by convergence. Keep the
# broader repository-closure checks below, but never let this suite bless a
# manifest that production itself rejects.
# shellcheck source=../lib/converge-nonlead-daemons.sh
source "$CONVERGE_LIB"
if ! _cnd_load_manifest "$MANIFEST"; then
  printf 'FAIL: production manifest parser rejected units.manifest: %s\n' \
    "${_CND_MANIFEST_ERROR:-unknown parser failure}" >&2
  exit 1
fi

if ! python3 - "$MANIFEST" "$LAUNCHD_DIR" "$REPO_ROOT" "$CONVERGE_LIB" <<'PY'
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile


manifest_path = pathlib.Path(sys.argv[1])
launchd_dir = pathlib.Path(sys.argv[2])
repo_root = pathlib.Path(sys.argv[3])
converge_lib = pathlib.Path(sys.argv[4])


class InvalidManifest(ValueError):
    pass


def reject(condition, message):
    if condition:
        raise InvalidManifest(message)


def parse_manifest_text(text):
    reject("\r" in text, "CR bytes are not Bash-3.2-friendly")
    host_prefixes = []
    census_scopes = []
    rows = []

    for line_number, line in enumerate(text.splitlines(), 1):
        if not line:
            continue
        if line.startswith("#"):
            host_match = re.fullmatch(r"# host-prefix: (\S+)", line)
            scope_match = re.fullmatch(r"# census-scope: (\S+)", line)
            if line.startswith("# host-prefix"):
                reject(host_match is None, f"line {line_number}: malformed host-prefix declaration")
            if line.startswith("# census-scope"):
                reject(scope_match is None, f"line {line_number}: malformed census-scope declaration")
            if host_match:
                host_prefixes.append(host_match.group(1))
            if scope_match:
                census_scopes.append(scope_match.group(1))
            continue

        fields = line.split("\t")
        reject(len(fields) != 5, f"line {line_number}: expected exactly five TSV fields")
        reject(any(field == "" for field in fields), f"line {line_number}: empty field")
        label, plist_source, policy, allowed_exits, note = fields

        reject(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", label) is None
            or "." not in label
            or ".." in label,
            f"line {line_number}: invalid label {label!r}",
        )
        reject(label.startswith("com.flywheel.lead."), f"line {line_number}: Lead family is excluded")
        reject(
            plist_source != "-"
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*\.plist", plist_source) is None,
            f"line {line_number}: invalid plist basename {plist_source!r}",
        )
        reject(policy not in {"copy", "setup", "external", "managed", "hold"},
               f"line {line_number}: unknown policy {policy!r}")
        if policy == "external":
            reject(plist_source != "-", f"line {line_number}: external source must be '-'")
            reject(allowed_exits != "*", f"line {line_number}: external exits must be informational-only '*'")
            reject("informational-only" not in note,
                   f"line {line_number}: external note must say informational-only")
        else:
            reject(
                re.fullmatch(r"(?:0|[1-9][0-9]*)(?:,(?:0|[1-9][0-9]*))*", allowed_exits) is None,
                f"line {line_number}: invalid allowed exits {allowed_exits!r}",
            )
            reject("0" not in allowed_exits.split(","),
                   f"line {line_number}: allowed exits must contain 0")
        rows.append({
            "line": line_number,
            "label": label,
            "source": plist_source,
            "policy": policy,
            "exits": allowed_exits,
            "note": note,
        })

    reject(len(host_prefixes) != 1, "manifest must declare exactly one host-prefix")
    host_prefix = host_prefixes[0]
    reject(
        re.fullmatch(r"/(?:[A-Za-z0-9._+-]+/)+", host_prefix) is None
        or "//" in host_prefix
        or "/../" in host_prefix
        or "/./" in host_prefix,
        f"invalid host-prefix {host_prefix!r}",
    )
    reject(not census_scopes, "manifest must declare at least one census-scope")
    reject(len(census_scopes) != len(set(census_scopes)), "duplicate census-scope declaration")
    for scope in census_scopes:
        reject(
            re.fullmatch(r"[A-Za-z][A-Za-z0-9.-]*", scope) is None
            or "." not in scope
            or ".." in scope
            or scope.endswith("-"),
            f"invalid census-scope {scope!r}",
        )

    labels = [row["label"] for row in rows]
    reject(len(labels) != len(set(labels)), "duplicate manifest label")
    return host_prefix, census_scopes, rows


def plist_data(path):
    try:
        with path.open("rb") as handle:
            return plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException) as exc:
        raise InvalidManifest(f"invalid plist {path.name}: {exc}") from exc


def resolve_plist_payload(path):
    """Ask the production tri-state resolver; never interpret command text here."""
    completed = subprocess.run(
        [
            "/bin/bash",
            "-c",
            'source "$1"; launchd_plist_program_target "$2"; '
            'printf "%s\\t%s\\n" "$LAUNCHD_PROGRAM_STATE" "$LAUNCHD_PROGRAM_TARGET"',
            "launchd-manifest-resolver",
            str(converge_lib),
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    reject(completed.returncode != 0,
           f"{path.name}: production resolver failed: {completed.stderr.strip()}")
    state, separator, target = completed.stdout.rstrip("\n").partition("\t")
    reject(not separator or state != "resolved" or not target,
           f"{path.name}: production resolver returned {state or 'invalid-output'}")
    return target


def checkout_path_for_payload(payload, host_prefix):
    reject(any(segment in {".", ".."} for segment in payload.split("/")),
           f"payload contains a forbidden path segment: {payload}")
    if payload.startswith("~/"):
        # Home payloads are external to the checkout. Returning None prevents
        # the CI remap from pretending they are repo files.
        return None
    reject(not payload.startswith("/"), f"payload is not absolute: {payload}")
    reject(not payload.startswith(host_prefix),
           f"absolute payload is outside declared host-prefix: {payload}")
    repo_resolved = repo_root.resolve(strict=False)
    candidate = (repo_root / payload[len(host_prefix):]).resolve(strict=False)
    try:
        candidate.relative_to(repo_resolved)
    except ValueError as exc:
        raise InvalidManifest(f"remapped payload escapes repository: {payload}") from exc
    return candidate


def validate_repo_manifest(text):
    host_prefix, census_scopes, rows = parse_manifest_text(text)
    by_label = {row["label"]: row for row in rows}

    expected = {
        "com.flywheel.updater": ("com.flywheel.updater.plist", "copy", "0,1,2,3,127,130", None),
        "com.flywheel.daily-standup": ("com.flywheel.daily-standup.plist", "copy", "0,1", None),
        "com.flywheel.token-usage-daily": ("com.flywheel.token-usage-daily.plist", "copy", "0", None),
        "com.flywheel.bridge-liveness-probe": ("com.flywheel.bridge-liveness-probe.plist", "copy", "0", None),
        "com.flywheel.codex-log-guard": ("com.flywheel.codex-log-guard.plist", "copy", "0", "never-installed-copy-exception"),
        # FLY-1929: IPC-voucher watcher (panic recurrence + remediation health).
        # policy=copy so the checked-in bytes stay authoritative and the existing
        # non-Lead convergence path installs/bootstraps it — no second installer.
        "com.flywheel.voucher-watch": ("com.flywheel.voucher-watch.plist", "copy", "0", "repo plist is byte authority"),
        "com.flywheel.daily-digest": ("com.flywheel.daily-digest.plist", "hold", "0", "pending-founder-optin"),
        "com.flywheel.xiaohongshu-learning": ("com.flywheel.xiaohongshu-learning.plist", "hold", "0", "founder-gated-pilot"),
        "com.flywheel.meeting-notes": ("com.flywheel.meeting-notes.plist", "hold", "0", "pre-ship-live-pilot-hard-gate-before-install"),
        "com.flywheel.bridge": ("com.flywheel.bridge.plist", "setup", "0", None),
        "com.flywheel.quota-monitor": ("-", "setup", "0", None),
        "com.flywheel.cmux-watcher": ("-", "setup", "0", None),
        "com.flywheel.growth-improve": ("-", "external", "*", "informational-only"),
        "com.flywheel.growth-learn": ("-", "external", "*", "informational-only"),
        "com.flywheel.growth-report": ("-", "external", "*", "informational-only"),
        "com.flywheel.growth-retro": ("-", "external", "*", "informational-only"),
        "com.flywheel.sub-create-nightly": ("-", "external", "*", "informational-only"),
        "com.flywheel.sub-daily-loop": ("-", "external", "*", "informational-only"),
        "com.flywheel.skills-update": ("-", "external", "*", "informational-only"),
        "com.flywheel.voice-bridge": ("com.flywheel.voice-bridge.plist", "managed", "0", None),
    }
    reject(set(by_label) != set(expected),
           f"manifest labels differ from approved initial set: {sorted(set(by_label) ^ set(expected))}")
    for label, (source, policy, exits, note_fragment) in expected.items():
        row = by_label[label]
        reject((row["source"], row["policy"], row["exits"]) != (source, policy, exits),
               f"{label}: expected {(source, policy, exits)}, got {(row['source'], row['policy'], row['exits'])}")
        if note_fragment:
            reject(note_fragment not in row["note"], f"{label}: note must contain {note_fragment!r}")

    manifest_sources = {row["source"] for row in rows if row["source"] != "-"}
    repo_sources = {path.name for path in launchd_dir.glob("*.plist")}
    reject(manifest_sources != repo_sources,
           f"manifest/plist closure mismatch: only-manifest={sorted(manifest_sources - repo_sources)} "
           f"only-directory={sorted(repo_sources - manifest_sources)}")

    resolved = {}
    for row in rows:
        if row["source"] == "-":
            continue
        source_path = launchd_dir / row["source"]
        reject(not source_path.is_file(), f"missing plist source {row['source']}")
        data = plist_data(source_path)
        reject(data.get("Label") != row["label"],
               f"{row['source']}: internal Label {data.get('Label')!r} does not match {row['label']!r}")
        if row["policy"] != "copy":
            continue
        payload = resolve_plist_payload(source_path)
        resolved[row["label"]] = payload
        checkout_payload = checkout_path_for_payload(payload, host_prefix)
        if checkout_payload is None:
            continue
        reject(not checkout_payload.is_file(),
               f"{row['label']}: remapped repo payload does not exist: {checkout_payload}")

    expected_liveness = host_prefix + "scripts/bridge-liveness-probe.sh"
    reject(resolved.get("com.flywheel.bridge-liveness-probe") != expected_liveness,
           "liveness shell -c inline exec did not resolve to its literal repo payload")
    return host_prefix, census_scopes, rows


text = manifest_path.read_text(encoding="utf-8")
host_prefix, census_scopes, rows = validate_repo_manifest(text)

# Negative controls prove the validator fails closed for malformed/unknown
# fields instead of merely accepting today's checked-in bytes.
lines = text.splitlines()
row_index = next(index for index, line in enumerate(lines) if line and not line.startswith("#"))
base_fields = lines[row_index].split("\t")


def expect_rejected(name, mutated_lines):
    try:
        parse_manifest_text("\n".join(mutated_lines) + "\n")
    except InvalidManifest:
        return
    raise InvalidManifest(f"negative control was accepted: {name}")


mutated = list(lines)
mutated[row_index] = "\t".join(base_fields[:4])
expect_rejected("four fields", mutated)

for field_index, field_name in enumerate(("label", "source", "policy", "exits", "note")):
    mutated = list(lines)
    fields = list(base_fields)
    fields[field_index] = ""
    mutated[row_index] = "\t".join(fields)
    expect_rejected(f"empty {field_name}", mutated)

mutated = list(lines)
fields = list(base_fields)
fields[2] = "unknown-policy"
mutated[row_index] = "\t".join(fields)
expect_rejected("unknown policy", mutated)

mutated = list(lines)
fields = list(base_fields)
fields[3] = "7"
mutated[row_index] = "\t".join(fields)
expect_rejected("exit set missing zero", mutated)

mutated = list(lines)
mutated.append(lines[row_index])
expect_rejected("duplicate label", mutated)

mutated = list(lines)
host_index = next(index for index, line in enumerate(mutated) if line.startswith("# host-prefix:"))
mutated[host_index] = "# host-prefix: relative/repo/"
expect_rejected("relative host-prefix", mutated)

mutated = list(lines)
mutated.insert(host_index + 1, lines[host_index])
expect_rejected("duplicate host-prefix", mutated)

scope_index = next(index for index, line in enumerate(lines) if line.startswith("# census-scope:"))
mutated = list(lines)
mutated[scope_index] = "# census-scope: bad scope"
expect_rejected("invalid census-scope", mutated)

mutated = list(lines)
mutated.insert(scope_index + 1, lines[scope_index])
expect_rejected("duplicate census-scope", mutated)

try:
    checkout_path_for_payload("/another/host/repo/scripts/job.sh", host_prefix)
except InvalidManifest:
    pass
else:
    raise InvalidManifest("unmatched absolute host prefix was accepted")

reject(checkout_path_for_payload("~/.flywheel/bin/external-job.sh", host_prefix) is not None,
       "external home payload was remapped into the checkout")

# Full-validator fixture controls exercise plist parsing, Label/source closure,
# executable selection, payload resolution, and repo remapping together. The
# fixture contains the complete real manifest/plist set and only mutates the
# named behavior under test.
real_launchd_dir = launchd_dir


def mutate_plist(fixture_launchd, source, mutation):
    path = fixture_launchd / source
    data = plist_data(path)
    mutation(data)
    with path.open("wb") as handle:
        plistlib.dump(data, handle, sort_keys=False)


def expect_full_validation(name, expected_error, mutation):
    global launchd_dir, repo_root
    with tempfile.TemporaryDirectory(prefix="launchd-manifest-mutant-") as temp_dir:
        fixture_root = pathlib.Path(temp_dir) / "repo"
        fixture_launchd = fixture_root / "scripts" / "launchd"
        shutil.copytree(real_launchd_dir, fixture_launchd)

        # Materialize only the current copy-row payloads. Their contents are
        # inert sentinels; validation may check existence but must never run
        # plist content.
        for row in rows:
            if row["policy"] != "copy":
                continue
            payload = resolve_plist_payload(fixture_launchd / row["source"])
            if payload.startswith(host_prefix):
                target = fixture_root / payload[len(host_prefix):]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture payload; must not execute\n", encoding="utf-8")

        execution_sentinel = fixture_root / "PLIST_CONTENT_WAS_EXECUTED"
        mutation(fixture_root, fixture_launchd, execution_sentinel)
        old_launchd_dir, old_repo_root = launchd_dir, repo_root
        launchd_dir, repo_root = fixture_launchd, fixture_root
        try:
            try:
                validate_repo_manifest(text)
            except InvalidManifest as exc:
                rejection = str(exc)
            else:
                rejection = None
        finally:
            launchd_dir, repo_root = old_launchd_dir, old_repo_root

        reject(execution_sentinel.exists(),
               f"{name}: validator executed plist-controlled content")
        if expected_error is None:
            reject(rejection is not None,
                   f"full validator positive control was rejected ({name}): {rejection}")
        else:
            reject(rejection is None, f"full validator negative control was accepted: {name}")
            reject(expected_error not in rejection,
                   f"{name}: rejected for the wrong reason: {rejection}")


def add_program(_root, fixture_launchd, _sentinel):
    mutate_plist(
        fixture_launchd,
        "com.flywheel.updater.plist",
        lambda data: data.__setitem__("Program", "/bin/false"),
    )


def add_bundle_program(_root, fixture_launchd, _sentinel):
    mutate_plist(
        fixture_launchd,
        "com.flywheel.updater.plist",
        lambda data: data.__setitem__("BundleProgram", "Contents/MacOS/updater"),
    )


def add_parent_traversal(fixture_root, fixture_launchd, _sentinel):
    (fixture_root / "escape.sh").write_text("inert\n", encoding="utf-8")

    def mutation(data):
        data["ProgramArguments"][1] = host_prefix + "scripts/../escape.sh"

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_dot_segment(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][1] = host_prefix + "scripts/./update-flywheel.sh"

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_symlink_escape(fixture_root, _fixture_launchd, _sentinel):
    outside = fixture_root.parent / "outside-repo.sh"
    outside.write_text("inert\n", encoding="utf-8")
    payload = fixture_root / "scripts" / "update-flywheel.sh"
    payload.unlink()
    payload.symlink_to(outside)


def mismatch_label(_root, fixture_launchd, _sentinel):
    mutate_plist(
        fixture_launchd,
        "com.flywheel.updater.plist",
        lambda data: data.__setitem__("Label", "com.flywheel.not-updater"),
    )


def add_dynamic_shell_path(_root, fixture_launchd, sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"touch {sentinel}; exec \"$HOME/.flywheel/bin/bridge-liveness-probe.sh\""
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_unsupported_interpreter(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][0] = "/usr/bin/ruby"

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_node_shell_c(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"] = [
            "node",
            "-c",
            f"exec {host_prefix}scripts/update-flywheel.sh",
        ]

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_python_shell_c(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"] = [
            "python3",
            "-c",
            f"exec {host_prefix}scripts/update-flywheel.sh",
        ]

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_env_ambiguity(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"] = [
            "/usr/bin/env",
            "-c",
            f"exec {host_prefix}scripts/update-flywheel.sh",
        ]

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_unapproved_bare_shell(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"] = [
            "bash",
            "-c",
            f"exec {host_prefix}scripts/update-flywheel.sh",
        ]

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_direct_node(fixture_root, fixture_launchd, _sentinel):
    (fixture_root / "scripts" / "direct-node-fixture.js").write_text(
        "// inert fixture; must not execute\n", encoding="utf-8"
    )

    def mutation(data):
        data["ProgramArguments"] = [
            "node",
            host_prefix + "scripts/direct-node-fixture.js",
            "--inert-fixture-argument",
        ]

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_direct_python(fixture_root, fixture_launchd, _sentinel):
    (fixture_root / "scripts" / "direct-python-fixture.py").write_text(
        "# inert fixture; must not execute\n", encoding="utf-8"
    )

    def mutation(data):
        data["ProgramArguments"] = [
            "python3",
            host_prefix + "scripts/direct-python-fixture.py",
            "--inert-fixture-argument",
        ]

    mutate_plist(fixture_launchd, "com.flywheel.updater.plist", mutation)


def add_ambiguous_exec_targets(_root, fixture_launchd, sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"touch {sentinel}; exec {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_and_hidden_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"prep && exec {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_control_hidden_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"if true; then exec {host_prefix}scripts/bridge-liveness-probe.sh; fi; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_quoted_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'"exec" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_escaped_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"\\exec {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_split_quoted_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'e"xe"c {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_ansi_c_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"$'exec' {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_ansi_c_split_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"e$'xe'c {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_locale_exec_targets(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'$"exec" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_dynamic_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"x=exec; $x {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_quoted_dynamic_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; "$x" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_braced_dynamic_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"x=exec; ${{x}} {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_substitution_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"$(printf ex%s ec) {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_backtick_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"`printf ex%s ec` {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_redirect_dynamic_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"x=exec; >/dev/null $x {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_fd_redirect_dynamic_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"x=exec; 2>/dev/null $x {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_spaced_redirect_dynamic_command_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f"x=exec; > /dev/null $x {host_prefix}scripts/bridge-liveness-probe.sh; "
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_command_forwarding_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; command "$x" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_builtin_forwarding_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; builtin "$x" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_env_forwarding_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; env "$x" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_usr_bin_env_forwarding_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; /usr/bin/env "$x" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_bin_env_forwarding_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; /bin/env "$x" {host_prefix}scripts/bridge-liveness-probe.sh; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


def add_eval_forwarding_target(_root, fixture_launchd, _sentinel):
    def mutation(data):
        data["ProgramArguments"][2] = (
            f'x=exec; eval "$x {host_prefix}scripts/bridge-liveness-probe.sh"; '
            f"exec {host_prefix}scripts/update-flywheel.sh"
        )

    mutate_plist(fixture_launchd, "com.flywheel.bridge-liveness-probe.plist", mutation)


for mutant_name, expected_error, mutant in (
    ("Node -c is not shell execution", "production resolver returned unknown", add_node_shell_c),
    ("Python -c is not shell execution", "production resolver returned unknown", add_python_shell_c),
    ("env interpreter ambiguity", "production resolver returned unknown", add_env_ambiguity),
    ("unapproved bare shell", "production resolver returned unknown", add_unapproved_bare_shell),
    ("Program conflicts with ProgramArguments", "production resolver returned unknown", add_program),
    ("BundleProgram conflicts with ProgramArguments", "production resolver returned unknown", add_bundle_program),
    ("parent traversal payload", "production resolver returned unknown", add_parent_traversal),
    ("dot-segment payload", "production resolver returned unknown", add_dot_segment),
    ("symlink payload escapes repo", "remapped payload escapes repository", add_symlink_escape),
    ("plist Label mismatch", "internal Label", mismatch_label),
    ("dynamic shell payload", "production resolver returned unknown", add_dynamic_shell_path),
    ("unsupported interpreter", "production resolver returned unknown", add_unsupported_interpreter),
    ("multiple ambiguous exec targets", "production resolver returned unknown", add_ambiguous_exec_targets),
    ("and-hidden ambiguous exec targets", "production resolver returned unknown", add_and_hidden_exec_targets),
    ("control-hidden ambiguous exec targets", "production resolver returned unknown", add_control_hidden_exec_targets),
    ("quoted ambiguous exec targets", "production resolver returned unknown", add_quoted_exec_targets),
    ("escaped ambiguous exec targets", "production resolver returned unknown", add_escaped_exec_targets),
    ("split-quoted ambiguous exec targets", "production resolver returned unknown", add_split_quoted_exec_targets),
    ("ANSI-C quoted ambiguous exec targets", "production resolver returned unknown", add_ansi_c_exec_targets),
    ("ANSI-C split-quoted ambiguous exec targets", "production resolver returned unknown", add_ansi_c_split_exec_targets),
    ("locale-quoted ambiguous exec targets", "production resolver returned unknown", add_locale_exec_targets),
    ("dynamic command target", "production resolver returned unknown", add_dynamic_command_target),
    ("quoted dynamic command target", "production resolver returned unknown", add_quoted_dynamic_command_target),
    ("braced dynamic command target", "production resolver returned unknown", add_braced_dynamic_command_target),
    ("command-substitution target", "production resolver returned unknown", add_substitution_command_target),
    ("backtick-substitution target", "production resolver returned unknown", add_backtick_command_target),
    ("redirected dynamic command target", "production resolver returned unknown", add_redirect_dynamic_command_target),
    ("fd-redirected dynamic command target", "production resolver returned unknown", add_fd_redirect_dynamic_command_target),
    ("spaced-redirect dynamic command target", "production resolver returned unknown", add_spaced_redirect_dynamic_command_target),
    ("command forwarding target", "production resolver returned unknown", add_command_forwarding_target),
    ("builtin forwarding target", "production resolver returned unknown", add_builtin_forwarding_target),
    ("env forwarding target", "production resolver returned unknown", add_env_forwarding_target),
    ("/usr/bin/env forwarding target", "production resolver returned unknown", add_usr_bin_env_forwarding_target),
    ("/bin/env forwarding target", "production resolver returned unknown", add_bin_env_forwarding_target),
    ("eval forwarding target", "production resolver returned unknown", add_eval_forwarding_target),
):
    expect_full_validation(mutant_name, expected_error, mutant)

for mutant_name, mutant in (
    ("direct Node script", add_direct_node),
    ("direct Python script", add_direct_python),
):
    expect_full_validation(mutant_name, None, mutant)

print(
    "PASS: launchd manifest is closed and valid "
    f"({len(rows)} rows, {len(census_scopes)} census scopes, host-prefix={host_prefix})"
)
PY
then
  echo "FAIL: launchd units manifest validator rejected the repository state" >&2
  exit 1
fi

# Packaging recursively carries scripts/launchd; these old file-level entries
# would be stale hard failures (or redundant allowlist entries) after the move.
if ! po_script_files="$(env PACKAGE_ONBOARD_SOURCED=1 bash -c \
  'source "$1"; printf "%s\n" "$PO_SCRIPT_FILES"' \
  _ "$REPO_ROOT/scripts/package-onboard.sh")"; then
  echo "FAIL: could not read package-onboard PO_SCRIPT_FILES" >&2
  exit 1
fi
if printf '%s\n' "$po_script_files" \
  | grep -Eq '^com\.flywheel\.(daily-standup|updater)\.plist$'; then
  echo "FAIL: moved launchd basenames remain in PO_SCRIPT_FILES" >&2
  exit 1
fi
if grep -Eq '^scripts/com\.flywheel\.(daily-standup|updater)\.plist$' \
  "$REPO_ROOT/scripts/package-onboard-files.allow"; then
  echo "FAIL: moved launchd paths remain in package-onboard-files.allow" >&2
  exit 1
fi

stale_reference_files=(
  "$REPO_ROOT/scripts/package-onboard.sh"
  "$REPO_ROOT/scripts/package-onboard-files.allow"
  "$REPO_ROOT/scripts/r4/r4-window.sh"
  "$REPO_ROOT/packages/token-usage/README.md"
  "$REPO_ROOT/doc/engineer/implementation/FLY-222-a0-a10-runbook.md"
)
if grep -En 'scripts/com\.flywheel\.(updater|daily-standup|token-usage-daily|daily-digest|xiaohongshu-learning)\.plist' \
  "${stale_reference_files[@]}"; then
  echo "FAIL: an operational or runbook reference still uses the pre-consolidation path" >&2
  exit 1
fi

echo "PASS: package-onboard relies on the scripts/launchd recursive asset directory"

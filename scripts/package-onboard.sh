#!/usr/bin/env bash
# FLY-1062 P0: package-onboard.sh — the channel-agnostic packaging pipeline.
#
# Assembles the monorepo into ONE payload tarball a customer machine can
# `npm install` with ZERO repository access and ZERO TypeScript at runtime:
#   1. whitelist tree assembly — curated scripts/ subset + agents/ runtime
#      prompts + each runtime workspace package (package.json + dist + runtime
#      assets) physically placed at node_modules/<npm-name>/;
#   2. workspace packages embedded via bundleDependencies AND matching
#      `file:node_modules/<name>` dependencies entries (npm pack only includes
#      node_modules content for bundled deps declared BOTH ways — verified
#      against real npm during design review, Codex R1#4);
#   3. third-party dependency UNION generated programmatically into the payload
#      package.json — any version conflict FAILS the build (align by hand);
#   4. run-bridge entry compiled to dist/run-bridge.js (imports rewritten from
#      ../packages/<dir>/dist → ../node_modules/<name>/dist, types stripped);
#   5. `.flywheel-prebuilt` sentinel (content = version) at the tree root —
#      every packaged-mode runtime branch keys off this file;
#   6. release security gates (also run standalone in CI): secret scan +
#      explicit path allowlist snapshot + zero .ts/src/__tests__/doc/.git +
#      the zero-repo-access invariant (no unregistered private-repo slug or
#      `git clone` in the release tree — registered occurrences live in
#      scripts/packaged/audit-grep-allowlist.tsv and each carries a
#      behavioral test; see the packaged-path audit table).
#
# The payload is NOT the customer-facing npm package: the public thin shell
# (packages/onboard-shell) exchanges a license key for this tarball via the
# gated endpoint (P3/P4). The payload name is internal and never published to
# a public registry.
#
# Sourceable for tests via PACKAGE_ONBOARD_SOURCED=1 (fixture monorepos may
# override PO_PACKAGES / PO_SCRIPT_FILES / PO_SCRIPT_DIRS / PO_AGENT_FILES).
set -uo pipefail

PO_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

po_log() { echo "[package-onboard] $*"; }
po_err() { echo "[package-onboard][error] $*" >&2; }
po_die() { po_err "$*"; exit 1; }

# ── policy: what goes into the payload ─────────────────────────────────────
# Runtime workspace packages (directory names under packages/). This is the
# closure of the customer MVP runtime (Bridge + Lead + Buddy + comm CLIs +
# MCP servers) — see research.md §1/§2. qa-framework / flywheel-cli / voice-*
# are deliberately NOT customer runtime.
PO_PACKAGES=${PO_PACKAGES:-"teamlead edge-worker core config flywheel-comm claude-runner dag-resolver agent-team-transport inbox-mcp terminal-mcp token-usage github-event-transport linear-event-transport slack-event-transport"}

# Extra runtime asset dirs per package (beyond package.json + dist/), colon
# separated as <pkg-dir>:<asset-dir>. claude-lead.sh + Lead runtime read these
# from the packages/teamlead tree at runtime.
PO_PACKAGE_ASSETS=${PO_PACKAGE_ASSETS:-"teamlead:scripts teamlead:prompts teamlead:lead-rules-base teamlead:static"}

# Curated scripts/ whitelist — EXPLICIT file list, not an ignore list. Every
# entry here must have a row in the packaged-path audit table
# (engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md).
PO_SCRIPT_FILES=${PO_SCRIPT_FILES:-"flywheel-onboard.sh
flywheel-buddy.sh
flywheel-buddy-steps.sh
flywheel-setup.sh
provision-fleet-host.sh
daily-standup.sh
flywheel-bridge-wrapper.sh
flywheel-lead-wrapper.sh
update-flywheel.sh
converge-flywheel-bin.sh
linux-preflight.sh
materialize-lead-manifests.sh
com.flywheel.daily-standup.plist
com.flywheel.updater.plist
lib/buddy-escalate.sh
lib/buddy-captain-preview.sh
lib/buddy-connect.sh
lib/fleet-sanitize.sh
lib/host-config.sh
lib/platform-deps.sh
lib/script-sanity.sh
lib/supervisor.sh
lib/bridge-port.sh
lib/self-ship-queue.sh
packaged/create-compat-mirror.sh
packaged/bootstrap-services.sh
packaged/restart-packaged-services.sh"}

# Whole asset dirs under scripts/ copied recursively.
PO_SCRIPT_DIRS=${PO_SCRIPT_DIRS:-"lib/agent-cli-providers
lib/buddy-connectors
buddy
launchd"}

# Runtime prompt assets at the repo root — run-infra.ts resolves the repo root
# by the agents/generic-executor.md sentinel; a payload without it boots the
# Bridge but fails on first dispatch (Codex R1#3).
PO_AGENT_FILES=${PO_AGENT_FILES:-"generic-executor.md
qa-executor.md"}

PO_PAYLOAD_NAME=${PO_PAYLOAD_NAME:-flywheel-onboard-payload}

# ── helpers ─────────────────────────────────────────────────────────────────
# po_pkg_npm_name <repo-root> <pkg-dir> → npm package name (fail-closed).
po_pkg_npm_name() {
  local root="$1" dir="$2" name
  name="$(jq -r '.name // empty' "$root/packages/$dir/package.json" 2>/dev/null)"
  [ -n "$name" ] || return 1
  printf '%s' "$name"
}

# po_version <repo-root> → normalized version (doc/VERSION, leading v stripped).
po_version() {
  local root="$1" v
  [ -f "$root/doc/VERSION" ] || { po_err "no doc/VERSION under $root"; return 1; }
  v="$(tr -d '[:space:]' < "$root/doc/VERSION")"
  printf '%s' "${v#v}"
}

# ── onboard skin patch (packaged shape) ─────────────────────────────────────
# The in-repo flywheel-onboard.sh keeps a curl|sh fetch skin that falls back to
# `git clone` of the PRIVATE repo. In the packaged shape the working copy IS
# the package (BASH_SOURCE detection hits the tree root), so that branch is
# unreachable — but the private URL must not ship at all (zero-repo-access
# invariant). Replace the fetch block with an honest plain-words error and
# drop the FO_REPO_URL default. Anchored strictly: missing anchors FAIL the
# build (drift guard, never a silent partial patch).
po_patch_onboard() {
  local file="$1"
  grep -q 'FO_REPO_URL="\${FLYWHEEL_ONBOARD_REPO:-' "$file" \
    || { po_err "onboard patch: FO_REPO_URL anchor missing in $file"; return 1; }
  grep -q '^# ── 2\. fetch the working copy when not already in one' "$file" \
    || { po_err "onboard patch: fetch-block anchor missing in $file"; return 1; }
  local tmp="$file.po-patch.$$"
  awk '
    /^FO_REPO_URL="\$\{FLYWHEEL_ONBOARD_REPO:-/ { next }
    /^# ── 2\. fetch the working copy when not already in one/ {
      print "# ── 2. packaged install: the working copy IS this package ───────────────────"
      print "# (assembled by package-onboard.sh — the git-clone fetch skin does not ship.)"
      print "if [ -z \"$FO_ROOT\" ]; then"
      print "  fo_die \"安装文件不完整。请重新运行安装命令,它会帮你把文件补齐。\""
      print "fi"
      skip = 1; next
    }
    skip {
      if ($0 == "fi") { skip = 0 }
      next
    }
    { print }
  ' "$file" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file"
  # Post-conditions: no clone, no private URL, still exec's the Buddy shell.
  grep -q 'git clone' "$file" && { po_err "onboard patch left a git clone behind"; return 1; }
  grep -q 'FLYWHEEL_ONBOARD_REPO' "$file" && { po_err "onboard patch left FO_REPO_URL behind"; return 1; }
  grep -q 'FO_BUDDY_SHELL' "$file" || { po_err "onboard patch destroyed the Buddy handoff"; return 1; }
  return 0
}

# ── run-bridge compile ──────────────────────────────────────────────────────
# scripts/run-bridge.ts is a thin ESM entry whose imports all point at
# ../packages/<dir>/dist/*.js. In the payload those packages live at
# node_modules/<npm-name>/ — rewrite the import specifiers to relative
# node_modules file paths (bypasses any exports-map restrictions), then strip
# the type annotations with the TypeScript transpiler (no type-check, no
# bundling — per-file dist layout stays intact for the file-URL importers).
po_compile_run_bridge() {
  local root="$1" tree="$2"
  local src="$root/scripts/run-bridge.ts"
  [ -f "$src" ] || { po_err "missing $src"; return 1; }
  mkdir -p "$tree/dist"
  PO_RB_ROOT="$root" node - "$src" "$tree/dist/run-bridge.js" <<'EOF' || return 1
const fs = require("node:fs");
const path = require("node:path");
const [src, out] = process.argv.slice(2);
const root = process.env.PO_RB_ROOT;
let code = fs.readFileSync(src, "utf8");
// Rewrite ../packages/<dir>/dist/... → ../node_modules/<npm-name>/dist/...
code = code.replace(
	/(["'])\.\.\/packages\/([a-z0-9-]+)\/(dist\/[^"']+)\1/g,
	(m, q, dir, rest) => {
		const pj = path.join(root, "packages", dir, "package.json");
		if (!fs.existsSync(pj)) {
			throw new Error(`run-bridge imports unknown package dir: ${dir}`);
		}
		const name = JSON.parse(fs.readFileSync(pj, "utf8")).name;
		return `${q}../node_modules/${name}/${rest}${q}`;
	},
);
if (/\.\.\/packages\//.test(code)) {
	throw new Error("run-bridge compile: unrewritten ../packages/ import left");
}
const ts = require(path.join(root, "node_modules", "typescript"));
const js = ts.transpileModule(code, {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;
fs.writeFileSync(out, js);
EOF
}

# ── dependency union ────────────────────────────────────────────────────────
# po_dependency_union <repo-root> → JSON object of third-party deps on stdout.
# Any package pinning the SAME dep at a DIFFERENT range fails the build.
po_dependency_union() {
  local root="$1" dir names_json="[]" entries="[]"
  for dir in $PO_PACKAGES; do
    local name
    name="$(po_pkg_npm_name "$root" "$dir")" || { po_err "no package.json name for packages/$dir"; return 1; }
    names_json="$(jq -c --arg n "$name" '. + [$n]' <<<"$names_json")"
  done
  for dir in $PO_PACKAGES; do
    entries="$(jq -c --slurpfile pj "$root/packages/$dir/package.json" --arg dir "$dir" \
      '. + ($pj[0].dependencies // {} | to_entries | map({name:.key, version:.value, from:$dir}))' \
      <<<"$entries")" || return 1
  done
  jq -e --argjson ws "$names_json" '
    [ .[] | select(.name as $n | ($ws | index($n)) | not) ]
    | group_by(.name)
    | map({name: .[0].name,
           versions: (map(.version) | unique),
           from: (map(.from) | unique)})
    | (map(select(.versions | length > 1))) as $conflicts
    | if ($conflicts | length) > 0 then
        error("dependency union conflict: " + ($conflicts | tojson))
      else
        map({(.name): .versions[0]}) | add // {}
      end
  ' <<<"$entries"
}

# ── assembly ────────────────────────────────────────────────────────────────
# po_assemble <repo-root> <tree-out-dir>
# Deterministic + idempotent: the tree is rebuilt from scratch each run.
po_assemble() {
  local root="$1" tree="$2"
  command -v jq >/dev/null 2>&1 || { po_err "jq required"; return 1; }
  command -v node >/dev/null 2>&1 || { po_err "node required"; return 1; }
  local version
  version="$(po_version "$root")" || return 1

  rm -rf "$tree"
  mkdir -p "$tree/scripts" "$tree/agents" "$tree/node_modules"

  # 1. curated scripts (fail-closed on any missing whitelist entry).
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$root/scripts/$f" ] || { po_err "whitelisted script missing: scripts/$f"; return 1; }
    mkdir -p "$tree/scripts/$(dirname "$f")"
    cp -p "$root/scripts/$f" "$tree/scripts/$f" || return 1
  done <<<"$PO_SCRIPT_FILES"
  local d
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    [ -d "$root/scripts/$d" ] || { po_err "whitelisted script dir missing: scripts/$d"; return 1; }
    mkdir -p "$tree/scripts/$(dirname "$d")"
    cp -Rp "$root/scripts/$d" "$tree/scripts/$d" || return 1
  done <<<"$PO_SCRIPT_DIRS"

  # 2. packaged skin patch for the onboard entry.
  if [ -f "$tree/scripts/flywheel-onboard.sh" ]; then
    po_patch_onboard "$tree/scripts/flywheel-onboard.sh" || return 1
  fi

  # 3. agents/ runtime prompts.
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$root/agents/$f" ] || { po_err "agent prompt missing: agents/$f"; return 1; }
    cp -p "$root/agents/$f" "$tree/agents/$f" || return 1
  done <<<"$PO_AGENT_FILES"

  # 4. workspace packages → node_modules/<npm-name>/ (dist REQUIRED — an
  #    unbuilt package must fail the build, never ship hollow).
  local dir name mirror_json="{}"
  for dir in $PO_PACKAGES; do
    name="$(po_pkg_npm_name "$root" "$dir")" || { po_err "packages/$dir has no npm name"; return 1; }
    [ -d "$root/packages/$dir/dist" ] || { po_err "packages/$dir/dist missing — run pnpm build first (fail-closed)"; return 1; }
    mkdir -p "$tree/node_modules/$name"
    cp -p "$root/packages/$dir/package.json" "$tree/node_modules/$name/package.json" || return 1
    cp -Rp "$root/packages/$dir/dist" "$tree/node_modules/$name/dist" || return 1
    mirror_json="$(jq -c --arg d "$dir" --arg n "$name" '. + {($d): $n}' <<<"$mirror_json")"
  done
  local spec
  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    dir="${spec%%:*}"; local asset="${spec#*:}"
    name="$(po_pkg_npm_name "$root" "$dir")" || return 1
    [ -d "$root/packages/$dir/$asset" ] || { po_err "package asset missing: packages/$dir/$asset"; return 1; }
    # runtime assets only — never ship tests that live inside asset dirs.
    cp -Rp "$root/packages/$dir/$asset" "$tree/node_modules/$name/$asset" || return 1
    rm -rf "$tree/node_modules/$name/$asset/__tests__"
  done < <(printf '%s\n' $PO_PACKAGE_ASSETS)

  # 5. strip non-runtime residue from the embedded packages.
  find "$tree/node_modules" -type d -name "__tests__" -prune -exec rm -rf {} + 2>/dev/null
  find "$tree/node_modules" -type f \( -name "*.test.js" -o -name "*.test.d.ts" -o -name "*.test.js.map" \) -delete 2>/dev/null

  # 6. dependency union + payload package.json.
  local union deps_json bundle_json="[]"
  union="$(po_dependency_union "$root")" || return 1
  deps_json="$union"
  for dir in $PO_PACKAGES; do
    name="$(po_pkg_npm_name "$root" "$dir")" || return 1
    deps_json="$(jq -c --arg n "$name" '. + {($n): ("file:node_modules/" + $n)}' <<<"$deps_json")"
    bundle_json="$(jq -c --arg n "$name" '. + [$n]' <<<"$bundle_json")"
  done
  jq -n \
    --arg name "$PO_PAYLOAD_NAME" \
    --arg version "$version" \
    --argjson deps "$deps_json" \
    --argjson bundle "$bundle_json" \
    --argjson mirror "$mirror_json" \
    '{
      name: $name,
      version: $version,
      private: true,
      description: "Flywheel onboarding runtime payload (gated distribution — not for public registries)",
      license: "UNLICENSED",
      type: "module",
      engines: { node: ">=20" },
      dependencies: ($deps | to_entries | sort_by(.key) | from_entries),
      bundleDependencies: ($bundle | sort),
      files: ["scripts", "agents", "dist", "node_modules", ".flywheel-prebuilt", "LICENSE", "README.md"],
      flywheelPackagesMirror: $mirror
    }' > "$tree/package.json" || return 1

  # 7. run-bridge entry → dist/run-bridge.js (P1-1).
  po_compile_run_bridge "$root" "$tree" || return 1

  # 8. sentinel + license + readme.
  printf '%s\n' "$version" > "$tree/.flywheel-prebuilt"
  cat > "$tree/LICENSE" <<'EOF'
UNLICENSED — proprietary.

This package is distributed only to licensed Flywheel customers through the
gated distribution endpoint. Redistribution, publication, or disclosure of any
part of it is not permitted.
EOF
  cat > "$tree/README.md" <<'EOF'
# Flywheel onboarding payload

Internal runtime payload installed by the Flywheel onboarding installer.
Do not install or run this package directly — use the installer command you
were given. Not for public registries.
EOF
  po_log "assembled payload tree v$version at $tree"
  return 0
}

# ── pack ────────────────────────────────────────────────────────────────────
# po_pack <tree> <out-dir> → prints the tarball path.
po_pack() {
  local tree="$1" out="$2"
  mkdir -p "$out"
  local tarball
  tarball="$(cd "$tree" && npm pack --pack-destination "$out" 2>/dev/null | tail -1)"
  [ -n "$tarball" ] && [ -f "$out/$tarball" ] || { po_err "npm pack failed"; return 1; }
  printf '%s/%s\n' "$out" "$tarball"
}

# ── release gates ───────────────────────────────────────────────────────────
# po_gate <unpacked-tree> <repo-root>
#   ①  scan_for_secrets over the whole release tree;
#   ②  explicit path allowlist (scripts/package-onboard-files.allow) — every
#      file must match a registered pattern; a NEW file must be added there
#      explicitly (snapshot discipline);
#   ③  zero .ts (except .d.ts) / src/ / __tests__/ / doc/ / .git;
#   ④  zero-repo-access invariant: no `git clone` and no private-org slug
#      outside the registered occurrences in
#      scripts/packaged/audit-grep-allowlist.tsv.
po_gate() {
  local tree="$1" root="$2" fail=0
  # ① secrets
  # shellcheck source=lib/fleet-sanitize.sh
  source "$root/scripts/lib/fleet-sanitize.sh"
  if ! scan_for_secrets "$tree"; then
    po_err "gate①: secret-like content in release tree"
    fail=1
  fi
  # ② allowlist snapshot
  local allow="${PO_FILES_ALLOWLIST:-$root/scripts/package-onboard-files.allow}"
  [ -f "$allow" ] || { po_err "gate②: allowlist missing: $allow"; return 1; }
  local rel bad_paths=""
  while IFS= read -r rel; do
    local ok=1 pat
    while IFS= read -r pat; do
      [ -z "$pat" ] && continue
      case "$pat" in \#*) continue ;; esac
      # shellcheck disable=SC2254
      case "$rel" in $pat) ok=0; break ;; esac
    done < "$allow"
    if [ "$ok" -ne 0 ]; then
      bad_paths="$bad_paths$rel"$'\n'
      fail=1
    fi
  done < <(cd "$tree" && find . -type f | sed 's|^\./||' | sort)
  if [ -n "$bad_paths" ]; then
    po_err "gate②: files NOT in the release allowlist (add explicitly to $(basename "$allow") if intended):"
    printf '%s' "$bad_paths" >&2
  fi
  # ③ forbidden content classes
  local hits
  hits="$(cd "$tree" && find . \( -name "*.ts" ! -name "*.d.ts" \) -o -type d -name "src" -o -type d -name "__tests__" -o -type d -name "doc" -o -name ".git" | sed 's|^\./||')"
  if [ -n "$hits" ]; then
    po_err "gate③: forbidden content in release tree:"
    printf '%s\n' "$hits" >&2
    fail=1
  fi
  # ④ zero-repo-access invariant
  local grep_allow="${PO_GREP_ALLOWLIST:-$root/scripts/packaged/audit-grep-allowlist.tsv}"
  [ -f "$grep_allow" ] || { po_err "gate④: grep allowlist missing: $grep_allow"; return 1; }
  local line file text registered
  while IFS=: read -r file _ text; do
    [ -z "$file" ] && continue
    registered=1
    while IFS=$'\t' read -r afile apat _; do
      [ -z "$afile" ] && continue
      case "$afile" in \#*) continue ;; esac
      # shellcheck disable=SC2254
      if [[ "$file" == $afile ]] && [[ "$text" == *"$apat"* ]]; then
        registered=0; break
      fi
    done < "$grep_allow"
    if [ "$registered" -ne 0 ]; then
      po_err "gate④: UNREGISTERED repo-access reference: $file: $text"
      fail=1
    fi
  done < <(cd "$tree" && grep -RIn -e 'git clone' -e 'xrliAnnie/' . 2>/dev/null | sed 's|^\./||')
  # version consistency: sentinel == package.json == doc/VERSION
  local v_pkg v_sent v_doc
  v_pkg="$(jq -r '.version' "$tree/package.json" 2>/dev/null)"
  v_sent="$(tr -d '[:space:]' < "$tree/.flywheel-prebuilt" 2>/dev/null)"
  v_doc="$(po_version "$root")"
  if [ -z "$v_pkg" ] || [ "$v_pkg" != "$v_sent" ] || [ "$v_pkg" != "$v_doc" ]; then
    po_err "gate: version mismatch (package.json=$v_pkg sentinel=$v_sent doc/VERSION=$v_doc)"
    fail=1
  fi
  if [ "$fail" -eq 0 ]; then
    po_log "release gates: PASS"
    return 0
  fi
  po_err "release gates: FAIL"
  return 1
}

# po_gate_tarball <tarball> <repo-root> — unpack + gate.
po_gate_tarball() {
  local tarball="$1" root="$2"
  local tmp
  tmp="$(mktemp -d -t fly1062-gate-XXXXXX)" || return 1
  tar -xzf "$tarball" -C "$tmp" || { rm -rf "$tmp"; po_err "cannot unpack $tarball"; return 1; }
  local rc=0
  po_gate "$tmp/package" "$root" || rc=1
  rm -rf "$tmp"
  return "$rc"
}

# ── main ────────────────────────────────────────────────────────────────────
po_main() {
  local root="$PO_SELF_DIR/.." out="" staging="" skip_gate=0
  root="$(cd "$root" && pwd)"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo-root) root="$(cd "$2" && pwd)"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      --staging) staging="$2"; shift 2 ;;
      --skip-gate) skip_gate=1; shift ;;
      -h|--help)
        cat <<EOF
Usage: package-onboard.sh [--repo-root DIR] [--out DIR] [--staging DIR] [--skip-gate]
Assembles + packs + gates the Flywheel onboarding payload tarball.
EOF
        return 0 ;;
      *) po_die "unknown arg: $1" ;;
    esac
  done
  [ -n "$out" ] || out="$root/dist-payload"
  [ -n "$staging" ] || staging="$out/tree"
  po_assemble "$root" "$staging" || return 1
  local tarball
  tarball="$(po_pack "$staging" "$out")" || return 1
  po_log "packed: $tarball"
  if [ "$skip_gate" -ne 1 ]; then
    po_gate_tarball "$tarball" "$root" || return 1
  fi
  printf '%s\n' "$tarball"
}

if [ "${PACKAGE_ONBOARD_SOURCED:-0}" != "1" ]; then
  po_main "$@"
fi

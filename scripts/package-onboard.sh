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
# override PO_PACKAGES / PO_SCRIPT_FILES / PO_SCRIPT_DIRS / PO_AGENT_FILES /
# PO_MENU_FILES).
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
# FLY-1188: claude-runner's dist resolves two runtime asset dirs as ../<dir>
# siblings — agents/ (the codex runner contract materialized into every
# $CODEX_HOME/AGENTS.md; a payload without it fail-louds every codex spawn)
# and bin/ (the CODEX_HOME-aware rotation shim FLYWHEEL_CODEX_BIN defaults
# to — same runtime-closure failure mode).
PO_PACKAGE_ASSETS=${PO_PACKAGE_ASSETS:-"teamlead:prompts teamlead:lead-rules-base teamlead:static claude-runner:agents claude-runner:bin"}

# File-level asset whitelist (<pkg-dir>:<relative-file>) — packages/teamlead/
# scripts is a grab bag of launcher runtime AND operator/ops one-offs
# (mufasa launchers, test-*, verify-*) that must NOT ship (internal slugs,
# machine-specific paths). This is the launcher runtime closure only.
PO_PACKAGE_ASSET_FILES=${PO_PACKAGE_ASSET_FILES:-"teamlead:scripts/claude-lead.sh
teamlead:scripts/lead-body.sh
teamlead:scripts/codex-lead.sh
teamlead:scripts/codex-lead-tui-home.sh
teamlead:scripts/lead-rules-bundle.sh
teamlead:scripts/apply-core-room-mention-gate.sh
teamlead:scripts/find-window.sh
teamlead:scripts/post-compact-bootstrap.sh
teamlead:scripts/session-start-adopt-inflight.sh
teamlead:scripts/inbox-ack-rule.md
teamlead:scripts/screencapture-l3-skill.md
teamlead:scripts/lib/lead-identity-preflight.sh
teamlead:scripts/lib/lead-session-authority.sh
teamlead:scripts/lib/lead-session-resume-gate.sh
teamlead:scripts/lib/session-ctx-usage.mjs
teamlead:scripts/lib/mcp-inherit.sh
teamlead:scripts/lib/reap-orphan-adapters.sh
teamlead:scripts/lib/lead-body-receipt.sh"}

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
flywheel-lead-wrapper-v2.sh
flywheel-lead-attach.sh
restart-storm-gate.py
lead-alert.sh
meta-alert.sh
update-flywheel.sh
converge-flywheel-bin.sh
check-global-path-hygiene.sh
linux-preflight.sh
materialize-lead-manifests.sh
lib/buddy-escalate.sh
lib/buddy-captain-preview.sh
lib/buddy-connect.sh
lib/fleet-sanitize.sh
lib/host-config.sh
lib/lead-address.sh
lib/platform-deps.sh
lib/script-sanity.sh
lib/path-hygiene.sh
lib/supervisor.sh
lib/bridge-port.sh
lib/lead-restart-lifecycle.sh
lib/lead-body-sweep.sh
lib/flywheel-log.sh
lib/tmux-server-rescue.sh
lib/self-ship-queue.sh
lib/lead-body-evidence.sh
lib/bounded-run.sh
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

# Global workflow menu assets. workflow-menu.ts resolves these from the
# checkout/package root in both source and compiled layouts, so the packaged
# Bridge must carry the same reviewed YAML bytes.
PO_MENU_FILES=${PO_MENU_FILES:-"shapes/code.yaml
shapes/prd.yaml
shapes/design.yaml
shapes/prototype.yaml
shapes/generic.yaml
shapes/simple_code.yaml"}

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

# po_version_is_derivation <base> <ver> — FLY-1062 PR4 (B0-3 contract):
# doc/VERSION holds only the base X.Y.Z; a legal payload semver is EITHER the
# clean base itself OR a beta derivation base-beta.N. Anything else fails.
po_version_is_derivation() {
  local base="$1" ver="$2" n
  [ "$ver" = "$base" ] && return 0
  n="${ver#"$base"-beta.}"
  [ "$n" != "$ver" ] && [[ "$n" =~ ^[0-9]+$ ]] && return 0
  return 1
}

# po_release_version <repo-root> — the version stamped into the payload.
# Default (PO_RELEASE_VERSION unset/empty) = po_version verbatim — today's
# behavior byte-for-byte (reverse-compat sentinel). When the release pipeline
# injects PO_RELEASE_VERSION it must be a legal derivation of the base
# (fail-closed: an arbitrary version can never enter a payload).
po_release_version() {
  local root="$1" base
  base="$(po_version "$root")" || return 1
  if [ -z "${PO_RELEASE_VERSION:-}" ]; then
    printf '%s' "$base"
    return 0
  fi
  if ! po_version_is_derivation "$base" "$PO_RELEASE_VERSION"; then
    po_err "PO_RELEASE_VERSION '$PO_RELEASE_VERSION' is not a derivation of base '$base' (expect $base or $base-beta.N)"
    return 1
  fi
  printf '%s' "$PO_RELEASE_VERSION"
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
  # shellcheck disable=SC2016  # match the literal ${...} source text
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
# po_dependency_union <repo-root> → JSON {union: {...}, nested: [{pkgDir, dep}]}.
#
# Third-party deps of all embedded packages, resolved to ONE top-level range
# each (npm installs them flat at the customer prefix; the bundled packages'
# bare imports resolve via Node walk-up — verified empirically: npm does NOT
# install dependencies declared by bundled deps themselves).
#
# Conflict policy:
#   • INTERSECTING ranges (^12.0.0 vs ^12.8.0) → auto-resolve to the declared
#     range equal to the intersection (else a constructed ">=lo <hi").
#   • DISJOINT ranges (zod ^3 vs ^4) → must be REGISTERED in
#     scripts/packaged/dependency-union-exceptions.tsv, which names the winner
#     and the packages that instead get a NESTED vendored copy of their own
#     resolved version (exact bits pnpm resolves for them today). An
#     UNREGISTERED disjoint conflict FAILS the build (align by hand or
#     register deliberately) — never silently picked.
# Range grammar understood: exact "a.b.c" and caret "^a.b.c" (everything the
# runtime packages use today); anything else must be string-identical across
# declarers or it is treated as disjoint.
po_dependency_union() {
  local root="$1"
  local exceptions="${PO_UNION_EXCEPTIONS:-$root/scripts/packaged/dependency-union-exceptions.tsv}"
  PO_UNION_PACKAGES="$PO_PACKAGES" PO_UNION_EXC="$exceptions" node - "$root" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const dirs = process.env.PO_UNION_PACKAGES.trim().split(/\s+/);
const excFile = process.env.PO_UNION_EXC;

const pkgs = dirs.map((dir) => {
	const pj = JSON.parse(
		fs.readFileSync(path.join(root, "packages", dir, "package.json"), "utf8"),
	);
	return { dir, name: pj.name, deps: pj.dependencies || {} };
});
const workspaceNames = new Set(pkgs.map((p) => p.name));

// range → [lo, hi) with lo inclusive; hi=null means exact (single version).
function parseRange(r) {
	let m = /^(\d+)\.(\d+)\.(\d+)$/.exec(r);
	if (m) return { lo: m.slice(1).map(Number), hi: null, exact: true };
	m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(r);
	if (m) {
		const lo = m.slice(1).map(Number);
		return { lo, hi: [lo[0] + 1, 0, 0], exact: false };
	}
	return null; // unsupported grammar
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function intersect(a, b) {
	// exact vs range
	const aHi = a.hi ?? a.lo;
	const bHi = b.hi ?? b.lo;
	const lo = cmp(a.lo, b.lo) >= 0 ? a.lo : b.lo;
	const hi = cmp(aHi, bHi) <= 0 ? aHi : bHi;
	const hiExclusive = !(a.hi === null && cmp(hi, a.lo) === 0) && !(b.hi === null && cmp(hi, b.lo) === 0);
	if (a.hi === null && b.hi === null)
		return cmp(a.lo, b.lo) === 0 ? a : null;
	if (a.hi === null) return cmp(a.lo, b.lo) >= 0 && cmp(a.lo, bHi) < 0 ? a : null;
	if (b.hi === null) return cmp(b.lo, a.lo) >= 0 && cmp(b.lo, aHi) < 0 ? b : null;
	return cmp(lo, hi) < 0 ? { lo, hi, exact: false } : null;
}

// exceptions: dep<TAB>winnerRange<TAB>comma-list-of-pkg-dirs-to-nest
const exceptions = new Map();
if (fs.existsSync(excFile)) {
	for (const line of fs.readFileSync(excFile, "utf8").split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		const [dep, winner, nest] = line.split("\t");
		exceptions.set(dep, { winner, nest: nest.trim().split(",").map((s) => s.trim()) });
	}
}

const byDep = new Map();
for (const p of pkgs) {
	for (const [dep, range] of Object.entries(p.deps)) {
		if (workspaceNames.has(dep)) continue;
		if (!byDep.has(dep)) byDep.set(dep, []);
		byDep.get(dep).push({ dir: p.dir, range });
	}
}

const union = {};
const nested = [];
const failures = [];
for (const [dep, decls] of byDep) {
	const ranges = [...new Set(decls.map((d) => d.range))];
	if (ranges.length === 1) {
		union[dep] = ranges[0];
		continue;
	}
	const parsed = ranges.map(parseRange);
	let inter = null;
	if (parsed.every(Boolean)) {
		inter = parsed.reduce((acc, r) => (acc ? intersect(acc, r) : null), {
			lo: [0, 0, 0],
			hi: [999999, 0, 0],
			exact: false,
		});
	}
	if (inter) {
		// prefer a declared range whose interval equals the intersection
		const eq = ranges.find((r) => {
			const p = parseRange(r);
			return (
				cmp(p.lo, inter.lo) === 0 &&
				((p.hi === null && inter.hi === null) ||
					(p.hi !== null && inter.hi !== null && cmp(p.hi, inter.hi) === 0) ||
					(p.hi === null && cmp(inter.lo, inter.hi ?? inter.lo) === 0))
			);
		});
		union[dep] = eq ?? `>=${inter.lo.join(".")} <${inter.hi.join(".")}`;
		continue;
	}
	// disjoint → must be registered
	const exc = exceptions.get(dep);
	if (!exc) {
		failures.push({ dep, decls });
		continue;
	}
	if (!ranges.includes(exc.winner)) {
		failures.push({ dep, decls, error: `exception winner '${exc.winner}' not among declared ranges` });
		continue;
	}
	const winnerParsed = parseRange(exc.winner);
	const needNest = decls
		.filter((d) => {
			const p = parseRange(d.range);
			return !(p && winnerParsed && intersect(p, winnerParsed));
		})
		.map((d) => d.dir);
	// nest "-" = RESOLUTION-UNIFORM: declared ranges are disjoint on paper but
	// the workspace lockfile resolves ONE version for every declarer (zod:
	// manifests still say ^3 while pnpm installs 4.3.6 everywhere — production
	// reality). Behavioral parity follows the RESOLVED version, so no nesting;
	// verified here against each declarer's actual node_modules resolution —
	// if a package someday truly resolves a different major, the build fails
	// and the exception must be re-registered with an explicit nest set.
	if (exc.nest.length === 1 && exc.nest[0] === "-") {
		let ok = true;
		for (const d of needNest) {
			const rp = path.join(root, "packages", d, "node_modules", ...dep.split("/"), "package.json");
			if (!fs.existsSync(rp)) {
				failures.push({ dep, decls, error: `resolution-uniform check: packages/${d} has no resolved ${dep} — run pnpm install` });
				ok = false;
				break;
			}
			const v = JSON.parse(fs.readFileSync(fs.realpathSync(rp), "utf8")).version;
			const vp = parseRange(v);
			if (!(vp && winnerParsed && intersect(vp, winnerParsed))) {
				failures.push({ dep, decls, error: `resolution-uniform violated: packages/${d} resolves ${dep}@${v}, winner ${exc.winner} — register an explicit nest set` });
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		union[dep] = exc.winner;
		continue;
	}
	const registered = [...exc.nest].sort().join(",");
	const actual = [...new Set(needNest)].sort().join(",");
	if (registered !== actual) {
		failures.push({
			dep,
			decls,
			error: `exception nest-set drift: registered [${registered}] vs actual [${actual}] — update the exceptions file deliberately`,
		});
		continue;
	}
	union[dep] = exc.winner;
	for (const dir of exc.nest) nested.push({ pkgDir: dir, dep });
}

if (failures.length) {
	console.error("dependency union conflict (unregistered/mismatched):");
	console.error(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log(JSON.stringify({ union, nested }));
EOF
}

# po_vendor_nested <repo-root> <tree> <pkg-dir> <dep>
# Vendor the EXACT dependency closure the monorepo resolves for packages/<dir>
# today (pnpm layout: realpath through the virtual store). Staged under
# vendor/<npm-name>/ — npm pack refuses to include node_modules dirs nested
# inside bundled deps (verified empirically), so the closure ships as regular
# payload files and create-compat-mirror.sh COPIES it into
# node_modules/<npm-name>/node_modules/ at install time. Node's nearest-wins
# resolution then keeps the package on its true version while the top-level
# union serves everyone else.
po_vendor_nested() {
  local root="$1" tree="$2" dir="$3" dep="$4"
  local name
  name="$(po_pkg_npm_name "$root" "$dir")" || return 1
  PO_VN_DEST="$tree/vendor/$name" node - "$root" "$dir" "$dep" <<'EOF' || return 1
const fs = require("node:fs");
const path = require("node:path");
const [root, dir, dep] = process.argv.slice(2);
const destNM = process.env.PO_VN_DEST;

function realDepDir(fromDir, name) {
	const p = path.join(fromDir, "node_modules", ...name.split("/"));
	if (!fs.existsSync(p)) return null;
	return fs.realpathSync(p);
}
// siblings in the pnpm virtual store: walk up from a real package dir to the
// nearest directory literally named node_modules.
function storeNM(realDir) {
	let d = realDir;
	while (d !== path.dirname(d)) {
		d = path.dirname(d);
		if (path.basename(d) === "node_modules") return d;
	}
	return null;
}
function storeSibling(nm, name) {
	const p = path.join(nm, ...name.split("/"));
	if (!fs.existsSync(p)) return null;
	return fs.realpathSync(p);
}
const seen = new Set();
function vendor(realDir, name) {
	const key = name + "@" + JSON.parse(fs.readFileSync(path.join(realDir, "package.json"), "utf8")).version;
	if (seen.has(key)) return;
	seen.add(key);
	const dest = path.join(destNM, ...name.split("/"));
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	// filter by RELATIVE path: the SOURCE lives inside the pnpm store (its
	// absolute path always contains /node_modules/) — only a node_modules
	// segment INSIDE the copied package must be excluded.
	fs.cpSync(realDir, dest, {
		recursive: true,
		dereference: true,
		filter: (src) =>
			!path.relative(realDir, src).split(path.sep).includes("node_modules"),
	});
	const pj = JSON.parse(fs.readFileSync(path.join(realDir, "package.json"), "utf8"));
	const nm = storeNM(realDir);
	for (const d of Object.keys(pj.dependencies || {})) {
		let sub = nm ? storeSibling(nm, d) : null;
		if (sub === null) sub = realDepDir(path.join(root, "packages", dir), d);
		if (sub === null) {
			console.error(`vendor closure: cannot resolve ${d} (needed by ${name}) for packages/${dir}`);
			process.exit(1);
		}
		vendor(sub, d);
	}
}
const top = realDepDir(path.join(root, "packages", dir), dep);
if (!top) {
	console.error(`vendor: packages/${dir} has no resolved node_modules/${dep} — run pnpm install`);
	process.exit(1);
}
vendor(top, dep);
console.log(`vendored ${dep} closure (${seen.size} pkgs) into ${destNM}`);
EOF
}

# po_copy_curated_scripts <repo-root> <tree-out-dir>
# The one assembler for the curated scripts subtree. Tests call this same
# function when constructing a packaged fixture, so a repository-only hand
# copy cannot hide a missing customer runtime dependency.
po_copy_curated_scripts() {
  local root="$1" tree="$2"
  mkdir -p "$tree/scripts"
  local f
  while IFS= read -r f; do
    case "$f" in *[![:space:]]*) ;; *) continue ;; esac
    [ -f "$root/scripts/$f" ] || { po_err "whitelisted script missing: scripts/$f"; return 1; }
    mkdir -p "$tree/scripts/$(dirname "$f")"
    cp -p "$root/scripts/$f" "$tree/scripts/$f" || return 1
  done <<<"$PO_SCRIPT_FILES"
  local d
  while IFS= read -r d; do
    case "$d" in *[![:space:]]*) ;; *) continue ;; esac
    [ -d "$root/scripts/$d" ] || { po_err "whitelisted script dir missing: scripts/$d"; return 1; }
    mkdir -p "$tree/scripts/$(dirname "$d")"
    cp -Rp "$root/scripts/$d" "$tree/scripts/$d" || return 1
  done <<<"$PO_SCRIPT_DIRS"
}

# ── assembly ────────────────────────────────────────────────────────────────
# po_assemble <repo-root> <tree-out-dir>
# Deterministic + idempotent: the tree is rebuilt from scratch each run.
po_assemble() {
  local root="$1" tree="$2"
  command -v jq >/dev/null 2>&1 || { po_err "jq required"; return 1; }
  command -v node >/dev/null 2>&1 || { po_err "node required"; return 1; }
  local version
  version="$(po_release_version "$root")" || return 1

  rm -rf "$tree"
  mkdir -p "$tree/scripts" "$tree/agents" "$tree/menus" "$tree/node_modules"

  # 1. curated scripts (fail-closed on any missing whitelist entry).
  po_copy_curated_scripts "$root" "$tree" || return 1

  # 2. packaged skin patch for the onboard entry.
  if [ -f "$tree/scripts/flywheel-onboard.sh" ]; then
    po_patch_onboard "$tree/scripts/flywheel-onboard.sh" || return 1
  fi

  # 3. agents/ runtime prompts.
  while IFS= read -r f; do
    case "$f" in *[![:space:]]*) ;; *) continue ;; esac
    [ -f "$root/agents/$f" ] || { po_err "agent prompt missing: agents/$f"; return 1; }
    cp -p "$root/agents/$f" "$tree/agents/$f" || return 1
  done <<<"$PO_AGENT_FILES"

  # 4. global workflow menu assets.
  while IFS= read -r f; do
    case "$f" in *[![:space:]]*) ;; *) continue ;; esac
    [ -f "$root/menus/$f" ] || { po_err "workflow menu missing: menus/$f"; return 1; }
    mkdir -p "$tree/menus/$(dirname "$f")"
    cp -p "$root/menus/$f" "$tree/menus/$f" || return 1
  done <<<"$PO_MENU_FILES"

  # 5. workspace packages → node_modules/<npm-name>/ (dist REQUIRED — an
  #    unbuilt package must fail the build, never ship hollow).
  local dir name mirror_json="{}"
  for dir in $PO_PACKAGES; do
    name="$(po_pkg_npm_name "$root" "$dir")" || { po_err "packages/$dir has no npm name"; return 1; }
    [ -d "$root/packages/$dir/dist" ] || { po_err "packages/$dir/dist missing — run pnpm build first (fail-closed)"; return 1; }
    mkdir -p "$tree/node_modules/$name"
    # Strip the package's own `files` whitelist from the embedded copy: npm
    # pack re-applies it to BUNDLED deps too (verified empirically — teamlead's
    # files:["dist","bin"] silently dropped scripts/ + the nested vendored deps
    # from the tarball). Our embedded dir already contains exactly the curated
    # runtime set, so the payload allowlist gate is the content authority.
    jq 'del(.files)' "$root/packages/$dir/package.json" > "$tree/node_modules/$name/package.json" \
      || { po_err "cannot rewrite package.json for $name"; return 1; }
    cp -Rp "$root/packages/$dir/dist" "$tree/node_modules/$name/dist" || return 1
    mirror_json="$(jq -c --arg d "$dir" --arg n "$name" '. + {($d): $n}' <<<"$mirror_json")"
  done
  local spec
  # shellcheck disable=SC2086  # split the curated whitespace-delimited asset list
  while IFS= read -r spec; do
    case "$spec" in *[![:space:]]*) ;; *) continue ;; esac
    dir="${spec%%:*}"; local asset="${spec#*:}"
    name="$(po_pkg_npm_name "$root" "$dir")" || return 1
    [ -d "$root/packages/$dir/$asset" ] || { po_err "package asset missing: packages/$dir/$asset"; return 1; }
    # runtime assets only — never ship tests that live inside asset dirs.
    cp -Rp "$root/packages/$dir/$asset" "$tree/node_modules/$name/$asset" || return 1
    rm -rf "$tree/node_modules/$name/$asset/__tests__"
  done < <(printf '%s\n' $PO_PACKAGE_ASSETS)
  while IFS= read -r spec; do
    case "$spec" in *[![:space:]]*) ;; *) continue ;; esac
    dir="${spec%%:*}"; local afile="${spec#*:}"
    name="$(po_pkg_npm_name "$root" "$dir")" || return 1
    [ -f "$root/packages/$dir/$afile" ] || { po_err "package asset file missing: packages/$dir/$afile"; return 1; }
    mkdir -p "$tree/node_modules/$name/$(dirname "$afile")"
    cp -p "$root/packages/$dir/$afile" "$tree/node_modules/$name/$afile" || return 1
  done <<<"$PO_PACKAGE_ASSET_FILES"

  # 6. strip non-runtime residue from the embedded packages. Source maps are a
  #    HARD strip: tsc sourcemaps can embed the ORIGINAL TypeScript source via
  #    sourcesContent — shipping them would leak the source the whole payload
  #    exists to withhold. Type declarations are runtime-dead weight.
  find "$tree/node_modules" -type d -name "__tests__" -prune -exec rm -rf {} + 2>/dev/null
  find "$tree/node_modules" -type f \( -name "*.test.js" -o -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o -name "*.tsbuildinfo" \) -delete 2>/dev/null

  # 7. dependency union (+ registered nested vendoring) + payload package.json.
  local union_out union deps_json bundle_json="[]"
  union_out="$(po_dependency_union "$root")" || return 1
  union="$(jq -c '.union' <<<"$union_out")" || return 1
  local ndir ndep
  while IFS=$'\t' read -r ndir ndep; do
    [ -z "$ndir" ] && continue
    po_vendor_nested "$root" "$tree" "$ndir" "$ndep" || return 1
  done < <(jq -r '.nested[]? | [.pkgDir, .dep] | @tsv' <<<"$union_out")
  # FORCE-NESTED registrations (scripts/packaged/force-nested-deps.tsv):
  # install-time peer/hoist conflicts the declared-range union cannot see —
  # e.g. mem0ai's peer @anthropic-ai/sdk ^0.40 wins the customer prefix's flat
  # slot and npm cannot reify the payload's own nested copy inside the bundled
  # tree (it leaves an EMPTY dir that shadows the flat copy for ESM walk-up).
  # Vendor the declarer's own resolved closure unconditionally.
  local force_nest="${PO_FORCE_NESTED:-$root/scripts/packaged/force-nested-deps.tsv}"
  if [ -f "$force_nest" ]; then
    while IFS=$'\t' read -r ndir ndep _; do
      case "$ndir" in \#*) continue ;; esac
      case "$ndir" in *[![:space:]]*) ;; *) continue ;; esac
      po_vendor_nested "$root" "$tree" "$ndir" "$ndep" || return 1
    done < "$force_nest"
  fi
  # Vendored PUBLIC packages ship their own sources/docs on npm (zod v3
  # includes src/*.ts; READMEs carry `git clone` doc text) — strip everything
  # the runtime doesn't load so the release gates stay strict: TypeScript of
  # any kind, sourcemaps, markdown docs (LICENSE files are kept for
  # attribution).
  if [ -d "$tree/vendor" ]; then
    find "$tree/vendor" -type f \( -name "*.ts" -o -name "*.mts" -o -name "*.cts" -o -name "*.map" -o -name "*.tsbuildinfo" -o -name "*.md" -o -name "*.markdown" \) -delete 2>/dev/null
  fi
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
      files: ["scripts", "agents", "menus", "dist", "node_modules", "vendor", ".flywheel-prebuilt", "LICENSE", "README.md"],
      flywheelPackagesMirror: $mirror
    }' > "$tree/package.json" || return 1

  # 8. run-bridge entry → dist/run-bridge.js (P1-1).
  po_compile_run_bridge "$root" "$tree" || return 1

  # 9. sentinel + license + readme.
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

# ── gate④ normalization + detectors ────────────────────────────────────────
# po_g4_norm <string> — canonical form for repo-access judgment: shell quotes
# stripped (quoting splits reassemble at execution: "xrliAnnie"/"flywheel"),
# tabs→spaces, runs squeezed (`git  clone`), lowercased (xrliannie), trimmed.
po_g4_norm() {
  printf '%s' "$1" | tr -d '\042\047' | tr '\t' ' ' | tr -s ' ' | tr '[:upper:]' '[:lower:]' \
    | sed 's/^ *//; s/ *$//'
}

# po_g4_detect <detector> <normalized-string> — the forbidden shapes. MUST
# stay in lockstep with the awk twin inside po_gate's scan (the awk copy
# filters the tree stream; this copy judges allowlist rows).
#   slug  — the private GitHub org path prefix
#   clone — a git-invocation whose argument list carries a `clone` word
#           (catches `git clone`, `git  clone`, `git -C x clone`, …)
#   combo — BOTH on one line = a private-repo clone command (Codex R3: in a
#           file that registers a slug row AND a clone row for different
#           lines, the two rows would otherwise clear the combined line
#           between them; a combo occurrence demands a single row that itself
#           carries both shapes — no production row does, deliberately).
po_g4_detect() {
  local d="$1" s="$2"
  local clone_re='(^|[^a-z0-9_.-])git ([^|&;]* )?clone($|[^a-z0-9_-])'
  case "$d" in
    slug)  [[ "$s" == *"xrliannie/"* ]] ;;
    clone) [[ "$s" =~ $clone_re ]] ;;
    combo) [[ "$s" == *"xrliannie/"* ]] && [[ "$s" =~ $clone_re ]] ;;
    *) return 1 ;;
  esac
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
  # ① secrets (code-tree calibrated: vendor tokens + entropy everywhere, the
  #   full assignment net on config-class files — see fleet-sanitize.sh)
  # shellcheck source=lib/fleet-sanitize.sh
  source "$root/scripts/lib/fleet-sanitize.sh"
  if ! scan_code_tree_for_secrets "$tree"; then
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
  # ③ forbidden content classes: zero TypeScript of ANY kind (assembly strips
  #   even .d.ts), zero source dirs outside compiled dist output (tsc trees like
  #   dist/src/*.js are compiled JS, not source; vendor/ holds PUBLIC third-party
  #   packages whose own layout may keep an src dir — the *.ts rule still
  #   applies to it), zero tests/doc/git history.
  local hits
  hits="$(cd "$tree" && find . \( -name "*.ts" -o -name "*.mts" -o -name "*.cts" \) -o \( -type d -name "src" ! -path "*/dist/*" ! -path "./vendor/*" \) -o -type d -name "__tests__" -o -type d -name "doc" -o -name ".git" | sed 's|^\./||')"
  if [ -n "$hits" ]; then
    po_err "gate③: forbidden content in release tree:"
    printf '%s\n' "$hits" >&2
    fail=1
  fi
  # ④ zero-repo-access invariant — detector-based, EXACT-LINE allowlist.
  #   The review rounds each killed a looser scheme: R1 per-line substring
  #   clearing masked a co-located slug; R2 literal case-sensitive matching
  #   missed normalization variants; R3 two broad rows in one file jointly
  #   cleared a combined private-clone line; R4 a backslash-continuation
  #   split the shapes across physical lines. The closed form: every line is
  #   NORMALIZED (po_g4_norm) and judged by the DETECTORS (po_g4_detect); an
  #   allowlist row clears an occurrence only if (a) its file glob matches,
  #   (b) its normalized registration EXACTLY EQUALS the normalized line, and
  #   (c) the registration itself triggers the SAME detector. Any line not
  #   byte-registered in its canonical form fails — including each half of a
  #   continuation split (`git clone \` alone triggers the clone detector and
  #   equals no registered line). Registrations therefore pin the exact
  #   shipping lines (see audit-grep-allowlist.tsv) — editing a registered
  #   source line deliberately re-registers it (snapshot discipline).
  local grep_allow="${PO_GREP_ALLOWLIST:-$root/scripts/packaged/audit-grep-allowlist.tsv}"
  [ -f "$grep_allow" ] || { po_err "gate④: grep allowlist missing: $grep_allow"; return 1; }
  local det prefilter file lineno text nline registered afile apat
  for det in clone slug combo; do
    case "$det" in clone) prefilter='clone' ;; slug|combo) prefilter='xrliannie' ;; esac
    while IFS=$'\t' read -r file lineno text; do
      [ -z "$file" ] && continue
      nline="$(po_g4_norm "$text")"
      registered=1
      while IFS=$'\t' read -r afile apat _; do
        [ -z "$afile" ] && continue
        case "$afile" in \#*) continue ;; esac
        # shellcheck disable=SC2053,SC2254  # afile is an allowlisted glob pattern
        if [[ "$file" == $afile ]] && [ "$nline" = "$(po_g4_norm "$apat")" ] \
           && po_g4_detect "$det" "$(po_g4_norm "$apat")"; then
          registered=0; break
        fi
      done < "$grep_allow"
      if [ "$registered" -ne 0 ]; then
        po_err "gate④: UNREGISTERED repo-access reference ($det): $file:$lineno: $text"
        fail=1
      fi
    done < <(
      # case-insensitive prefilter narrows the tree stream; the awk twin of
      # po_g4_norm/po_g4_detect emits only true detector hits (file⟶line⟶raw).
      cd "$tree" && grep -RIni -e "$prefilter" . 2>/dev/null | sed 's|^\./||' \
        | awk -v D="$det" '
          {
            i1 = index($0, ":"); if (i1 == 0) next
            rest = substr($0, i1 + 1)
            i2 = index(rest, ":"); if (i2 == 0) next
            f = substr($0, 1, i1 - 1)
            n = substr(rest, 1, i2 - 1)
            raw = substr(rest, i2 + 1)
            line = tolower(raw)
            gsub(/["\047]/, "", line)
            gsub(/[\t ]+/, " ", line)
            sub(/^ /, "", line); sub(/ $/, "", line)
            hit = 0
            if (D == "slug" && index(line, "xrliannie/") > 0) hit = 1
            if (D == "clone" && line ~ /(^|[^a-z0-9_.-])git ([^|&;]* )?clone($|[^a-z0-9_-])/) hit = 1
            if (D == "combo" && index(line, "xrliannie/") > 0 && line ~ /(^|[^a-z0-9_.-])git ([^|&;]* )?clone($|[^a-z0-9_-])/) hit = 1
            if (hit) printf "%s\t%s\t%s\n", f, n, raw
          }'
    )
  done
  # version consistency: sentinel == package.json, and the payload semver is
  # a LEGAL DERIVATION of doc/VERSION's base (FLY-1062 PR4, B0-3: base itself
  # or base-beta.N — the default un-injected build still stamps the base, so
  # the old exact-equality behavior is a strict subset of this check).
  local v_pkg v_sent v_doc
  v_pkg="$(jq -r '.version' "$tree/package.json" 2>/dev/null)"
  v_sent="$(tr -d '[:space:]' < "$tree/.flywheel-prebuilt" 2>/dev/null)"
  v_doc="$(po_version "$root")"
  if [ -z "$v_pkg" ] || [ "$v_pkg" != "$v_sent" ] || ! po_version_is_derivation "$v_doc" "$v_pkg"; then
    po_err "gate: version mismatch (package.json=$v_pkg sentinel=$v_sent doc/VERSION base=$v_doc; expect base or base-beta.N)"
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

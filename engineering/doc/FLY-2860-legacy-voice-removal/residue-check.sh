#!/usr/bin/env bash
# FLY-2860 residue gate (QA criterion 1).
#
# Scans every tracked file outside the history archives (engineering/doc/,
# doc/, product/doc/) for two kinds of hits:
#   A. any token containing eleven | gemini | /glaw | huddle (case-insensitive);
#   B. any identifier of a retired module or function (retired-identifiers.txt).
# A token is the maximal run of [A-Za-z0-9_./-] around the hit. Every token must
# fully match one of the regexes that residue-allowlist.txt registers for that
# exact path (no directory or package globs); anything else fails the gate.
#
# usage: residue-check.sh [--root <repo>] [--report] [--self-test]
#   --report     also print every allowed hit grouped by category
#   --self-test  prove the gate fails on injected legacy lines in a copy of a
#                mixed file and passes on an injected allowed token
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REPORT=0
SELF_TEST=0
STALE_CHECK=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --report) REPORT=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    --no-stale-check) STALE_CHECK=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

scan() {
  node --input-type=module - "$1" "$HERE/residue-allowlist.txt" "$HERE/retired-identifiers.txt" "$2" "$3" <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [root, allowPath, identPath, report, staleCheck] = process.argv.slice(2);
const EXCLUDED = ["engineering/doc/", "doc/", "product/doc/"];
const CORE = /eleven|gemini|\/glaw|huddle/gi;
const TOKEN_CHAR = /[A-Za-z0-9_./-]/;
const idents = fs.readFileSync(identPath, "utf8").split(/\s+/).filter(Boolean);
const IDENT = new RegExp(`\\b(?:${idents.join("|")})\\b`, "g");

const allow = new Map();
for (const [i, line] of fs.readFileSync(allowPath, "utf8").split("\n").entries()) {
	if (!line.trim() || line.startsWith("#")) continue;
	const [file, regex, category, reason] = line.split("\t");
	if (!file || !regex || !category || !reason || /[*?]/.test(file)) {
		console.error(`residue-allowlist.txt:${i + 1}: malformed or globbed entry`);
		process.exit(2);
	}
	const list = allow.get(file) ?? [];
	list.push({ re: new RegExp(regex), category, used: false, line: i + 1 });
	allow.set(file, list);
}

function listFiles() {
	try {
		return execFileSync("git", ["-C", root, "ls-files", "-z"], {
			encoding: "utf8",
			maxBuffer: 1 << 28,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\0")
			.filter(Boolean);
	} catch {
		const out = [];
		const walk = (dir) => {
			for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
				if (e.name === ".git" || e.name === "node_modules") continue;
				const rel = dir ? `${dir}/${e.name}` : e.name;
				if (e.isDirectory()) walk(rel);
				else out.push(rel);
			}
		};
		walk("");
		return out;
	}
}

function tokens(line) {
	const found = [];
	for (const m of line.matchAll(CORE)) {
		let s = m.index;
		let e = s + m[0].length;
		while (s > 0 && TOKEN_CHAR.test(line[s - 1])) s--;
		while (e < line.length && TOKEN_CHAR.test(line[e])) e++;
		found.push(line.slice(s, e));
	}
	for (const m of line.matchAll(IDENT)) found.push(m[0]);
	return found;
}

const failures = [];
const allowed = new Map();
for (const file of listFiles()) {
	if (EXCLUDED.some((prefix) => file.startsWith(prefix))) continue;
	let data;
	try {
		data = fs.readFileSync(path.join(root, file));
	} catch {
		continue;
	}
	if (data.subarray(0, 8000).includes(0)) continue;
	const lines = data.toString("utf8").split("\n");
	for (const [i, line] of lines.entries()) {
		for (const token of tokens(line)) {
			const rule = (allow.get(file) ?? []).find((r) => r.re.test(token));
			if (!rule) {
				failures.push(`${file}:${i + 1}: ${token}`);
				continue;
			}
			rule.used = true;
			const bucket = allowed.get(rule.category) ?? new Map();
			bucket.set(file, (bucket.get(file) ?? 0) + 1);
			allowed.set(rule.category, bucket);
		}
	}
}
const stale = [];
if (staleCheck === "1") {
	for (const [file, rules] of allow) {
		for (const r of rules) if (!r.used) stale.push(`residue-allowlist.txt:${r.line}: ${file} (no matching hit)`);
	}
}
if (report === "1") {
	for (const [category, bucket] of [...allowed].sort()) {
		const hits = [...bucket.values()].reduce((a, b) => a + b, 0);
		console.log(`[allowed] ${category}: ${hits} hit(s) in ${bucket.size} file(s)`);
		for (const [file, n] of [...bucket].sort()) console.log(`    ${n}\t${file}`);
	}
}
for (const f of failures) console.log(`[residue] ${f}`);
for (const s of stale) console.log(`[stale-allowlist] ${s}`);
const total = [...allowed.values()].reduce((a, b) => a + [...b.values()].reduce((x, y) => x + y, 0), 0);
console.log(`residue-check: ${failures.length} unallowed, ${stale.length} stale, ${total} allowed hit(s)`);
process.exit(failures.length || stale.length ? 1 : 0);
NODE
}

if [[ "$SELF_TEST" -eq 1 ]]; then
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2860-residue.XXXXXX")"
  trap 'rm -rf "$TMP"' EXIT
  MIXED=packages/teamlead/src/bridge/plugin.ts
  mkdir -p "$TMP/$(dirname "$MIXED")"
  cp "$ROOT/$MIXED" "$TMP/$MIXED"
  ok=1
  if ! scan "$TMP" 0 0 >/dev/null; then
    echo "self-test FAIL: an untouched copy of $MIXED should pass"; ok=0
  fi
  printf '%s\n' 'const legacyBackchannel = process.env.FLYWHEEL_HUDDLE_BACKCHANNEL_MS;' \
    'wireAssistantMode(runtime);' >> "$TMP/$MIXED"
  out="$(scan "$TMP" 0 0)"
  if [[ $? -eq 0 ]] || ! grep -q 'FLYWHEEL_HUDDLE_BACKCHANNEL_MS' <<<"$out" || ! grep -q 'wireAssistantMode' <<<"$out"; then
    echo "self-test FAIL: injected legacy lines in $MIXED were not caught"; ok=0
  fi
  cp "$ROOT/$MIXED" "$TMP/$MIXED"
  printf '%s\n' 'const scoped = config.geminiAgentToken;' >> "$TMP/$MIXED"
  if ! scan "$TMP" 0 0 >/dev/null; then
    echo "self-test FAIL: an allowed geminiAgentToken line in $MIXED was rejected"; ok=0
  fi
  if [[ "$ok" -eq 1 ]]; then echo "residue-check self-test: PASS"; exit 0; fi
  exit 1
fi

scan "$ROOT" "$REPORT" "$STALE_CHECK"

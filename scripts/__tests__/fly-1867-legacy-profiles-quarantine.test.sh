#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_URL="file://$ROOT/scripts/fly-1867-legacy-profiles-quarantine.mjs" \
node --input-type=module <<'NODE'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
const {
  classifyLsofResult,
  deleteLegacyProfileQuarantine,
  probeTreeOpenFiles,
  runLegacyProfileQuarantine,
  validateLegacyProfileManifest,
} = await import(process.env.SCRIPT_URL);

let pass = 0;
let fail = 0;
function check(condition, label) {
  if (condition) { pass++; console.log(`ok ${pass + fail} - ${label}`); }
  else { fail++; console.log(`not ok ${pass + fail} - ${label}`); }
}
async function rejects(fn, pattern) {
  try { await fn(); return false; }
  catch (error) { return pattern.test(String(error)); }
}

const roots = [];
const NOW = new Date("2026-08-20T16:00:00.000Z");
const REVIEWED = "2026-08-19T16:00:00.000Z";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fly1867-quarantine-test-")));
  roots.push(root);
  const cacheRoot = join(root, "ms-playwright-mcp");
  mkdirSync(cacheRoot);
  return { root, cacheRoot, manifestPath: join(root, "manifest.json") };
}
function entry(cacheRoot, token, inferredRoot) {
  return {
    profile_path: join(cacheRoot, `mcp-chrome-${token}`),
    profile_token: token,
    inferred_root: inferredRoot,
    provenance: "test review",
  };
}
function writeManifest(path, entries, reviewedAt = REVIEWED) {
  writeFileSync(path, JSON.stringify({
    version: 1,
    issue: "FLY-1867",
    reviewed_at: reviewedAt,
    entries,
  }));
}
function makeOld(path) {
  const old = new Date("2026-08-18T00:00:00.000Z");
  utimesSync(path, old, old);
}
const cleanGate = async () => ({ overall: "clean", rows: [] });
const emptyTree = async () => ({ status: "empty", reason: "no_open_files", output: "" });

try {
  {
    const f = fixture();
    const a = entry(f.cacheRoot, "1234abc", join(f.root, "gone"));
    mkdirSync(a.profile_path);
    const malformed = [
      { ...a, profile_token: "7654321" },
      { ...a, profile_path: join(f.root, "outside", "mcp-chrome-1234abc") },
    ];
    check(
      await rejects(
        () => validateLegacyProfileManifest({
          manifest: { version: 1, issue: "FLY-1867", reviewed_at: REVIEWED, entries: [a, a] },
          cacheRoot: f.cacheRoot,
        }),
        /duplicate/,
      ),
      "rejects a duplicate manifest entry",
    );
    for (const bad of malformed) {
      check(
        await rejects(
          () => validateLegacyProfileManifest({
            manifest: { version: 1, issue: "FLY-1867", reviewed_at: REVIEWED, entries: [bad] },
            cacheRoot: f.cacheRoot,
          }),
          /manifest/,
        ),
        "rejects token/path mismatch or a path outside the cache root",
      );
    }
    rmSync(a.profile_path, { recursive: true });
    symlinkSync(f.root, a.profile_path);
    check(
      await rejects(
        () => validateLegacyProfileManifest({
          manifest: { version: 1, issue: "FLY-1867", reviewed_at: REVIEWED, entries: [a] },
          cacheRoot: f.cacheRoot,
        }),
        /symlink/,
      ),
      "rejects an existing symlink entry before processing anything",
    );
  }

  {
    const f = fixture();
    const a = entry(f.cacheRoot, "1234abc", join(f.root, "gone"));
    mkdirSync(a.profile_path); makeOld(a.profile_path); writeManifest(f.manifestPath, [a]);
    for (const verdict of ["has_match", "unknown"]) {
      check(
        await rejects(
          () => runLegacyProfileQuarantine({
            manifestPath: f.manifestPath,
            cacheRoot: f.cacheRoot,
            dryRun: false,
            now: () => NOW,
            probeMcpProcesses: async () => ({ overall: verdict, rows: [] }),
            probeTree: emptyTree,
          }),
          /quiet gate/,
        ) && readFileSync(f.manifestPath, "utf8").length > 0 &&
          existsSync(a.profile_path) &&
          !existsSync(join(f.cacheRoot, ".fly1867-quarantine-2026-08-19T16-00-00-000Z")),
        `quiet gate ${verdict} fails before any filesystem mutation`,
      );
    }
  }

  {
    const f = fixture();
    const late = entry(f.cacheRoot, "1234abc", join(f.root, "gone-a"));
    const busy = entry(f.cacheRoot, "2345bcd", join(f.root, "gone-b"));
    const revived = entry(f.cacheRoot, "3456cde", join(f.root, "revived"));
    for (const e of [late, busy, revived]) mkdirSync(e.profile_path);
    makeOld(busy.profile_path); makeOld(revived.profile_path); mkdirSync(revived.inferred_root);
    writeManifest(f.manifestPath, [late, busy, revived]);
    const result = await runLegacyProfileQuarantine({
      manifestPath: f.manifestPath,
      cacheRoot: f.cacheRoot,
      dryRun: false,
      now: () => NOW,
      probeMcpProcesses: cleanGate,
      probeTree: async (path) => path === busy.profile_path
        ? { status: "blocked", reason: "open_files", output: "nfile" }
        : await emptyTree(),
    });
    check(
      result.decisions.every((d) => d.action === "preserved") &&
      result.decisions.some((d) => d.reason === "mtime_not_before_review") &&
      result.decisions.some((d) => d.reason === "inferred_root_exists") &&
      result.decisions.some((d) => d.reason === "lsof:open_files"),
      "late, revived, and open profiles are preserved with explicit reasons",
    );
  }

  let movedFixture;
  {
    const f = fixture();
    const a = entry(f.cacheRoot, "1234abc", join(f.root, "gone"));
    mkdirSync(a.profile_path); writeFileSync(join(a.profile_path, "data"), "kept");
    makeOld(a.profile_path); writeManifest(f.manifestPath, [a]);
    const result = await runLegacyProfileQuarantine({
      manifestPath: f.manifestPath,
      cacheRoot: f.cacheRoot,
      dryRun: false,
      now: () => NOW,
      probeMcpProcesses: cleanGate,
      probeTree: emptyTree,
    });
    movedFixture = { ...f, result };
    const ledger = readFileSync(join(result.quarantinePath, "ledger.jsonl"), "utf8");
    check(
      result.decisions[0].action === "moved" &&
      !readFileSync(join(result.quarantinePath, "mcp-chrome-1234abc", "data"), "utf8").localeCompare("kept") &&
      ledger.includes('"action":"moved"'),
      "normal apply atomically moves content and appends a moved ledger row",
    );
    const rerun = await runLegacyProfileQuarantine({
      manifestPath: f.manifestPath,
      cacheRoot: f.cacheRoot,
      dryRun: false,
      now: () => NOW,
      probeMcpProcesses: cleanGate,
      probeTree: emptyTree,
    });
    check(rerun.decisions[0].action === "skipped_missing",
      "rerun records an already-moved source as skipped_missing without error");
  }

  {
    const f = fixture();
    const a = entry(f.cacheRoot, "1234abc", join(f.root, "gone-a"));
    const b = entry(f.cacheRoot, "2345bcd", join(f.root, "gone-b"));
    for (const e of [a, b]) { mkdirSync(e.profile_path); writeFileSync(join(e.profile_path, "data"), e.profile_token); makeOld(e.profile_path); }
    writeManifest(f.manifestPath, [a, b]);
    let probes = 0;
    const result = await runLegacyProfileQuarantine({
      manifestPath: f.manifestPath,
      cacheRoot: f.cacheRoot,
      dryRun: false,
      now: () => NOW,
      probeMcpProcesses: cleanGate,
      probeTree: async () => ++probes === 2
        ? { status: "blocked", reason: "post_rename_open", output: "nheld" }
        : await emptyTree(),
    });
    check(
      result.exitCode !== 0 &&
      result.decisions[0].action === "operator_required" &&
      result.decisions.length === 1 &&
      readFileSync(join(result.quarantinePath, "mcp-chrome-1234abc", "data"), "utf8") === "1234abc" &&
      readFileSync(join(b.profile_path, "data"), "utf8") === "2345bcd",
      "post-rename uncertainty preserves both sides, stops later entries, and exits nonzero",
    );
  }

  check(classifyLsofResult(1, "", "").status === "empty", "lsof rc=1 plus empty stdout is the only clean state");
  for (const [code, stdout] of [[0, ""], [1, "nfile"], [2, ""]]) {
    check(classifyLsofResult(code, stdout, "err").status === "blocked", `lsof rc=${code} stdout=${stdout || "empty"} fails closed`);
  }

  {
    const f = fixture();
    const held = join(f.cacheRoot, "held");
    mkdirSync(held); writeFileSync(join(held, "data"), "held");
    const child = spawn(process.execPath, ["-e", [
      'const fs = require("node:fs")',
      'fs.openSync(process.argv[1], "r")',
      'process.stdout.write("ready\\n")',
      'setInterval(() => {}, 1000)',
    ].join(";"), join(held, "data")], { stdio: ["ignore", "pipe", "inherit"] });
    await once(child.stdout, "data");
    const open = await probeTreeOpenFiles(held);
    child.kill("SIGTERM");
    await once(child, "exit");
    check(open.status === "blocked" && open.output.includes(join(held, "data")),
      "real recursive lsof probe detects a file held by another process");
  }

  {
    const f = fixture();
    const a = entry(f.cacheRoot, "1234abc", join(f.root, "gone"));
    mkdirSync(a.profile_path); writeFileSync(join(a.profile_path, "data"), "same"); makeOld(a.profile_path);
    writeManifest(f.manifestPath, [a]);
    const before = readFileSync(join(a.profile_path, "data"), "utf8");
    const filesBefore = readdirSync(f.cacheRoot).sort().join("\n");
    const result = await runLegacyProfileQuarantine({
      manifestPath: f.manifestPath, cacheRoot: f.cacheRoot, dryRun: true, now: () => NOW,
      probeMcpProcesses: cleanGate, probeTree: emptyTree,
    });
    check(result.decisions[0].action === "would_move" &&
      readFileSync(join(a.profile_path, "data"), "utf8") === before &&
      readdirSync(f.cacheRoot).sort().join("\n") === filesBefore,
      "dry-run reports eligibility with zero filesystem mutation");
  }

  for (const unsafe of ["symlink", "owner", "missing-ledger"]) {
    const f = fixture();
    const q = join(f.cacheRoot, `.fly1867-quarantine-${unsafe}`);
    if (unsafe === "symlink") {
      const target = join(f.root, "target"); mkdirSync(target); symlinkSync(target, q);
    } else {
      mkdirSync(q);
      if (unsafe !== "missing-ledger") writeFileSync(join(q, "ledger.jsonl"),
        `${JSON.stringify({ at: "2026-08-19T00:00:00.000Z", quarantine_path: q })}\n`);
    }
    const later = new Date("2026-08-28T16:00:00.000Z");
    check(
      await rejects(
        () => deleteLegacyProfileQuarantine({ cacheRoot: f.cacheRoot, quarantinePath: q,
          now: () => later, probeTree: emptyTree,
          ...(unsafe === "owner" ? { uid: process.getuid() + 1 } : {}) }),
        /ownership|ledger/,
      ) && existsSync(q),
      `delete refuses an unsafe ${unsafe} quarantine`,
    );
  }

  {
    const q = movedFixture.result.quarantinePath;
    const later = new Date("2026-08-28T16:00:00.000Z");
    check(
      await rejects(
        () => deleteLegacyProfileQuarantine({ cacheRoot: movedFixture.cacheRoot,
          quarantinePath: join(movedFixture.cacheRoot, "not-a-fly1867-quarantine"), now: () => later, probeTree: emptyTree }),
        /exact FLY-1867 quarantine/,
      ),
      "delete refuses a non-exact quarantine path",
    );
    check(
      await rejects(
        () => deleteLegacyProfileQuarantine({ cacheRoot: movedFixture.cacheRoot, quarantinePath: q, now: () => NOW, probeTree: emptyTree }),
        /observation period/,
      ),
      "delete refuses a quarantine younger than seven days",
    );
    check(
      await rejects(
        () => deleteLegacyProfileQuarantine({ cacheRoot: movedFixture.cacheRoot, quarantinePath: q, now: () => later,
          probeTree: async () => ({ status: "blocked", reason: "open_files", output: "nheld" }) }),
        /lsof/,
      ),
      "delete refuses an open quarantine",
    );
    await deleteLegacyProfileQuarantine({ cacheRoot: movedFixture.cacheRoot, quarantinePath: q, now: () => later, probeTree: emptyTree });
    check(await rejects(() => Promise.resolve(readFileSync(join(q, "ledger.jsonl"))), /ENOENT/),
      "delete removes the exact ledger-bound quarantine only after every gate passes");
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`1..${pass + fail}`);
console.log(`# pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
NODE

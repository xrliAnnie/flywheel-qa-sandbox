// FLY-1501 QA — independent real-behaviour check of ledger item 3 (CLI footgun).
// Boots a real HTTP listener as the Bridge, points the CLI at it, and proves the
// "query-shaped write" can no longer reach the network without explicit args.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(
	new URL("../../packages/flywheel-comm/dist/index.js", import.meta.url),
);

// The emitter writes a fail-closed marker under $HOME/.flywheel/state when a
// Bridge delivery exhausts its retries. Give the CLI a throwaway HOME so this
// harness can never touch real user state.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "qa-fly1501-footgun-home-"));

// Distinct-but-valid values, so a CLI that merely checked flag *presence* and
// then silently used the env fallback for the payload would be caught.
const ENV_EXEC_ID = "eeeeeeee-1111-2222-3333-eeeeeeeeeeee";
const ENV_HEAD = "e".repeat(40);
const EXPLICIT_EXEC_ID = "11111111-2222-3333-4444-555555555555";
const EXPLICIT_HEAD = "a".repeat(40);

const hits = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", () => {
		hits.push({ method: req.method, url: req.url, body });
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const bridge = `http://127.0.0.1:${port}`;

function run(args) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[CLI, "codex-review-result", ...args],
			{
				env: {
					...process.env,
					HOME: FAKE_HOME,
					FLYWHEEL_BRIDGE_URL: bridge,
					BRIDGE_URL: bridge,
					FLYWHEEL_EXEC_ID: ENV_EXEC_ID,
					FLYWHEEL_PR_HEAD_SHA: ENV_HEAD,
					FLYWHEEL_CODEX_REVIEW_ROUNDS: "3",
					FLYWHEEL_ISSUE_ID: "FLY-1501",
					FLYWHEEL_PROJECT_NAME: "flywheel",
				},
				encoding: "utf8",
			},
			(error, stdout, stderr) =>
				resolve({ code: error?.code ?? 0, stdout, stderr }),
		);
	});
}

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
	if (String(got) === String(want)) {
		pass++;
		console.log(`PASS  ${name} (${got})`);
	} else {
		fail++;
		console.log(`FAIL  ${name}: want [${want}] got [${got}]`);
	}
};

const cases = [
	["bare call (env fully populated)", []],
	["missing --pr-head", ["--exec-id", EXPLICIT_EXEC_ID]],
	["missing --exec-id", ["--pr-head", "b".repeat(40)]],
	["short sha", ["--exec-id", "e1", "--pr-head", "abc123"]],
	["non-hex sha", ["--exec-id", "e1", "--pr-head", "z".repeat(40)]],
	["blank exec id", ["--exec-id", "   ", "--pr-head", "c".repeat(40)]],
];

for (const [name, args] of cases) {
	const before = hits.length;
	const res = await run(args);
	eq(`${name} — exit`, res.code, 1);
	eq(
		`${name} — usage on stderr`,
		/Usage: flywheel-comm codex-review-result/.test(res.stderr),
		true,
	);
	eq(`${name} — zero Bridge requests`, hits.length - before, 0);
}

// Same-path positive control: a fully explicit, legal invocation must reach the
// Bridge through the very code path the cases above exercised. Without this,
// "zero requests" would also be satisfied by a CLI that can never emit at all.
const before = hits.length;
const legal = await run([
	"--exec-id",
	EXPLICIT_EXEC_ID,
	"--pr-head",
	EXPLICIT_HEAD,
]);
eq("positive control — legal call exits 0", legal.code, 0);
eq("positive control — exactly one Bridge write", hits.length - before, 1);
const written = hits.at(-1);
eq("positive control — POST", written?.method, "POST");
// The payload must carry the EXPLICIT values, never the different env fallbacks.
eq(
	"positive control — carries the explicit head",
	(written?.body ?? "").includes(`"prHeadSha":"${EXPLICIT_HEAD}"`),
	true,
);
eq(
	"positive control — carries the explicit exec id",
	(written?.body ?? "").includes(`"targetExecutionId":"${EXPLICIT_EXEC_ID}"`),
	true,
);
eq(
	"positive control — env head never leaked into the payload",
	(written?.body ?? "").includes(ENV_HEAD),
	false,
);
eq(
	"positive control — env exec id never leaked into the payload",
	(written?.body ?? "").includes(ENV_EXEC_ID),
	false,
);

// The harness must not have written anything into real user state.
eq(
	"no failure marker written under the throwaway HOME",
	existsSync(
		join(FAKE_HOME, ".flywheel", "state", "codex-review-result-failed"),
	),
	false,
);
rmSync(FAKE_HOME, { recursive: true, force: true });

server.close();
console.log(`\nTOTAL pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

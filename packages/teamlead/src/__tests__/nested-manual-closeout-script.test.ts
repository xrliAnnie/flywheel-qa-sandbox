import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = new URL(
	"../../../../scripts/nested-manual-closeout.sh",
	import.meta.url,
).pathname;
const DIGEST = "d".repeat(64);
const HEAD = "a".repeat(40);
const tempDirs: string[] = [];

function run(mode: "partial" | "all" | "recovered") {
	const dir = mkdtempSync(join(tmpdir(), "fly1434-closeout-"));
	tempDirs.push(dir);
	const mockCurl = join(dir, "curl");
	writeFileSync(
		mockCurl,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const url = args.find((arg) => arg.startsWith("http://"));
const method = args.includes("POST") ? "POST" : "GET";
fs.appendFileSync(process.env.MOCK_ACCESS_LOG, method + " " + url + "\\n");
const marker = process.env.MOCK_STATE;
if (method === "POST") {
  const dataArg = args[args.indexOf("--data-binary") + 1];
  const body = JSON.parse(fs.readFileSync(dataArg.slice(1), "utf8"));
  fs.writeFileSync(marker, JSON.stringify(body));
  fs.writeFileSync(output, JSON.stringify({
    success: true,
    runId: "run-nested",
    status: "terminated"
  }));
  process.stdout.write("200");
  process.exit(0);
}
if (fs.existsSync(marker)) {
  const body = JSON.parse(fs.readFileSync(marker, "utf8"));
  fs.writeFileSync(output, JSON.stringify({
    schema_version: 1,
    run: { status: "terminated" },
    latest_hold: { reason: "nested_land_unsupported" },
    quiescence: { quiescent: true },
    receipts: { attributed_out_of_set: 0 },
    finalization: { state: null },
    land_operation: { present: false },
    truncated: {
      nodes: false,
      gate_holders: false,
      claims: false,
      pr_bindings: false,
      declared_prs: false
    },
    pr_manifest: { sealed: true, expected_count: 2, current_revision: 1 },
    declared_prs: [
      {
        state: "merged",
        probe_repo_slug: "geoforge3d/one",
        pr_number: 1,
        frozen_head_sha: "${HEAD}"
      },
      {
        state: "merged",
        probe_repo_slug: "geoforge3d/two",
        pr_number: 2,
        frozen_head_sha: "${HEAD}"
      }
    ],
    latest_termination: {
      closeout_kind: "nested_manual",
      closeout_invariant_digest: body.closeoutInvariantDigest,
      client_request_id: body.clientRequestId
    }
  }));
  process.stdout.write("200");
  process.exit(0);
}
const all = process.env.MOCK_MODE === "all";
fs.writeFileSync(output, JSON.stringify({
  schema_version: 1,
  run: { status: "held" },
  latest_hold: { reason: "nested_land_unsupported" },
  quiescence: { quiescent: true },
  receipts: { attributed_out_of_set: 0 },
  finalization: { state: null },
  land_operation: { present: false },
  truncated: {
    nodes: false,
    gate_holders: false,
    claims: false,
    pr_bindings: false,
    declared_prs: false
  },
  pr_manifest: { sealed: true, expected_count: 2, current_revision: 1 },
  declared_prs: [
    {
      state: "merged",
      probe_repo_slug: "geoforge3d/one",
      pr_number: 1,
      frozen_head_sha: "${HEAD}"
    },
    {
      state: all ? "merged" : "declared",
      probe_repo_slug: "geoforge3d/two",
      pr_number: 2,
      frozen_head_sha: "${HEAD}"
    }
  ],
  closeout_invariant_digest: "${DIGEST}"
}));
process.stdout.write("200");
`,
	);
	chmodSync(mockCurl, 0o755);
	const mockGh = join(dir, "gh");
	writeFileSync(
		mockGh,
		`#!/usr/bin/env node
process.stdout.write(JSON.stringify({ state: "MERGED", headRefOid: "${HEAD}" }));
`,
	);
	chmodSync(mockGh, 0o755);
	const accessLog = join(dir, "access.log");
	const stateFile = join(dir, "state.json");
	if (mode === "recovered") {
		writeFileSync(
			stateFile,
			JSON.stringify({
				closeoutInvariantDigest: DIGEST,
				clientRequestId: `nested-closeout-run-nested-${DIGEST}`,
			}),
		);
	}
	const result = spawnSync("bash", [SCRIPT, "run-nested"], {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
			TEAMLEAD_API_TOKEN: "master-secret",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:3000",
			MOCK_MODE: mode,
			MOCK_ACCESS_LOG: accessLog,
			MOCK_STATE: stateFile,
		},
	});
	return {
		...result,
		access: readFileSync(accessLog, "utf8"),
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("nested manual closeout runbook script", () => {
	it("does not issue terminate while one of two declared PRs is unmerged", () => {
		const result = run("partial");
		expect(result.status).not.toBe(0);
		expect(result.access).not.toContain("POST ");
	});

	it("terminates and post-verifies only after the full declared set is merged", () => {
		const result = run("all");
		expect(result.status).toBe(0);
		expect(result.access.match(/^POST /gm)).toHaveLength(1);
		expect(result.stdout).toContain(`terminated with invariant ${DIGEST}`);
	});

	it("recovers a lost POST response from the persisted typed termination", () => {
		const result = run("recovered");
		expect(result.status).toBe(0);
		expect(result.access).not.toContain("POST ");
		expect(result.stdout).toContain("CLOSEOUT OK");
	});
});

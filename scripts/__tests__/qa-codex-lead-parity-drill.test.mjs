import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LEAD_CAPABILITY_CATALOG } from "../../packages/teamlead/dist/lead-capabilities/catalog.js";
import {
	collectIsolatedParityFixture,
	summarizeFixtureCoverage,
	verifyParityEvidence,
} from "../qa-codex-lead-parity-drill.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "parity-proof-"));
	const binding = {
		project: "fixture",
		lead: "fixture",
		identityDigest: "a".repeat(64),
		activationId: "activation",
		threadId: "thread",
		sourceSha: "b".repeat(40),
		deployedSha: "b".repeat(40),
		manifestDigest: "c".repeat(64),
		issueId: "ISSUE-1",
		runId: "run",
		executionId: "exec",
	};
	const evidence = {
		schemaVersion: 1,
		mode: "isolated-drill",
		scope: "fixture",
		...binding,
		cliVersion: "0.153.2",
		browserVersion: "1.9.0",
		startedAt: "2026-09-14T00:00:00Z",
		finishedAt: "2026-09-14T00:01:00Z",
		rows: [],
		files: {},
		traceRef: "trace.json",
		forbiddenCallsObserved: 0,
	};
	const put = (name, data) => {
		const bytes = JSON.stringify(data);
		writeFileSync(join(root, name), bytes);
		evidence.files[name] = createHash("sha256").update(bytes).digest("hex");
	};
	for (let n = 1; n <= 17; n++) {
		const id = `P${String(n).padStart(2, "0")}`;
		const operationId =
			n === 13
				? "rules.load"
				: n === 14
					? "skills.load"
					: LEAD_CAPABILITY_CATALOG.find(
							(op) => op.parityId === id && op.classification !== "reserved",
						)?.operationId;
		assert.ok(operationId);
		const name = `${id}.json`;
		put(name, {
			schemaVersion: 1,
			binding,
			scope: "fixture",
			kind: "operation-check",
			operationId,
			positive: { passed: true },
			negative: { passed: true },
		});
		evidence.rows.push({
			id,
			operationId,
			status: "passed",
			evidenceRefs: [name],
			observedAt: evidence.finishedAt,
		});
	}
	put("trace.json", {
		schemaVersion: 1,
		binding,
		scope: "fixture",
		kind: "complete-tool-trace",
		events: [
			{ sequence: 1, type: "begin" },
			...evidence.rows.map((row, i) => ({
				sequence: i + 2,
				type: "tool",
				operationId: row.operationId,
				toolName: `native.${row.operationId}`,
			})),
			{ sequence: 19, type: "end" },
		],
	});
	return {
		root,
		evidence,
		binding,
		put,
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("inventory cannot be passed off as a completed drill", () => {
	assert.throws(
		() =>
			verifyParityEvidence({
				evidence: { schemaVersion: 1, parityVerified: false, rows: [] },
				evidenceRoot: "/tmp",
				expectedHead: "b".repeat(40),
			}),
		/parity_evidence_invalid/,
	);
});

test("complete fixture evidence remains unverified without actual browser host evidence", () => {
	const f = fixture();
	try {
		const result = verifyParityEvidence({
			evidence: f.evidence,
			evidenceRoot: f.root,
			expectedHead: f.binding.sourceSha,
		});
		assert.equal(result.fixtureEvidenceConsistent, true);
		assert.equal(result.hostVerified, false);
		assert.equal(result.parityVerified, false);
		assert.ok(result.missing.includes("native_browser_host_evidence"));
	} finally {
		f.close();
	}
});

test("rejects omitted capability rows, wrong head, changed references and mixed activation receipts", () => {
	const f = fixture();
	try {
		const verify = (evidence = f.evidence) =>
			verifyParityEvidence({
				evidence,
				evidenceRoot: f.root,
				expectedHead: f.binding.sourceSha,
			});
		assert.throws(
			() => verify({ ...f.evidence, rows: f.evidence.rows.slice(1) }),
			/parity_missing_rows/,
		);
		assert.throws(
			() => verify({ ...f.evidence, sourceSha: "d".repeat(40) }),
			/parity_head_mismatch/,
		);
		writeFileSync(join(f.root, "P01.json"), "{}");
		assert.throws(() => verify(), /parity_reference_changed/);
		f.put("P01.json", {
			schemaVersion: 1,
			binding: { ...f.binding, activationId: "foreign" },
			scope: "fixture",
		});
		assert.throws(() => verify(), /parity_binding_mismatch/);
	} finally {
		f.close();
	}
});

test("requires complete sequential trace and independently rejects Claude calls", () => {
	const f = fixture();
	try {
		const verify = () =>
			verifyParityEvidence({
				evidence: f.evidence,
				evidenceRoot: f.root,
				expectedHead: f.binding.sourceSha,
			});
		f.put("trace.json", {
			schemaVersion: 1,
			binding: f.binding,
			scope: "fixture",
			kind: "complete-tool-trace",
			events: [
				{ sequence: 1, type: "begin" },
				{ sequence: 3, type: "end" },
			],
		});
		assert.throws(verify, /parity_trace_incomplete/);
		f.put("trace.json", {
			schemaVersion: 1,
			binding: f.binding,
			scope: "fixture",
			kind: "complete-tool-trace",
			events: [
				{ sequence: 1, type: "begin" },
				{
					sequence: 2,
					type: "tool",
					operationId: "browser.list_pages",
					toolName: "mcp__claude-in-chrome__navigate",
				},
				{ sequence: 3, type: "end" },
			],
		});
		assert.throws(verify, /parity_forbidden_call/);
	} finally {
		f.close();
	}
});

test("rejects escaping, symlink and oversized evidence references", () => {
	const f = fixture();
	try {
		const verify = () =>
			verifyParityEvidence({
				evidence: f.evidence,
				evidenceRoot: f.root,
				expectedHead: f.binding.sourceSha,
			});
		const original = f.evidence.rows[0].evidenceRefs;
		f.evidence.rows[0].evidenceRefs = ["../outside.json"];
		assert.throws(verify, /parity_reference_invalid/);
		f.evidence.rows[0].evidenceRefs = original;
		rmSync(join(f.root, "P01.json"));
		symlinkSync(join(f.root, "P02.json"), join(f.root, "P01.json"));
		assert.throws(verify, /parity_reference_invalid/);
		rmSync(join(f.root, "P01.json"));
		writeFileSync(join(f.root, "P01.json"), Buffer.alloc(4 * 1024 * 1024 + 1));
		assert.throws(verify, /parity_reference_invalid/);
	} finally {
		f.close();
	}
});

test("cannot turn declared host or business booleans into verified acceptance", () => {
	const f = fixture();
	try {
		const result = verifyParityEvidence({
			evidence: { ...f.evidence, hostVerified: true, parityVerified: true },
			evidenceRoot: f.root,
			expectedHead: f.binding.sourceSha,
		});
		assert.equal(result.hostVerified, false);
		assert.equal(result.parityVerified, false);
		assert.ok(result.missing.includes("isolated_execution_attestation"));
	} finally {
		f.close();
	}
});

test("fixture execution refuses to reuse an existing evidence directory", () => {
	const f = fixture();
	try {
		assert.throws(
			() => collectIsolatedParityFixture({ outputRoot: f.root }),
			/EEXIST/,
		);
		assert.equal(
			verifyParityEvidence({
				evidence: f.evidence,
				evidenceRoot: f.root,
				expectedHead: f.binding.sourceSha,
			}).fixtureEvidenceConsistent,
			true,
		);
	} finally {
		f.close();
	}
});

test("fixture coverage derives row references from matching requests and results without claiming parity", () => {
	const fixture = {
		trace: [
			{
				request: { operationId: "start_runner", requestId: "one" },
				result: { requestId: "one", status: "succeeded" },
			},
			{
				request: { operationId: "start_runner", requestId: "two" },
				result: { requestId: "two", status: "rejected" },
			},
		],
	};
	const rows = summarizeFixtureCoverage(fixture);
	assert.equal(rows.length, 17);
	assert.deepEqual(rows[0].positiveRefs, ["fixture.json#/trace/0"]);
	assert.deepEqual(rows[0].negativeRefs, ["fixture.json#/trace/1"]);
	assert.equal(rows[0].status, "representative_fixture_exercised");
	assert.equal(rows[1].status, "unverified");
	assert.ok(rows.every((row) => row.parityVerified === false));
	fixture.trace[0].result.requestId = "foreign";
	assert.throws(
		() => summarizeFixtureCoverage(fixture),
		/parity_trace_request_mismatch/,
	);
});

test("fixture coverage rejects forbidden tools and does not promote a fake browser or declared host flags", () => {
	const fixture = {
		hostVerified: true,
		parityVerified: true,
		trace: [
			{
				request: { operationId: "browser.list_pages", requestId: "one" },
				result: { requestId: "one", status: "succeeded" },
			},
		],
	};
	assert.equal(
		summarizeFixtureCoverage(fixture)[11].status,
		"provider_fixture_only",
	);
	fixture.trace[0].request.operationId = "mcp__claude-in-chrome__navigate";
	assert.throws(
		() => summarizeFixtureCoverage(fixture),
		/parity_forbidden_call/,
	);
});

test("source rows require same issue and activation and preserve single-adapter scope", () => {
	const fixture = {
		issueId: "FLY-2519",
		activationId: "a1",
		trace: [],
		sourceChecks: {
			issueId: "FLY-2519",
			activationId: "a1",
			rules: {
				loaded: true,
				wrongDigestRejected: true,
				sha256: "a".repeat(64),
			},
			skills: {
				installed: true,
				wrongDigestRejected: true,
				sha256: "b".repeat(64),
				scope: "single_fixture_adapter",
			},
		},
	};
	const rows = summarizeFixtureCoverage(fixture);
	assert.equal(rows[12].status, "representative_fixture_exercised");
	assert.equal(rows[13].status, "representative_fixture_exercised");
	assert.deepEqual(rows[13].positiveRefs, [
		"fixture.json#/sourceChecks/skills",
	]);
	fixture.sourceChecks.activationId = "foreign";
	assert.equal(summarizeFixtureCoverage(fixture)[12].status, "unverified");
});

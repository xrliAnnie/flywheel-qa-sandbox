import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	activityEvidence,
	runPatrolContinuity,
} from "../patrol-continuity-cli.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("patrol helper CLI", () => {
	it("projects verified package queue fields into machine evidence", () => {
		const line = activityEvidence(
			{
				key: "a".repeat(64),
				activity: "WAITING",
				reason: "package_gate_queue",
				last_change_basis: "baseline",
				interval_start: 1,
				interval_end: 2,
				branch_activity: false,
				last_change_epoch: 1,
				entry: {
					identity: { activationId: "activation:test" },
					refs: [],
					sourcesComplete: true,
					semanticDigest: "b".repeat(64),
					coverageSinceMs: 1_000,
					queueEvidence: {
						requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						status: "queued",
						seq: 1,
						position: 3,
						enqueuedAt: "2026-09-18T02:00:00.000Z",
						observedAt: "2026-09-18T02:01:05.000Z",
						revision: 2,
						waitMs: 65_000,
					},
				},
			} as never,
			"exec",
			2_000,
		)[0];
		expect(line).toContain(
			"queue_request=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa queue_position=3 queue_wait_seconds=65",
		);
	});
	it("validates reports without opening any production data source", async () => {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(
			path,
			"patrol_schema=2\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T00:00:00.000Z token=project_scope\nMECHANISM_REVIEW result=none count=0\n",
		);
		expect(
			await runPatrolContinuity(["validate-report", "--report", path]),
		).toBe(0);
		writeFileSync(
			path,
			"patrol_schema=2\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T00:00:00.000Z token=project_scope\nMECHANISM_REVIEW result=findings count=1\nMECHANISM_DEFECT id=" +
				"a".repeat(64) +
				" step=2 class_key=" +
				"b".repeat(64) +
				" root_cause_ref=root counterexample_ref=counter\n",
		);
		expect(
			await runPatrolContinuity(["validate-report", "--report", path]),
		).not.toBe(0);
	});
	it("rejects tampered machine identity and ref digests in report validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(
			path,
			"patrol_schema=2\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T00:00:00.000Z token=project_scope\nMECHANISM_REVIEW result=none count=0\nACTIVITY_RECORD " +
				JSON.stringify({
					id: "a".repeat(64),
					entry: { identity: { executionId: "fake" }, refs: [] },
					sampledAtMs: 1,
					activity: "ACTIVE",
					interval_start: 0,
					interval_end: 1,
				}) +
				"\n",
		);
		expect(
			await runPatrolContinuity(["validate-report", "--report", path]),
		).not.toBe(0);
	});
	it("rejects duplicate or arbitrary loader options", async () => {
		expect(
			await runPatrolContinuity(["sample", "--module", "/tmp/evil.js"]),
		).not.toBe(0);
		expect(
			await runPatrolContinuity([
				"validate-report",
				"--report",
				"a",
				"--report",
				"b",
			]),
		).not.toBe(0);
	});
	it("fails closed when recheck has no exact machine record", async () => {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(path, "patrol_schema=2\n");
		expect(
			await runPatrolContinuity([
				"--recheck",
				"--report",
				path,
				"--evidence-id",
				"a".repeat(64),
			]),
		).not.toBe(0);
	});
});

describe("FLY-2914 validate-report root-cause verification", () => {
	const header =
		"# Lead Patrol Snapshot\npatrol_schema=2\nproject: flywheel\nlead: flywheel-eng-lead\n";
	const complete = `${header}MECHANISM_REVIEW result=none count=0\nSTEP 6: OK\nROOT_CAUSE_REVIEW status=complete parent=FLY-2072 observed_at=2026-09-26T06:00:00.000Z count=0 source_digest=4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945 children=0 pages=1 non_category=0 excluded=0\n`;
	async function withBridge(
		reply: (body: string) => { status: number; json: unknown },
		run: (url: string, seen: string[]) => Promise<void>,
	) {
		const { createServer } = await import("node:http");
		const seen: string[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
				const r = reply(body);
				res.writeHead(r.status, { "content-type": "application/json" });
				res.end(JSON.stringify(r.json));
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address() as { port: number };
		const saved = {
			url: process.env.BRIDGE_URL,
			token: process.env.TEAMLEAD_API_TOKEN,
		};
		process.env.BRIDGE_URL = `http://127.0.0.1:${address.port}`;
		process.env.TEAMLEAD_API_TOKEN = "token-2914";
		try {
			await run(process.env.BRIDGE_URL, seen);
		} finally {
			process.env.BRIDGE_URL = saved.url;
			process.env.TEAMLEAD_API_TOKEN = saved.token;
			if (saved.url === undefined) delete process.env.BRIDGE_URL;
			if (saved.token === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			server.close();
		}
	}
	function file(text: string) {
		const root = mkdtempSync(join(tmpdir(), "patrol-cli-2914-"));
		roots.push(root);
		const path = join(root, "report.md");
		writeFileSync(path, text);
		return path;
	}
	it("asks the Bridge verifier for a complete section and fails on its verdict", async () => {
		const path = file(complete);
		await withBridge(
			() => ({
				status: 200,
				json: { valid: false, errors: ["root_cause_snapshot_stale"] },
			}),
			async (_url, seen) => {
				expect(
					await runPatrolContinuity(["validate-report", "--report", path]),
				).toBe(1);
				expect(seen).toEqual([
					"POST /api/patrol/root-causes/verify Bearer token-2914",
				]);
			},
		);
		await withBridge(
			() => ({ status: 200, json: { valid: true, errors: [] } }),
			async () => {
				expect(
					await runPatrolContinuity(["validate-report", "--report", path]),
				).toBe(0);
			},
		);
	});
	it("fails a complete section when the verifier cannot be reached", async () => {
		const path = file(complete);
		const saved = process.env.BRIDGE_URL;
		process.env.BRIDGE_URL = "http://127.0.0.1:9";
		process.env.TEAMLEAD_API_TOKEN = "token-2914";
		try {
			expect(
				await runPatrolContinuity(["validate-report", "--report", path]),
			).toBe(1);
		} finally {
			if (saved === undefined) delete process.env.BRIDGE_URL;
			else process.env.BRIDGE_URL = saved;
			delete process.env.TEAMLEAD_API_TOKEN;
		}
	});
	it("never contacts the Bridge for a not_applicable section", async () => {
		const path = file(
			"# Lead Patrol Snapshot\npatrol_schema=2\nproject: geoforge3d\nlead: product-lead\nMECHANISM_REVIEW result=none count=0\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T06:00:00.000Z token=project_scope\n",
		);
		await withBridge(
			() => ({ status: 500, json: {} }),
			async (_url, seen) => {
				expect(
					await runPatrolContinuity(["validate-report", "--report", path]),
				).toBe(0);
				expect(seen).toEqual([]);
			},
		);
	});
});

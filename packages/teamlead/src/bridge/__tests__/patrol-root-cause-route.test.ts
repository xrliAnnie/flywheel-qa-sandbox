/** FLY-2914: shell-path root-cause facts and verdicts come only from the Bridge. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LinearRequest,
	ROOT_CAUSE_LINEAR_PROJECT_ID,
} from "../../patrol-root-causes.js";
import { StateStore } from "../../StateStore.js";
import { createPatrolRootCauseRouter } from "../patrol-root-cause-route.js";

const PARENT = "5914cef5-05bf-45a3-be14-edbc858147a2";
const child = (n: number) => ({
	id: `00000000-0000-4000-8000-00000000000${n}`,
	identifier: `FLY-900${n}`,
	title: `[病根] c${n} · ×${n + 3}`,
	description: `class_key: ${String(n).repeat(64)}`,
	url: `https://linear.app/x/issue/FLY-900${n}`,
	state: { name: "Backlog", type: "backlog" },
	parent: { id: PARENT },
	project: { id: ROOT_CAUSE_LINEAR_PROJECT_ID },
});
let children = [child(1)];
const linear = vi.fn((async (query: string) =>
	query.includes("RootCauseParent")
		? {
				data: {
					issue: {
						id: PARENT,
						identifier: "FLY-2072",
						team: { key: "FLY" },
						project: { id: ROOT_CAUSE_LINEAR_PROJECT_ID },
					},
				},
			}
		: {
				data: {
					issue: {
						id: PARENT,
						children: {
							nodes: children,
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			}) as LinearRequest);

let server: Server;
let store: StateStore;
let stateDir: string;
async function call(method: string, path: string, body?: unknown) {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("unbound");
	const res = await fetch(
		`http://127.0.0.1:${addr.port}/api/patrol/root-causes${path}`,
		{
			method,
			headers: { "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

describe("FLY-2914 patrol root-cause route", () => {
	beforeEach(async () => {
		children = [child(1)];
		stateDir = mkdtempSync(join(tmpdir(), "rc-route-"));
		store = await StateStore.create(":memory:");
		const app = express();
		app.use(express.json({ limit: "2mb" }));
		app.use(
			"/api/patrol/root-causes",
			createPatrolRootCauseRouter({
				store,
				getAsk: (id) => store.getFounderAsk(id),
				linearRequest: () => linear,
				stateDir,
			}),
		);
		server = createServer(app);
		server.listen(0);
	});
	afterEach(() => {
		server.close();
		store.close();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("renders complete lines for the owner and not_applicable for others", async () => {
		const owner = await call(
			"GET",
			"?projectName=flywheel&leadId=flywheel-eng-lead",
		);
		expect(owner.status).toBe(200);
		const lines = owner.body.lines as string[];
		expect(lines[0]).toMatch(/^ROOT_CAUSE_REVIEW status=complete .* count=1 /);
		expect(lines[1]).toContain('"identifier":"FLY-9001"');
		const other = await call(
			"GET",
			"?projectName=geoforge3d&leadId=product-lead",
		);
		expect(other.body.lines).toEqual([
			expect.stringMatching(
				/^ROOT_CAUSE_REVIEW status=not_applicable .* token=project_scope$/,
			),
		]);
		expect((await call("GET", "?projectName=../x&leadId=a")).status).toBe(400);
	});

	it("carries the previous report's unexpired schedule forward", async () => {
		const first = (
			await call("GET", "?projectName=flywheel&leadId=flywheel-eng-lead")
		).body.lines as string[];
		const candidate = JSON.parse(
			first[1]!.slice("ROOT_CAUSE_CANDIDATE ".length),
		);
		const digest = /source_digest=([0-9a-f]{64})/.exec(first[0]!)![1];
		const dir = join(stateDir, "patrol-reports", "flywheel-eng-lead");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "20260926T060000Z-tick1.md"),
			`ROOT_CAUSE_DISPOSITION ${JSON.stringify({
				ref: candidate.ref,
				findingId: candidate.findingId,
				scheduleKey: candidate.scheduleKey,
				mode: "scheduled",
				askId: null,
				threadId: null,
				messageId: null,
				reason: "排在 FLY-2915 盘点之后复查，由工程 Lead 负责",
				owner: "agent:flywheel-eng-lead",
				nextReviewAt: new Date(Date.now() + 86_400_000).toISOString(),
				sourceDigest: digest,
			})}\n`,
		);
		const next = (
			await call("GET", "?projectName=flywheel&leadId=flywheel-eng-lead")
		).body.lines as string[];
		expect(
			next.some(
				(l) =>
					l.startsWith("ROOT_CAUSE_DISPOSITION ") &&
					l.includes('"mode":"scheduled"'),
			),
		).toBe(true);
	});

	it("verifies a shell report against fresh facts and marks a hidden category stale", async () => {
		const lines = (
			await call("GET", "?projectName=flywheel&leadId=flywheel-eng-lead")
		).body.lines as string[];
		const report = `# Lead Patrol Snapshot\npatrol_schema=2\nproject: flywheel\nlead: flywheel-eng-lead\nSTEP 6: FINDING\n${lines.join("\n")}\n`;
		const missing = await call("POST", "/verify", { report });
		expect(missing.body.errors).toContain("root_cause_disposition_missing");
		children = [child(1), child(2)];
		const stale = await call("POST", "/verify", { report });
		expect(stale.body.errors).toContain("root_cause_snapshot_stale");
		expect((await call("POST", "/verify", { report: 7 })).status).toBe(400);
	});
});

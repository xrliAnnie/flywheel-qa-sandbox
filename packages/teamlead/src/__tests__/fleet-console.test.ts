import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequest } from "../bridge/fleet-admin.js";
import { FleetConsole } from "../bridge/fleet-console.js";
import type { BatchJournal } from "../bridge/fleet-progress.js";
import type { ManagementSnapshotProvider } from "../bridge/management-console-snapshot.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const PROJECTS: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "peter",
				chatChannel: "c1",
				match: { labels: ["product"] },
				model: "claude-fable-5",
			},
			{
				agentId: "oliver",
				chatChannel: "c2",
				match: { labels: ["ops"] },
			},
			{
				agentId: "mufasa",
				chatChannel: "c3",
				match: { labels: ["growth"] },
				backend: "codex-app-server",
				companion: true,
				canSpawnRunners: false,
			},
		],
	},
];

const PROJECTS_JSON = JSON.stringify(
	PROJECTS.map((p) => ({
		projectName: p.projectName,
		projectRoot: p.projectRoot,
		leads: p.leads.map((l) => {
			const o: Record<string, unknown> = {
				agentId: l.agentId,
				chatChannel: l.chatChannel,
				match: l.match,
			};
			if (l.model !== undefined) o.model = l.model;
			if (l.backend !== undefined) o.backend = l.backend;
			if (l.companion !== undefined) o.companion = l.companion;
			if (l.canSpawnRunners !== undefined)
				o.canSpawnRunners = l.canSpawnRunners;
			return o;
		}),
	})),
);

function makeConsole(dir: string, over: Partial<Record<string, unknown>> = {}) {
	const projectsJsonPath = join(dir, "projects.json");
	writeFileSync(projectsJsonPath, PROJECTS_JSON);
	return new FleetConsole({
		projectsJsonPath,
		txnDir: join(dir, "fleet-txns"),
		auditDbPath: join(dir, "audit.db"),
		fleetScriptPath: join(dir, "stub-fleet.sh"),
		logDir: join(dir, "fleet-logs"),
		liveProjects: () => PROJECTS,
		legacyBackendOf: () => undefined,
		now: () => 1_000_000,
		...over,
	});
}

function req(batchId: string): CanonicalRequest {
	return {
		batchId,
		expectedConfigSha: "sha",
		changes: [
			{
				key: "geo-peter",
				from: { model: "claude-fable-5" },
				to: { model: null },
			},
		],
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fleet-console-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("FleetConsole — read model", () => {
	it("builds the versioned snapshot from registered management providers", () => {
		let reads = 0;
		const providers: ManagementSnapshotProvider[] = [
			{
				id: "models",
				sourceKind: "model_registry",
				read: () => {
					reads++;
					return { revision: "registry:1", fragment: { modelCatalog: {} } };
				},
			},
		];
		const c = makeConsole(dir, {
			managementSnapshotProviders: () => providers,
		});
		expect(c.buildManagementSnapshot().schemaVersion).toBe(2);
		expect(reads).toBe(1);
		c.close();
	});

	it("configSha matches shasum -a 256 of the projects.json bytes", () => {
		const c = makeConsole(dir);
		const ours = c.configSha();
		const projectsJsonPath = join(dir, "projects.json");
		const expected = execFileSync("shasum", ["-a", "256", projectsJsonPath])
			.toString()
			.split(/\s+/)[0];
		expect(ours).toBe(expected);
		c.close();
	});

	it("currentModels reads fresh from the file (string | null)", () => {
		const c = makeConsole(dir);
		const m = c.currentModels();
		expect(m.get("geo-peter")).toBe("claude-fable-5");
		expect(m.get("geo-oliver")).toBe(null);
		expect(m.get("geo-mufasa")).toBe(null);
		c.close();
	});

	it("buildSnapshot returns every configured Lead with capabilities + engine key", () => {
		const c = makeConsole(dir);
		const snap = c.buildSnapshot();
		expect(snap.leads.map((l) => l.leadId).sort()).toEqual([
			"mufasa",
			"oliver",
			"peter",
		]);
		const peter = snap.leads.find((l) => l.leadId === "peter");
		expect(peter?.key).toBe("geo-peter"); // exact engine key
		const mufasa = snap.leads.find((l) => l.leadId === "mufasa");
		expect(mufasa?.currentBackend).toBe("codex-app-server");
		// Codex tier is display-only → single read-only target (null).
		expect(mufasa?.allowedModelTargets).toEqual([null]);
		c.close();
	});

	it("buildSnapshot enriches the online dot from fleet evidence (stale → unknown)", () => {
		const c = makeConsole(dir, {
			fleetEvidence: () => ({
				collectedAt: "t",
				configState: "live",
				leads: [
					{ key: "geo-peter", presentation: "ONLINE" },
					{ key: "geo-oliver", presentation: "DOWN" },
					{ key: "geo-mufasa", presentation: "DEGRADED" },
				],
			}),
		});
		const snap = c.buildSnapshot();
		expect(snap.leads.find((l) => l.leadId === "peter")?.online).toBe("online");
		expect(snap.leads.find((l) => l.leadId === "oliver")?.online).toBe(
			"offline",
		);
		expect(snap.leads.find((l) => l.leadId === "mufasa")?.online).toBe(
			"degraded",
		);
		c.close();
	});

	it("no fleet evidence → online unknown (never a stale confirmed dot)", () => {
		const c = makeConsole(dir, { fleetEvidence: () => null });
		for (const l of c.buildSnapshot().leads) expect(l.online).toBe("unknown");
		c.close();
	});
});

describe("FleetConsole — createLaunching (R6 #4: before spawn, exclusive)", () => {
	it("creates a launching journal + changes file; second call is rejected", () => {
		const c = makeConsole(dir);
		expect(c.createLaunching("b-1", req("b-1"))).toBe(true);
		const jp = join(dir, "fleet-txns", "batch-b-1.json");
		const cp = join(dir, "fleet-txns", "changes-b-1.json");
		expect(existsSync(jp)).toBe(true);
		expect(existsSync(cp)).toBe(true);
		const j = JSON.parse(readFileSync(jp, "utf8")) as BatchJournal;
		expect(j.batchStatus).toBe("launching");
		expect(j.keys["geo-peter"].status).toBe("pending");
		expect(j.keys["geo-peter"].from.model).toBe("claude-fable-5");
		expect(j.keys["geo-peter"].to.model).toBe(null);
		// Exclusive create — no silent overwrite.
		expect(c.createLaunching("b-1", req("b-1"))).toBe(false);
		c.close();
	});

	it("the changes file is the engine-readable canonical request", () => {
		const c = makeConsole(dir);
		c.createLaunching("b-2", req("b-2"));
		const parsed = JSON.parse(
			readFileSync(join(dir, "fleet-txns", "changes-b-2.json"), "utf8"),
		) as CanonicalRequest;
		expect(parsed.batchId).toBe("b-2");
		expect(parsed.changes[0].key).toBe("geo-peter");
		c.close();
	});
});

describe("FleetConsole — spawnEngine (detached, patches owner.pid)", () => {
	it("spawns the engine and records the pid in the SIDECAR (not the journal)", async () => {
		// A harmless stub that just exits 0 — we only assert spawn + sidecar write.
		const stub = join(dir, "stub-fleet.sh");
		writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
		const c = makeConsole(dir, { fleetScriptPath: stub });
		c.createLaunching("b-3", req("b-3"));
		expect(c.spawnEngine("b-3", req("b-3"))).toBe(true);
		// The real pid goes to the owner sidecar (Codex R1 HIGH-2: never RMW the
		// journal the detached engine is advancing).
		const owner = JSON.parse(
			readFileSync(join(dir, "fleet-txns", "owner-b-3.json"), "utf8"),
		) as { pid: number };
		expect(owner.pid).toBeGreaterThan(0);
		// The journal's owner.pid stays the createLaunching placeholder (0) — the
		// parent never touched the journal after creating it.
		const j = JSON.parse(
			readFileSync(join(dir, "fleet-txns", "batch-b-3.json"), "utf8"),
		) as BatchJournal;
		expect(j.owner?.pid).toBe(0);
		expect(existsSync(join(dir, "fleet-logs", "engine-b-3.log"))).toBe(true);
		c.close();
	});

	it("returns false when the changes file is missing", () => {
		const c = makeConsole(dir);
		expect(c.spawnEngine("nope", req("nope"))).toBe(false);
		c.close();
	});

	it("FLY-2331: observes an asynchronous spawn ENOENT", async () => {
		const logger = vi.fn();
		const oldPath = process.env.PATH;
		process.env.PATH = dir;
		try {
			const c = makeConsole(dir, { logger });
			c.createLaunching("b-enoent", req("b-enoent"));
			expect(c.spawnEngine("b-enoent", req("b-enoent"))).toBe(false);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(logger).toHaveBeenCalledWith(
				expect.stringMatching(/child error:.*ENOENT/),
			);
			c.close();
		} finally {
			process.env.PATH = oldPath;
		}
	});
});

describe("FleetConsole — progress (§2.5)", () => {
	it("reads durable journals into progress DTOs, newest first", () => {
		const c = makeConsole(dir);
		c.createLaunching("b-old", req("b-old"));
		c.createLaunching("b-new", { ...req("b-new"), batchId: "b-new" });
		// Bump b-new's created so it sorts first.
		const np = join(dir, "fleet-txns", "batch-b-new.json");
		const j = JSON.parse(readFileSync(np, "utf8")) as BatchJournal;
		j.owner = { pid: 0, created: 2_000_000 };
		writeFileSync(np, JSON.stringify(j));
		const list = c.listProgress();
		expect(list[0].batchId).toBe("b-new");
		expect(c.progressFor("b-old")?.batchStatus).toBe("launching");
		expect(c.progressFor("missing")).toBe(null);
		c.close();
	});
});

describe("FleetConsole — SSE progress client teardown (R4 MEDIUM-1)", () => {
	it("close() runs every registered progress teardown (no shutdown hang)", () => {
		const c = makeConsole(dir);
		let aStopped = false;
		let bStopped = false;
		c.registerProgress(() => {
			aStopped = true;
		});
		c.registerProgress(() => {
			bStopped = true;
		});
		c.close();
		expect(aStopped).toBe(true);
		expect(bStopped).toBe(true);
	});

	it("unregister removes a client so close() won't call it twice", () => {
		const c = makeConsole(dir);
		let calls = 0;
		const un = c.registerProgress(() => {
			calls++;
		});
		un(); // client disconnected on its own
		c.close();
		expect(calls).toBe(0);
	});

	it("after close(), a late reconnect is rejected (teardown run, not tracked) (R5)", () => {
		const c = makeConsole(dir);
		c.close();
		expect(c.isClosed()).toBe(true);
		let lateStopped = false;
		const un = c.registerProgress(() => {
			lateStopped = true;
		});
		// The late client's teardown is run immediately and it is NOT tracked, so
		// no post-close timer survives to reopen the audit DB.
		expect(lateStopped).toBe(true);
		expect(() => un()).not.toThrow();
	});
});

describe("FleetConsole — startup reconciliation (R8 #2)", () => {
	it("leaves a LIVE engine's batch untouched", async () => {
		const recovered: string[] = [];
		const c = makeConsole(dir, {
			pidAlive: () => true,
			recoverBatch: (id: string) => recovered.push(id),
		});
		c.createLaunching("b-live", req("b-live"));
		// Mark it running with a live pid.
		const jp = join(dir, "fleet-txns", "batch-b-live.json");
		const j = JSON.parse(readFileSync(jp, "utf8")) as BatchJournal;
		j.batchStatus = "running";
		j.owner = { pid: 4242, created: 999 };
		writeFileSync(jp, JSON.stringify(j));
		await c.reconcileOnStartup();
		expect(recovered).toEqual([]); // never overwrite a live txn
		c.close();
	});

	it("recovers a DEAD running batch via the engine's recover", async () => {
		const recovered: string[] = [];
		const c = makeConsole(dir, {
			pidAlive: () => false,
			recoverBatch: (id: string) => recovered.push(id),
		});
		c.createLaunching("b-dead", req("b-dead"));
		const jp = join(dir, "fleet-txns", "batch-b-dead.json");
		const j = JSON.parse(readFileSync(jp, "utf8")) as BatchJournal;
		j.batchStatus = "running";
		j.owner = { pid: 999999, created: 1 };
		writeFileSync(jp, JSON.stringify(j));
		await c.reconcileOnStartup();
		expect(recovered).toEqual(["b-dead"]);
		c.close();
	});

	it("FLY-2331: gives mutating recovery a dedicated 16 MiB output budget", async () => {
		const recoverExec = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const c = makeConsole(dir, {
			pidAlive: () => false,
			recoverExec,
		});
		c.createLaunching("b-output-budget", req("b-output-budget"));
		await c.reconcileOnStartup();

		expect(recoverExec).toHaveBeenCalledWith(
			"bash",
			[
				join(dir, "stub-fleet.sh"),
				"recover",
				"--batch",
				"b-output-budget",
				"--yes",
			],
			expect.objectContaining({
				maxBuffer: 16 * 1024 * 1024,
				timeoutMs: 120_000,
			}),
		);
		c.close();
	});

	it("recovers a DEAD launching batch at boot regardless of age (no deadline strand, MEDIUM-4)", async () => {
		const recovered: string[] = [];
		const c = makeConsole(dir, {
			now: () => 1_000_000,
			pidAlive: () => false,
			recoverBatch: (id: string) => recovered.push(id),
		});
		// A freshly-created launching whose engine is dead — must still be
		// reconciled this boot (the engine is gone; there is no later pass).
		c.createLaunching("b-young", req("b-young"));
		const jp = join(dir, "fleet-txns", "batch-b-young.json");
		const j = JSON.parse(readFileSync(jp, "utf8")) as BatchJournal;
		j.owner = { pid: 999999, created: Math.floor(1_000_000 / 1000) - 1 };
		writeFileSync(jp, JSON.stringify(j));
		await c.reconcileOnStartup();
		expect(recovered).toEqual(["b-young"]);
		c.close();
	});

	it("uses the owner sidecar for liveness (live sidecar → batch left untouched)", async () => {
		const recovered: string[] = [];
		// pidAlive only returns true for the sidecar pid 4242 — proving the
		// liveness check reads the sidecar, not the journal placeholder.
		const c = makeConsole(dir, {
			pidAlive: (pid: number) => pid === 4242,
			recoverBatch: (id: string) => recovered.push(id),
		});
		c.createLaunching("b-side", req("b-side"));
		const jp = join(dir, "fleet-txns", "batch-b-side.json");
		const j = JSON.parse(readFileSync(jp, "utf8")) as BatchJournal;
		j.batchStatus = "running";
		writeFileSync(jp, JSON.stringify(j)); // journal owner.pid stays 0 placeholder
		writeFileSync(
			join(dir, "fleet-txns", "owner-b-side.json"),
			JSON.stringify({ pid: 4242, created: 1 }),
		);
		await c.reconcileOnStartup();
		expect(recovered).toEqual([]); // live engine via sidecar — never touched
		c.close();
	});

	it("upserts apply-result audit for a terminal batch", async () => {
		const c = makeConsole(dir);
		c.createLaunching("b-term", req("b-term"));
		const jp = join(dir, "fleet-txns", "batch-b-term.json");
		const j = JSON.parse(readFileSync(jp, "utf8")) as BatchJournal;
		j.batchStatus = "applied";
		writeFileSync(jp, JSON.stringify(j));
		await c.reconcileOnStartup();
		const rows = c.audit.forBatch("b-term");
		const applyResult = rows.find((r) => r.event === "apply-result");
		expect(applyResult?.result).toBe("applied");
		c.close();
	});

	it("FLY-2331: coalesces overlapping recovery passes", async () => {
		let release!: () => void;
		const deferred = new Promise<void>((resolve) => {
			release = resolve;
		});
		const recovered: string[] = [];
		const c = makeConsole(dir, {
			pidAlive: () => false,
			recoverBatch: async (id: string) => {
				recovered.push(id);
				await deferred;
			},
		});
		c.createLaunching("b-deferred", req("b-deferred"));

		const first = c.reconcileOnStartup();
		const overlapping = c.reconcileOnStartup();
		await Promise.resolve();
		expect(recovered).toEqual(["b-deferred"]);
		release();
		await Promise.all([first, overlapping]);
		expect(recovered).toEqual(["b-deferred"]);
		c.close();
	});

	it("FLY-2331: releases the recovery mutex after rejection", async () => {
		let attempts = 0;
		const c = makeConsole(dir, {
			pidAlive: () => false,
			recoverBatch: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("recover unavailable");
			},
		});
		c.createLaunching("b-retry", req("b-retry"));

		await expect(c.reconcileOnStartup()).rejects.toThrow("recover unavailable");
		await expect(c.reconcileOnStartup()).resolves.toBeUndefined();
		expect(attempts).toBe(2);
		c.close();
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createBridgeApp } from "../plugin.js";
import { ProcessResourceMonitor } from "../process-resource-monitor.js";
import { RunnerAdmissionController } from "../runner-admission.js";

it("serves cached fd data without starting a probe and preserves shutdown semantics", async () => {
	const readFds = vi.fn(async () => ["0", "1", "2"]);
	const readLimits = vi.fn(async () => ({
		soft: 8192,
		kernel: 8192,
		systemFiles: null,
	}));
	const monitor = new ProcessResourceMonitor({
		platform: "darwin",
		readFds,
		readLimits,
	});
	await monitor.sample();
	const store = await StateStore.create(":memory:");
	const shutdownStateHolder = { shuttingDown: false };
	const app = createBridgeApp(
		store,
		[],
		{
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			notificationChannel: "test",
			defaultLeadAgentId: "test",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ processResources: monitor, shutdownStateHolder },
	);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	try {
		for (let i = 0; i < 3; i++) {
			const response = await fetch(`http://127.0.0.1:${address.port}/health`);
			const body = await response.json();
			expect(body).toMatchObject({
				ok: !shutdownStateHolder.shuttingDown,
				shuttingDown: shutdownStateHolder.shuttingDown,
				fd: { used: 3, limit: 8192, status: "fresh" },
			});
			expect(JSON.stringify(body.fd)).not.toMatch(
				/\/dev\/fd|environment|userLimits/,
			);
			shutdownStateHolder.shuttingDown = true;
		}
		expect(readFds).toHaveBeenCalledTimes(1);
		expect(readLimits).toHaveBeenCalledTimes(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await monitor.stop();
		store.close();
	}
});

it("reports failed observation migration over HTTP while preserving authoritative store access", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2563-health-migration-"));
	const path = join(root, "store.db");
	let store: StateStore | undefined;
	try {
		store = await StateStore.create(path);
		store.close();
		store = undefined;
		const raw = new Database(path);
		try {
			raw.exec(
				"DROP INDEX idx_fly2563_verdict_cursor; CREATE INDEX idx_fly2563_verdict_cursor ON workflow_founder_gate_verdict(verdict_id)",
			);
		} finally {
			raw.close();
		}
		store = await StateStore.create(path);
		const app = createBridgeApp(store, [], {
			host: "127.0.0.1",
			port: 0,
			dbPath: path,
			notificationChannel: "test",
			defaultLeadAgentId: "test",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		});
		const server = createServer(app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address() as { port: number };
			const response = await fetch(`http://127.0.0.1:${address.port}/health`);
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toMatchObject({
				ok: true,
				ship_judgment: {
					observation_storage: {
						status: "unavailable",
						reason: "schema_drift",
					},
				},
			});
			expect(JSON.stringify(body)).not.toContain(root);
			expect(() => store!.getShipJudgmentOutcomes()).toThrow(
				"observation_storage_unavailable",
			);
			expect(store.getSession("missing")).toBeUndefined();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	} finally {
		store?.close();
		rmSync(root, { recursive: true, force: true });
	}
});

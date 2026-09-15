import { createServer } from "node:http";
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

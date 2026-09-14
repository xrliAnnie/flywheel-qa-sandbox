import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createReportCriticalSection } from "../../bridge/report-critical-section.js";
import { ReportRegistry } from "../../bridge/report-registry.js";
import { HistoryReportPublisher } from "../history-publisher.js";

it("uploads outside the shared report lock, reuses metadata and verifies exact hosted bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "history-publisher-"));
	try {
		const registry = new ReportRegistry(dir, {
			now: () => Date.parse("2026-09-11T00:00:00.000Z"),
		});
		await registry.ensureVercelProjectName();
		await registry.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: "2026-09-11T00:00:00.000Z",
				gatewayDeploymentId: "fixture",
			},
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
		const critical = createReportCriticalSection();
		let release!: () => void;
		const uploaded = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resumeReport = vi.fn(() => uploaded);
		const fetchImpl = vi.fn<typeof fetch>();
		const publisher = new HistoryReportPublisher({
			registry,
			critical,
			blob: { resumeReport },
			fetchImpl,
		});
		const page = await publisher.stage(
			"<html><head></head><body>history</body></html>",
		);
		const { bindingFixture, NOW } = await import("./binding-fixture.js");
		const { store } = await bindingFixture();
		try {
			const state = store.getShipJudgmentHistoryState(),
				now = Date.parse(NOW),
				claim = state.claim("worker", now);
			if (claim.status !== "claimed") throw new Error(claim.status);
			state.begin(
				claim,
				store.getShipJudgmentHistory().read(NOW),
				publisher.origin(),
				now,
			);
			expect(state.stagePage(claim, 1, page, now)).toBe(true);
		} finally {
			store.close();
		}
		expect(registry.list()).toHaveLength(0);
		const signal = new AbortController().signal,
			pending = publisher.publish(page, signal);
		await critical.run(async () => {
			await registry
				.stagePublish(
					"raya",
					"<html><head></head><body>other</body></html>",
					undefined,
					registry.hostingBinding(),
				)
				.commit();
		});
		expect(registry.list()).toHaveLength(1);
		release();
		await pending;
		expect(registry.list()).toHaveLength(2);
		fetchImpl.mockResolvedValueOnce(new Response(page.html));
		await expect(publisher.verify(page, signal)).resolves.toBeUndefined();
		expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
			redirect: "error",
			headers: { "Cache-Control": "no-cache" },
		});
		fetchImpl.mockResolvedValueOnce(new Response("wrong page"));
		await expect(publisher.verify(page, signal)).rejects.toThrow(
			"history_verification_content_mismatch",
		);
		await publisher.publish(page, signal);
		expect(registry.list()).toHaveLength(2);
		expect(
			registry.list().find((entry) => entry.token === page.token)?.createdAt,
		).toBe(page.createdAt);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("times out an unresponsive upload and cannot commit its late completion", async () => {
	vi.useFakeTimers({ now: Date.parse("2026-09-11T00:00:00.000Z") });
	const dir = mkdtempSync(join(tmpdir(), "history-timeout-"));
	try {
		const registry = new ReportRegistry(dir);
		await registry.ensureVercelProjectName();
		await registry.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: new Date().toISOString(),
				gatewayDeploymentId: "fixture",
			},
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
		let release!: () => void;
		const blob = {
			resumeReport: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			),
		};
		const fetchImpl = vi.fn<typeof fetch>();
		const publisher = new HistoryReportPublisher({
			registry,
			blob,
			fetchImpl,
			critical: createReportCriticalSection(),
		});
		const page = await publisher.stage(
			"<html><head></head><body>history</body></html>",
		);
		const pending = publisher.publish(page, new AbortController().signal);
		const rejected = expect(pending).rejects.toThrow("history_network_timeout");
		await vi.advanceTimersByTimeAsync(10001);
		await rejected;
		expect(registry.list()).toHaveLength(0);
		release();
		await Promise.resolve();
		await Promise.resolve();
		expect(registry.list()).toHaveLength(0);
		const controller = new AbortController();
		controller.abort();
		await expect(publisher.verify(page, controller.signal)).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("binds rotated credentials per upload and refuses changed hosting before upload", async () => {
	const dir = mkdtempSync(join(tmpdir(), "history-binding-"));
	try {
		const registry = new ReportRegistry(dir);
		await registry.ensureVercelProjectName();
		await registry.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: new Date().toISOString(),
				gatewayDeploymentId: "fixture",
				storeId: "storea",
			},
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
		let generation = 1;
		const snapshot = vi.fn(() => ({
			key: "BLOB_READ_WRITE_TOKEN" as const,
			value: "vercel_blob_rw_storea_test" + generation,
			source: "file" as const,
			generation,
		}));
		const resumeReport = vi.fn(async () => {});
		const bind = vi.fn(() => ({ resumeReport }));
		const publisher = new HistoryReportPublisher({
			registry,
			critical: createReportCriticalSection(),
			blob: { resumeReport: vi.fn(), bind } as never,
			credentials: { snapshot },
		});
		const page = await publisher.stage(
			"<html><head></head><body>history</body></html>",
		);
		generation = 2;
		await publisher.publish(page, new AbortController().signal);
		expect(bind).toHaveBeenCalledWith(
			expect.objectContaining({ generation: 2 }),
		);
		expect(registry.list()).toHaveLength(1);
		expect(registry.list()[0]?.mutable).toBeUndefined();
		await registry.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: new Date().toISOString(),
				gatewayDeploymentId: "changed",
				storeId: "storeb",
			},
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
		await expect(
			publisher.publish(page, new AbortController().signal),
		).rejects.toThrow("history_report_host_changed");
		expect(resumeReport).toHaveBeenCalledTimes(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("does not commit after cancellation while waiting for the asynchronous registry lock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "history-commit-cancel-"));
	try {
		const registry = new ReportRegistry(dir);
		await registry.ensureVercelProjectName();
		await registry.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: new Date().toISOString(),
				gatewayDeploymentId: "fixture",
			},
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
		const publisher = new HistoryReportPublisher({
			registry,
			critical: createReportCriticalSection(),
			blob: { resumeReport: async () => {} },
		});
		const page = await publisher.stage(
			"<html><head></head><body>history</body></html>",
		);
		let entered!: () => void, release!: () => void, finished!: () => void;
		const locked = new Promise<void>((r) => {
			entered = r;
		});
		const held = new Promise<void>((r) => {
			release = r;
		});
		const settled = new Promise<void>((r) => {
			finished = r;
		});
		const original = registry.withLock.bind(registry);
		vi.spyOn(registry, "withLock").mockImplementationOnce(async (action) => {
			entered();
			await held;
			try {
				return await original(action);
			} finally {
				finished();
			}
		});
		const controller = new AbortController();
		const pending = publisher.publish(page, controller.signal);
		const rejected = expect(pending).rejects.toThrow("canceled");
		await locked;
		controller.abort(new Error("canceled"));
		await rejected;
		release();
		await settled;
		expect(registry.list()).toHaveLength(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

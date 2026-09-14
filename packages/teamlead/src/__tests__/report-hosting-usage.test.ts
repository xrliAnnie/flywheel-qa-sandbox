import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runReportHostingUsageTick } from "../bridge/report-hosting-usage.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture(size = 800_000_000) {
	const dir = mkdtempSync(join(tmpdir(), "report-usage-"));
	dirs.push(dir);
	const binding = {
		storeId: "abc",
		vercelProjectName: "fw-reports-abc123",
		hostingKey: "fw-reports-abc123/abc",
	};
	const snapshot = vi.fn(() => ({
		key: "REPORT_HOSTING_VERCEL_TOKEN" as const,
		value: "arbitrary-account-secret",
		source: "file" as const,
		generation: 1,
	}));
	const getStore = vi.fn(async () => ({
		id: "abc",
		name: "reports",
		access: "private",
		size,
		count: 519,
		status: "available",
		usageQuotaExceeded: false,
		projectsMetadata: [],
	}));
	const post = vi.fn(async () => ({ messageId: "discord_1" }));
	const options = {
		credentials: { snapshot },
		registry: {
			withLock: async <T>(fn: () => Promise<T>) => fn(),
			hostingBinding: () => binding,
		},
		channel: () => "notification",
		getStore,
		post,
		receiptsPath: join(dir, "notify-receipts.json"),
		now: () => Date.parse("2026-09-13T12:00:00Z"),
		timezone: () => "UTC",
		warn: vi.fn(),
	};
	return { options, binding, snapshot, getStore, post };
}
it("alerts at exactly 80 percent and records one same-day delivery", async () => {
	const { options, getStore, post, snapshot } = fixture();
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		status: "sent",
	});
	expect(post).toHaveBeenCalledOnce();
	expect(post.mock.calls[0]![1]).toContain("--retarget");
	expect(post.mock.calls[0]![1]).toContain("519");
	expect(post.mock.calls[0]![1]).not.toContain("arbitrary-account-secret");
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		status: "skipped",
	});
	expect(getStore).toHaveBeenCalledOnce();
	expect(
		snapshot.mock.calls.every(
			(call) => call[0] === "REPORT_HOSTING_VERCEL_TOKEN",
		),
	).toBe(true);
	expect(
		JSON.parse(readFileSync(options.receiptsPath, "utf8")).report_hosting_usage,
	).toMatchObject({ phase: "sent", attempts: 1, messageId: "discord_1" });
});
it("records checked below 80 percent but alerts on a quota suspension at low usage", async () => {
	const first = fixture(799_000_000);
	expect(await runReportHostingUsageTick(first.options)).toMatchObject({
		status: "checked",
	});
	expect(first.post).not.toHaveBeenCalled();
	const second = fixture(10_000_000);
	second.getStore.mockResolvedValueOnce({
		id: "abc",
		name: "reports",
		access: "private",
		size: 10_000_000,
		count: 1,
		status: "limits-exceeded-suspended",
		usageQuotaExceeded: true,
		projectsMetadata: [],
	});
	expect(await runReportHostingUsageTick(second.options)).toMatchObject({
		status: "sent",
	});
});

it("honors in-flight and failure backoffs and the daily attempt cap", async () => {
	const { writeReportHostingUsageReceipt } = await import(
		"../bridge/notify-receipts.js"
	);
	for (const [phase, minutes, attempts, expected] of [
		["attempting", 10, 1, "skipped"],
		["attempting", 40, 1, "sent"],
		["failed", 30, 1, "skipped"],
		["failed", 70, 1, "sent"],
		["failed", 70, 6, "skipped"],
	] as const) {
		const { options, getStore } = fixture();
		writeReportHostingUsageReceipt(
			{
				date: "2026-09-13",
				storeId: "abc",
				phase,
				attemptedAt: new Date(options.now() - minutes * 60_000).toISOString(),
				attempts,
			},
			options.receiptsPath,
		);
		expect((await runReportHostingUsageTick(options)).status).toBe(expected);
		expect(getStore).toHaveBeenCalledTimes(expected === "sent" ? 1 : 0);
	}
});

it("starts again across a founder-local date or a store change", async () => {
	const { options, binding, getStore } = fixture();
	await runReportHostingUsageTick(options);
	await runReportHostingUsageTick({
		...options,
		now: () => options.now() + 24 * 60 * 60_000,
	});
	expect(getStore).toHaveBeenCalledTimes(2);
	binding.storeId = "def";
	await runReportHostingUsageTick({
		...options,
		now: () => options.now() + 24 * 60 * 60_000,
	});
	expect(getStore).toHaveBeenCalledTimes(3);
});

it("skips missing bindings and credentials and accepts a later hot-added credential", async () => {
	const { options, binding, getStore, snapshot } = fixture();
	binding.storeId = "";
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		reason: "no_store_id",
	});
	binding.storeId = "abc";
	snapshot.mockReturnValueOnce({
		key: "REPORT_HOSTING_VERCEL_TOKEN",
		value: undefined,
		source: "absent",
		generation: 1,
	});
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		reason: "no_account_credential",
	});
	expect(getStore).not.toHaveBeenCalled();
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		status: "sent",
	});
});

it("records a redacted failure and retries once the backoff passes", async () => {
	const { options, getStore } = fixture();
	getStore.mockRejectedValueOnce(
		new Error("failed for arbitrary-account-secret"),
	);
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		status: "failed",
	});
	expect(readFileSync(options.receiptsPath, "utf8")).not.toContain(
		"arbitrary-account-secret",
	);
	expect(await runReportHostingUsageTick(options)).toMatchObject({
		reason: "failure_backoff",
	});
	expect(
		await runReportHostingUsageTick({
			...options,
			now: () => options.now() + 70 * 60_000,
		}),
	).toMatchObject({ status: "sent" });
	expect(
		JSON.parse(readFileSync(options.receiptsPath, "utf8")).report_hosting_usage
			.attempts,
	).toBe(2);
});

it("provides a dry usage check and optional bound object size without notifications or receipts", async () => {
	const { checkReportHostingUsage } = await import(
		"../bridge/report-hosting-usage.js"
	);
	const { ReportRegistry } = await import("../bridge/report-registry.js");
	const { VercelBlobReportStore } = await import(
		"../bridge/report-blob-store.js"
	);
	const { options } = fixture();
	const reportsDir = join(options.receiptsPath, "..", "reports");
	const registry = new ReportRegistry(reportsDir);
	const project = await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			gatewayDeploymentId: "old",
			migratedAt: new Date().toISOString(),
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	const api = {
		getStore: vi.fn(async () => ({
			id: "abc",
			name: "reports",
			access: "private",
			size: 800_000_000,
			count: 10,
			status: "available",
			usageQuotaExceeded: false,
			projectsMetadata: [{ projectId: "prj_a" }],
		})),
		getProject: vi.fn(async () => ({ id: "prj_a", name: project })),
	};
	const input = {
		registry,
		reportsDir,
		vercelToken: "account",
		storeId: "abc",
		api,
	};
	expect(await checkReportHostingUsage(input)).toMatchObject({
		storeId8: "abc",
		wouldAlert: true,
		count: 10,
	});
	expect(registry.hosting()?.storeId).toBe("abc");
	const head = vi.fn(async () => ({ size: 123 }));
	const result = await checkReportHostingUsage({
		...input,
		token: "a".repeat(32),
		blobToken: "vercel_blob_rw_abc_secret",
		blobStore: new VercelBlobReportStore(undefined, {
			put: vi.fn(),
			del: vi.fn(),
			list: vi.fn(),
			head,
		}),
	});
	expect(result).toEqual({ token8: "a".repeat(8), sizeBytes: 123 });
	expect(head.mock.calls[0]![1]).toEqual({
		token: "vercel_blob_rw_abc_secret",
	});
});

it("installs its timer with no credential and uses a hot-added credential on the next hour", async () => {
	const { installReportHostingUsage, REPORT_HOSTING_USAGE_TICK_MS } =
		await import("../bridge/report-hosting-usage.js");
	vi.useFakeTimers();
	const { options, snapshot, post } = fixture();
	snapshot.mockReturnValueOnce({
		key: "REPORT_HOSTING_VERCEL_TOKEN",
		value: undefined,
		source: "absent",
		generation: 1,
	});
	const timer = installReportHostingUsage(options);
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(post).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(REPORT_HOSTING_USAGE_TICK_MS);
		expect(post).toHaveBeenCalledOnce();
	} finally {
		clearInterval(timer);
		vi.useRealTimers();
	}
});

it("preserves token-report receipts when writing usage state and vice versa", async () => {
	const { writeTokenReportReceipt } = await import(
		"../bridge/notify-receipts.js"
	);
	const { options } = fixture();
	writeTokenReportReceipt(
		{ date: "2026-09-12", messageId: "token-report" },
		{ path: options.receiptsPath },
	);
	await runReportHostingUsageTick(options);
	let receipts = JSON.parse(readFileSync(options.receiptsPath, "utf8"));
	expect(receipts.token_report.messageId).toBe("token-report");
	expect(receipts.report_hosting_usage.phase).toBe("sent");
	writeTokenReportReceipt(
		{ date: "2026-09-13", messageId: "next-token-report" },
		{ path: options.receiptsPath },
	);
	receipts = JSON.parse(readFileSync(options.receiptsPath, "utf8"));
	expect(receipts.token_report.messageId).toBe("next-token-report");
	expect(receipts.report_hosting_usage.phase).toBe("sent");
});

it("classifies missing store identity as an operator precondition before remote calls", async () => {
	const { checkReportHostingUsage } = await import(
		"../bridge/report-hosting-usage.js"
	);
	const { ReportRegistry } = await import("../bridge/report-registry.js");
	const { options } = fixture();
	const registry = new ReportRegistry(
		join(options.receiptsPath, "..", "empty"),
	);
	const api = { getStore: vi.fn(), getProject: vi.fn() };
	await expect(
		checkReportHostingUsage({
			registry,
			reportsDir: join(options.receiptsPath, "..", "empty"),
			vercelToken: "account",
			api,
		}),
	).rejects.toMatchObject({ exitCode: 2 });
	expect(api.getStore).not.toHaveBeenCalled();
});

it("uses the persisted case-sensitive API identity for the scheduled check", async () => {
	const { options, binding, getStore } = fixture();
	Object.assign(binding, { storeApiId: "store_AbC" });
	await runReportHostingUsageTick(options);
	expect(getStore.mock.calls[0]![1]).toBe("store_AbC");
});

it("backfills and reloads a mixed-case API id without changing the canonical binding", async () => {
	const { checkReportHostingUsage } = await import(
		"../bridge/report-hosting-usage.js"
	);
	const { ReportRegistry } = await import("../bridge/report-registry.js");
	const { options } = fixture();
	const reportsDir = join(options.receiptsPath, "..", "case-registry");
	const registry = new ReportRegistry(reportsDir);
	const project = await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			gatewayDeploymentId: "old",
			migratedAt: new Date().toISOString(),
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	const api = {
		getStore: vi.fn(async (id: string) => {
			expect(id).toBe("store_AbC");
			return {
				id: "abc",
				apiId: "store_AbC",
				name: "reports",
				access: "private",
				size: 0,
				count: 0,
				status: "available",
				usageQuotaExceeded: false,
				projectsMetadata: [{ projectId: "prj_a" }],
			};
		}),
		getProject: vi.fn(async () => ({ id: "prj_a", name: project })),
	};
	await checkReportHostingUsage({
		registry,
		reportsDir,
		vercelToken: "account",
		storeId: "store_AbC",
		api,
	});
	const reloaded = new ReportRegistry(reportsDir);
	expect(reloaded.hostingBinding()).toMatchObject({
		storeId: "abc",
		storeApiId: "store_AbC",
	});
	await checkReportHostingUsage({
		registry: reloaded,
		reportsDir,
		vercelToken: "account",
		api,
	});
});

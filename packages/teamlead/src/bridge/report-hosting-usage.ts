import { statSync } from "node:fs";
import { join } from "node:path";
import { resolveFounderTimezone } from "flywheel-config";
import {
	type ReportHostingUsageReceipt,
	readReportHostingUsageReceipt,
	writeReportHostingUsageReceipt,
} from "./notify-receipts.js";
import {
	type ReportBlobStore,
	VercelBlobReportStore,
} from "./report-blob-store.js";
import type { ReportHostingCredentials } from "./report-hosting-credentials.js";
import { assertReportHostingCredentialBinding } from "./report-hosting-credentials.js";
import { ReportRetargetError } from "./report-hosting-retarget.js";
import type { ReportRegistry } from "./report-registry.js";
import {
	normalizeStoreId,
	SecretRedactor,
	VercelHostingApi,
	type VercelStoreDetails,
} from "./vercel-hosting-api.js";

export const REPORT_HOSTING_HOBBY_STORAGE_BYTES = 1_000_000_000;
export const REPORT_HOSTING_USAGE_ALERT_RATIO = 0.8;
export const REPORT_HOSTING_USAGE_TICK_MS = 60 * 60 * 1000;
export function evaluateReportHostingUsage(
	store: Pick<
		VercelStoreDetails,
		"size" | "count" | "usageQuotaExceeded" | "status"
	>,
): { pct: number; alert: boolean; reasons: string[] } {
	if (
		!Number.isSafeInteger(store.size) ||
		store.size < 0 ||
		!Number.isSafeInteger(store.count) ||
		store.count < 0
	)
		throw new Error("invalid report hosting usage");
	const reasons: string[] = [];
	if (
		store.size >=
		REPORT_HOSTING_HOBBY_STORAGE_BYTES * REPORT_HOSTING_USAGE_ALERT_RATIO
	)
		reasons.push("storage");
	if (store.usageQuotaExceeded) reasons.push("quota");
	if (store.status.startsWith("limits-exceeded")) reasons.push("suspended");
	return {
		pct: (store.size / REPORT_HOSTING_HOBBY_STORAGE_BYTES) * 100,
		alert: reasons.length > 0,
		reasons,
	};
}
export interface ReportHostingUsageDependencies {
	credentials: ReportHostingCredentials;
	registry: Pick<ReportRegistry, "withLock" | "hostingBinding">;
	channel: () => string | undefined;
	post: (channel: string, text: string) => Promise<{ messageId?: string }>;
	getStore?: (
		token: string,
		storeId: string,
		redactor: SecretRedactor,
	) => Promise<VercelStoreDetails>;
	receiptsPath?: string;
	now?: () => number;
	timezone?: () => string;
	warn?: (message: string) => void;
}
export type UsageTickResult =
	| { status: "skipped"; reason: string }
	| { status: "checked" | "sent" | "failed" };
const warned = new Set<string>();
export async function runReportHostingUsageTick(
	deps: ReportHostingUsageDependencies,
): Promise<UsageTickResult> {
	const snapshot = deps.credentials.snapshot("REPORT_HOSTING_VERCEL_TOKEN");
	const binding = await deps.registry.withLock(async () =>
		deps.registry.hostingBinding(),
	);
	const channel = deps.channel()?.trim();
	const skip = (reason: string, warning = false): UsageTickResult => {
		if (warning && !warned.has(reason)) {
			warned.add(reason);
			(deps.warn ?? console.warn)(`[reports] usage check skipped: ${reason}`);
		}
		return { status: "skipped", reason };
	};
	if (!binding.storeId) return skip("no_store_id", true);
	if (!snapshot.value) return skip("no_account_credential", true);
	if (!channel) return skip("no_notification_channel", true);
	const now = deps.now?.() ?? Date.now();
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone: (deps.timezone ?? resolveFounderTimezone)(),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(now));
	const previous = readReportHostingUsageReceipt(deps.receiptsPath);
	const same = previous?.date === date && previous.storeId === binding.storeId;
	if (same) {
		if (previous.phase === "sent" || previous.phase === "checked")
			return skip("already_checked");
		if (previous.attempts >= 6) return skip("attempt_limit");
		const age = now - Date.parse(previous.attemptedAt);
		if (previous.phase === "attempting" && age < 30 * 60 * 1000)
			return skip("attempt_in_progress");
		if (previous.phase === "failed" && age < 60 * 60 * 1000)
			return skip("failure_backoff");
	}
	const redactor = new SecretRedactor();
	redactor.add(snapshot.value, "account");
	const receipt: ReportHostingUsageReceipt = {
		date,
		storeId: binding.storeId,
		phase: "attempting",
		attemptedAt: new Date(now).toISOString(),
		attempts: (same ? previous.attempts : 0) + 1,
	};
	writeReportHostingUsageReceipt(receipt, deps.receiptsPath);
	try {
		const details = await (
			deps.getStore ??
			((token, id, redactor) =>
				new VercelHostingApi({ token, redactor }).getStore(id))
		)(snapshot.value, binding.storeApiId ?? binding.storeId, redactor);
		const evaluation = evaluateReportHostingUsage(details);
		Object.assign(receipt, {
			pct: evaluation.pct,
			sizeBytes: details.size,
			count: details.count,
			status: details.status,
		});
		if (evaluation.alert) {
			const status =
				details.usageQuotaExceeded || details.status !== "available"
					? `\n⚠️ store status=${details.status} usageQuotaExceeded=${details.usageQuotaExceeded}`
					: "";
			const message =
				redactor.redact(`📦 报告托管 Blob 水位 ${evaluation.pct.toFixed(1)}%(${(details.size / 1_000_000).toFixed(1)} MB / 1000 MB,${details.count} 个对象) · store ${binding.storeId.slice(0, 8)} · 项目 ${binding.vercelProjectName ?? "-"}${status}
下一步:在 Flywheel checkout 用一个新 Vercel 账号的 token 跑
pnpm migrate:report-hosting --retarget --vercel-token-env REPORT_HOSTING_VERCEL_TOKEN_NEXT --project-name fw-reports-<新 6hex>
完成后按命令输出改 ~/.flywheel/.env 两行(BLOB_READ_WRITE_TOKEN / REPORT_HOSTING_VERCEL_TOKEN),不用重启 Bridge。`);
			const result = await deps.post(channel, message);
			receipt.phase = "sent";
			receipt.messageId = result.messageId;
		} else receipt.phase = "checked";
		writeReportHostingUsageReceipt(receipt, deps.receiptsPath);
		return { status: receipt.phase };
	} catch (error) {
		receipt.phase = "failed";
		receipt.error = redactor
			.redact(error instanceof Error ? error.message : "usage check failed")
			.slice(0, 500);
		writeReportHostingUsageReceipt(receipt, deps.receiptsPath);
		(deps.warn ?? console.warn)(
			`[reports] usage check failed: ${receipt.error}`,
		);
		return { status: "failed" };
	}
}
export function installReportHostingUsage(
	deps: ReportHostingUsageDependencies,
): ReturnType<typeof setInterval> {
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			await runReportHostingUsageTick(deps);
		} catch {
			(deps.warn ?? console.warn)(
				"[reports] usage tick could not record or read state",
			);
		} finally {
			running = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), REPORT_HOSTING_USAGE_TICK_MS);
	timer.unref?.();
	return timer;
}

/** Operator inspection: no notification or notification receipt mutation. */
export async function checkReportHostingUsage(options: {
	registry: ReportRegistry;
	reportsDir: string;
	vercelToken: string;
	storeId?: string;
	token?: string;
	blobToken?: string;
	blobStore?: Pick<ReportBlobStore, "bind">;
	api?: Pick<VercelHostingApi, "getStore" | "getProject">;
	now?: () => number;
}): Promise<Record<string, string | number | boolean>> {
	const binding = await options.registry.withLock(async () =>
		options.registry.hostingBinding(),
	);
	const storeId = options.storeId
		? normalizeStoreId(options.storeId)
		: binding.storeId;
	if (!storeId)
		throw new ReportRetargetError(
			2,
			"report store identity missing; supply --store-id",
		);
	if (binding.storeId && binding.storeId !== storeId)
		throw new ReportRetargetError(2, "store identity does not match registry");
	const redactor = new SecretRedactor();
	redactor.add(options.vercelToken, "account");
	redactor.add(options.blobToken, "blob");
	const api =
		options.api ??
		new VercelHostingApi({ token: options.vercelToken, redactor });
	const store = await api.getStore(
		options.storeId ?? binding.storeApiId ?? storeId,
	);
	if (!binding.storeId || (!binding.storeApiId && options.storeId)) {
		if (!binding.vercelProjectName)
			throw new ReportRetargetError(2, "report gateway project missing");
		const project = await api.getProject(binding.vercelProjectName);
		if (
			!project ||
			!store.projectsMetadata.some((item) => item.projectId === project.id)
		)
			throw new Error("store is not connected to the registry gateway");
		await options.registry.recordHostingStoreId({
			expectedProjectName: binding.vercelProjectName,
			storeId,
			storeApiId: store.apiId ?? options.storeId,
			blobHost: `${storeId}.private.blob.vercel-storage.com`,
		});
	}
	if (options.token) {
		if (!/^[a-f0-9]{32}$/.test(options.token))
			throw new ReportRetargetError(2, "invalid report token");
		const snapshot = {
			key: "BLOB_READ_WRITE_TOKEN" as const,
			value: options.blobToken,
			source: "process" as const,
			generation: 0,
		};
		assertReportHostingCredentialBinding(storeId, snapshot);
		const bound = (options.blobStore ?? new VercelBlobReportStore()).bind(
			snapshot,
		);
		return {
			token8: options.token.slice(0, 8),
			sizeBytes: await bound.headReportSize(options.token),
		};
	}
	const evaluation = evaluateReportHostingUsage(store);
	const result: Record<string, string | number | boolean> = {
		storeId8: storeId.slice(0, 8),
		sizeBytes: store.size,
		count: store.count,
		pct: evaluation.pct,
		status: store.status,
		usageQuotaExceeded: store.usageQuotaExceeded,
		wouldAlert: evaluation.alert,
	};
	if (
		binding.vercelProjectName &&
		/^fw-reports-[0-9a-f]{6}$/.test(binding.vercelProjectName)
	) {
		try {
			const file = statSync(
				join(
					options.reportsDir,
					`retarget.${binding.vercelProjectName}.secrets.env`,
				),
			);
			result.secretsFileAgeHours = Math.max(
				0,
				((options.now?.() ?? Date.now()) - file.mtimeMs) / 3_600_000,
			);
		} catch {
			/* No handoff file is a normal steady state. */
		}
	}
	return result;
}

import type { ReportBlobStore } from "../bridge/report-blob-store.js";
import type { ReportCriticalSection } from "../bridge/report-critical-section.js";
import {
	assertReportHostingCredentialBinding,
	type ReportHostingCredentials,
} from "../bridge/report-hosting-credentials.js";
import type { ReportRegistry } from "../bridge/report-registry.js";
import { reportUrlForToken } from "../bridge/report-url.js";
import type { HistoryStagedPage } from "./history-state.js";

interface Dependencies {
	registry: ReportRegistry;
	blob: Pick<ReportBlobStore, "resumeReport"> &
		Partial<Pick<ReportBlobStore, "bind">>;
	credentials?: ReportHostingCredentials;
	critical: ReportCriticalSection;
	fetchImpl?: typeof fetch;
}
async function bounded<T>(
	parent: AbortSignal,
	action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	parent.throwIfAborted();
	const controller = new AbortController();
	const stop = () => controller.abort(parent.reason);
	parent.addEventListener("abort", stop, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("history_network_timeout")),
		10000,
	);
	let rejectAbort!: (reason: unknown) => void;
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => rejectAbort(controller.signal.reason);
	controller.signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([action(controller.signal), aborted]);
	} finally {
		clearTimeout(timer);
		parent.removeEventListener("abort", stop);
		controller.signal.removeEventListener("abort", onAbort);
	}
}
/** Ordinary reports only. Shared report critical sections contain no upload or public verification. */
export class HistoryReportPublisher {
	constructor(private readonly deps: Dependencies) {}
	origin() {
		const url = reportUrlForToken(this.deps.registry, "0".repeat(32));
		if (!url) throw new Error("history_report_host_unavailable");
		return new URL(url).origin;
	}
	stage(
		html: string,
		parent: AbortSignal = new AbortController().signal,
	): Promise<HistoryStagedPage> {
		return bounded(parent, (signal) =>
			this.deps.critical.run(async () => {
				signal.throwIfAborted();
				const binding = this.deps.registry.hostingBinding();
				const staged = this.deps.registry.stagePublish(
					"flywheel",
					html,
					undefined,
					binding,
				);
				try {
					const url = reportUrlForToken(this.deps.registry, staged.entry.token);
					if (!url) throw new Error("history_report_host_unavailable");
					if (staged.entry.bytes > 65536)
						throw new Error("history_page_budget_exceeded");
					return {
						hostingKey: binding.hostingKey,
						token: staged.entry.token,
						url,
						html: staged.html,
						createdAt: staged.entry.createdAt,
					};
				} finally {
					staged.abort();
				}
			}),
		);
	}
	async publish(page: HistoryStagedPage, parent: AbortSignal) {
		const binding = this.deps.registry.hostingBinding();
		if (
			page.hostingKey !== binding.hostingKey ||
			reportUrlForToken(this.deps.registry, page.token) !== page.url
		)
			throw new Error("history_report_host_changed");
		let blob = this.deps.blob;
		if (this.deps.credentials) {
			const snapshot = this.deps.credentials.snapshot("BLOB_READ_WRITE_TOKEN");
			if (!snapshot.value || !blob.bind)
				throw new Error("history_report_credentials_unavailable");
			assertReportHostingCredentialBinding(binding.storeId, snapshot);
			blob = blob.bind(snapshot);
		}
		if (!blob.resumeReport)
			throw new Error("history_report_resume_unavailable");
		await bounded(parent, (signal) =>
			blob.resumeReport!(page.token, page.html, signal, {
				gzip: binding.gatewayFormat === "gzip-v1",
			}),
		);
		parent.throwIfAborted();
		await bounded(parent, (signal) =>
			this.deps.critical.run(async () => {
				signal.throwIfAborted();
				const resumed = this.deps.registry.resumePublish(
					{
						token: page.token,
						projectName: "flywheel",
						createdAt: page.createdAt,
						bytes: Buffer.byteLength(page.html),
					},
					page.html,
					binding,
					signal,
				);
				await resumed.commit();
			}),
		);
	}
	async verify(page: HistoryStagedPage, parent: AbortSignal) {
		const binding = this.deps.registry.hostingBinding();
		if (
			page.hostingKey !== binding.hostingKey ||
			reportUrlForToken(this.deps.registry, page.token) !== page.url
		)
			throw new Error("history_report_host_changed");
		await bounded(parent, async (signal) => {
			const response = await (this.deps.fetchImpl ?? fetch)(page.url, {
				method: "GET",
				redirect: "error",
				headers: { "Cache-Control": "no-cache" },
				signal,
			});
			if (response.status !== 200 || !response.body) {
				await response.body?.cancel();
				throw new Error("history_verification_http_failed");
			}
			const reader = response.body.getReader(),
				expected = Buffer.from(page.html),
				chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					signal.throwIfAborted();
					const chunk = await reader.read();
					signal.throwIfAborted();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > 65536 || size > expected.length)
						throw new Error("history_verification_content_mismatch");
					chunks.push(chunk.value);
				}
				if (!Buffer.concat(chunks).equals(expected))
					throw new Error("history_verification_content_mismatch");
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		});
	}
}

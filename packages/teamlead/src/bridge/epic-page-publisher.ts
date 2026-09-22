import { createHash } from "node:crypto";
import { type EpicPage, hostedContentDigest } from "../epic-page/model.js";
import { renderEpicPageBudgetBundle } from "../epic-page/optional-budget.js";
import type { EpicPageBundle } from "../epic-page/render-html.js";
import type { StateStore } from "../StateStore.js";
import {
	EpicAuditGatewayError,
	type ReportBlobStore,
} from "./report-blob-store.js";
import type { ReportCriticalSection } from "./report-critical-section.js";
import type { ReportHostOverride } from "./report-host-override.js";
import {
	assertReportHostingCredentialBinding,
	ReportHostingCredentialMismatch,
	type ReportHostingCredentials,
} from "./report-hosting-credentials.js";
import {
	ReportHostingBindingConflict,
	type ReportRegistry,
} from "./report-registry.js";

export const EPIC_PAGE_MAX_HTML_BYTES = 512 * 1024;

export type EpicPagePublishOutcome =
	| `ok:${number}`
	| `ok_unpublished:${number}:skipped_hosting_not_configured`
	| `ok_unpublished:${number}:skipped_hosting_unsupported`
	| `ok_unpublished:${number}:unchanged_digest`
	| "structural: epic_html_too_large"
	| "transient: publish_failed:stage"
	| "transient: publish_failed:blob"
	| "transient: publish_failed:audit_gateway"
	| "transient: publish_failed:registry"
	| "transient: publish_failed:credentials"
	| "transient: publish_failed:publication";

export interface EpicPagePublisher {
	publishHosted(
		page: EpicPage,
		options?: { force?: boolean },
	): Promise<EpicPagePublishOutcome>;
}

export interface EpicPagePublisherDeps {
	store: Pick<
		StateStore,
		| "reserveEpicPageToken"
		| "commitEpicPagePublication"
		| "getEpicPagePublication"
	>;
	registry: Pick<
		ReportRegistry,
		"hosting" | "hostingBinding" | "stageEpicPageRepublish"
	>;
	blobStore?: Pick<ReportBlobStore, "putEpicPage"> &
		Partial<Pick<ReportBlobStore, "bind">>;
	credentials?: ReportHostingCredentials;
	criticalSection: ReportCriticalSection;
	hostOverride?: ReportHostOverride;
	now?: () => Date;
	renderHtml?: (page: EpicPage) => string;
	probeAudit?: (url: string, sha256: string) => Promise<boolean>;
}

export function createEpicPagePublisher(
	deps: EpicPagePublisherDeps,
): EpicPagePublisher {
	const now = deps.now ?? (() => new Date());
	const renderBundle = (page: EpicPage): EpicPageBundle =>
		renderEpicPageBudgetBundle(page, now());
	return {
		async publishHosted(page, options = {}): Promise<EpicPagePublishOutcome> {
			const version = page.freshness.current.value?.version;
			if (!version) throw new Error("epic_page_current_version_missing");
			if (deps.hostOverride) {
				return `ok_unpublished:${version}:skipped_hosting_unsupported`;
			}
			const blobStore = deps.blobStore;
			if (!blobStore || deps.registry.hosting()?.provider !== "vercel-blob") {
				return `ok_unpublished:${version}:skipped_hosting_not_configured`;
			}

			const projectName = page.key.project_name;
			const { token } = deps.store.reserveEpicPageToken(projectName);
			let html: string;
			let audit: EpicPageBundle["audit"] | undefined;
			try {
				if (deps.renderHtml) html = deps.renderHtml(page);
				else {
					const bundle = renderBundle(page);
					html = bundle.html;
					audit = bundle.audit;
				}
			} catch {
				return "transient: publish_failed:stage";
			}
			if (Buffer.byteLength(html, "utf8") > EPIC_PAGE_MAX_HTML_BYTES) {
				return "structural: epic_html_too_large";
			}

			const digest = hostedContentDigest(page);
			return deps.criticalSection.run<EpicPagePublishOutcome>(async () => {
				let staged: ReturnType<ReportRegistry["stageEpicPageRepublish"]>;
				let afterCommit: (() => Promise<void>) | undefined;
				let operationStore = blobStore;
				try {
					const binding = deps.registry.hostingBinding();
					const publication = deps.store.getEpicPagePublication(projectName);
					const age =
						now().getTime() - Date.parse(publication?.last_published_at ?? "");
					if (
						!options.force &&
						publication?.published &&
						publication.last_content_digest === digest &&
						publication.last_hosting_key === binding.hostingKey &&
						age >= 0 &&
						age < 24 * 60 * 60 * 1000
					)
						return `ok_unpublished:${version}:unchanged_digest`;
					if (deps.credentials) {
						const snapshot = deps.credentials.snapshot("BLOB_READ_WRITE_TOKEN");
						if (!snapshot.value || !blobStore.bind)
							return "transient: publish_failed:credentials";
						assertReportHostingCredentialBinding(binding.storeId, snapshot);
						operationStore = blobStore.bind(snapshot);
					}
					staged = deps.registry.stageEpicPageRepublish(
						projectName,
						html,
						token,
						`${projectName} Epic`,
						binding,
					);
				} catch (error) {
					return error instanceof ReportHostingBindingConflict ||
						error instanceof ReportHostingCredentialMismatch
						? "transient: publish_failed:credentials"
						: "transient: publish_failed:stage";
				}
				// Include CSP hardening and the optional previous-hash attribute
				// written by Blob storage; the final hosted object must fit too.
				const bindingBytes = audit
					? Buffer.byteLength(` data-previous-audit="${"0".repeat(64)}"`)
					: 0;
				if (
					Buffer.byteLength(staged.html, "utf8") + bindingBytes >
					EPIC_PAGE_MAX_HTML_BYTES
				) {
					staged.abort();
					return "structural: epic_html_too_large";
				}
				try {
					const uploaded = await operationStore.putEpicPage(
						token,
						staged.html,
						audit
							? {
									...audit,
									verifyGateway: () =>
										(deps.probeAudit ?? probeEpicAuditGateway)(
											`https://${staged.vercelProjectName}.vercel.app/r/${token}/${audit.path}`,
											audit.sha256,
										),
								}
							: undefined,
						{ gzip: staged.binding.gatewayFormat === "gzip-v1" },
					);
					afterCommit = uploaded?.afterCommit;
				} catch (error) {
					try {
						staged.abort();
					} catch {
						// Preserve the Blob phase outcome if an injected abort seam misbehaves.
					}
					return error instanceof EpicAuditGatewayError
						? "transient: publish_failed:audit_gateway"
						: "transient: publish_failed:blob";
				}
				try {
					await staged.commit();
				} catch (error) {
					return error instanceof ReportHostingBindingConflict ||
						error instanceof ReportHostingCredentialMismatch
						? "transient: publish_failed:credentials"
						: "transient: publish_failed:registry";
				}
				await afterCommit?.();
				try {
					deps.store.commitEpicPagePublication({
						projectName,
						token,
						publishedAt: now().toISOString(),
						version,
						contentDigest: digest,
						hostingKey: staged.binding.hostingKey,
					});
				} catch {
					return "transient: publish_failed:publication";
				}
				return `ok:${version}`;
			});
		},
	};
}

export async function probeEpicAuditGateway(
	url: string,
	sha256: string,
	request: typeof fetch = fetch,
): Promise<boolean> {
	try {
		const response = await request(url, {
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
		if (
			response.status !== 200 ||
			!response.headers.get("content-type")?.startsWith("application/json")
		)
			return false;
		return (
			createHash("sha256")
				.update(await response.text())
				.digest("hex") === sha256
		);
	} catch {
		return false;
	}
}

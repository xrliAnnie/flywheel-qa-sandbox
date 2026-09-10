import { createHash } from "node:crypto";
import type { EpicPage } from "../epic-page/model.js";
import {
	type EpicPageBundle,
	renderEpicPageBundle,
} from "../epic-page/render-html.js";
import type { StateStore } from "../StateStore.js";
import {
	EpicAuditGatewayError,
	type ReportBlobStore,
} from "./report-blob-store.js";
import type { ReportCriticalSection } from "./report-critical-section.js";
import type { ReportHostOverride } from "./report-host-override.js";
import type { ReportRegistry } from "./report-registry.js";

export const EPIC_PAGE_MAX_HTML_BYTES = 512 * 1024;

export type EpicPagePublishOutcome =
	| `ok:${number}`
	| `ok_unpublished:${number}:skipped_hosting_not_configured`
	| `ok_unpublished:${number}:skipped_hosting_unsupported`
	| "structural: epic_html_too_large"
	| "transient: publish_failed:stage"
	| "transient: publish_failed:blob"
	| "transient: publish_failed:audit_gateway"
	| "transient: publish_failed:registry"
	| "transient: publish_failed:publication";

export interface EpicPagePublisher {
	publishHosted(page: EpicPage): Promise<EpicPagePublishOutcome>;
}

export interface EpicPagePublisherDeps {
	store: Pick<StateStore, "reserveEpicPageToken" | "commitEpicPagePublication">;
	registry: Pick<ReportRegistry, "hosting" | "stageEpicPageRepublish">;
	blobStore?: Pick<ReportBlobStore, "putEpicPage">;
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
		renderEpicPageBundle(page, now());
	return {
		async publishHosted(page): Promise<EpicPagePublishOutcome> {
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

			return deps.criticalSection.run<EpicPagePublishOutcome>(async () => {
				let staged: ReturnType<ReportRegistry["stageEpicPageRepublish"]>;
				try {
					staged = deps.registry.stageEpicPageRepublish(
						projectName,
						html,
						token,
						`${projectName} Epic`,
					);
				} catch {
					return "transient: publish_failed:stage";
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
					await blobStore.putEpicPage(
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
					);
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
					staged.commit();
				} catch {
					return "transient: publish_failed:registry";
				}
				try {
					deps.store.commitEpicPagePublication({
						projectName,
						token,
						publishedAt: now().toISOString(),
						version,
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

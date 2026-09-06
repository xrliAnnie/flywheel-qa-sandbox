import type { EpicPage } from "../epic-page/model.js";
import { renderEpicPageHtml } from "../epic-page/render-html.js";
import type { StateStore } from "../StateStore.js";
import type { ReportBlobStore } from "./report-blob-store.js";
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
}

export function createEpicPagePublisher(
	deps: EpicPagePublisherDeps,
): EpicPagePublisher {
	const now = deps.now ?? (() => new Date());
	const renderHtml = deps.renderHtml ?? renderEpicPageHtml;
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
			try {
				html = renderHtml(page);
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
				try {
					await blobStore.putEpicPage(token, staged.html);
				} catch {
					try {
						staged.abort();
					} catch {
						// Preserve the Blob phase outcome if an injected abort seam misbehaves.
					}
					return "transient: publish_failed:blob";
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

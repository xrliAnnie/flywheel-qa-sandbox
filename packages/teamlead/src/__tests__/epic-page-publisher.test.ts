import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEpicPagePublisher } from "../bridge/epic-page-publisher.js";
import { VercelBlobReportStore } from "../bridge/report-blob-store.js";
import { createReportCriticalSection } from "../bridge/report-critical-section.js";
import { ReportRegistry } from "../bridge/report-registry.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "../epic-page/__tests__/fixtures/epic-shape.js";
import { generateEpicPage } from "../epic-page/generate.js";
import type { EpicPage } from "../epic-page/model.js";
import { StateStore } from "../StateStore.js";

function epicPage(): EpicPage {
	const snapshot = epicShapeSnapshot();
	return generateEpicPage({
		snapshot,
		itemFacts: snapshot.items.map(() => emptyItemFacts()),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "event",
		version: 1,
		reasons: ["session_completed"],
	});
}

describe("hosted Epic page publisher", () => {
	let dir: string;
	let store: StateStore;
	let registry: ReportRegistry;
	let blobs: Map<string, string>;
	let putEpicPage: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2143-publisher-"));
		store = await StateStore.create(":memory:");
		registry = new ReportRegistry(dir);
		registry.ensureVercelProjectName();
		registry.markHostingMigrated({
			provider: "vercel-blob",
			migratedAt: "2026-09-03T03:00:00.000Z",
			gatewayDeploymentId: "dpl_gateway",
		});
		blobs = new Map();
		putEpicPage = vi.fn(async (token: string, html: string) => {
			blobs.set(token, html);
			return {
				pathname: `r/${token}/index.html`,
				url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
			};
		});
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function publisher(overrides: Record<string, unknown> = {}) {
		return createEpicPagePublisher({
			store,
			registry,
			blobStore: { putEpicPage },
			criticalSection: createReportCriticalSection(),
			now: () => EPIC_SHAPE_NOW,
			...overrides,
		});
	}

	it("reserves, uploads, commits, and publishes one first-ever stable page", async () => {
		const outcome = await publisher().publishHosted(epicPage());
		const publication = store.getEpicPagePublication("example");

		expect(outcome).toBe("ok:1");
		expect(publication).toMatchObject({ published: true, last_version: 1 });
		expect(registry.list()).toHaveLength(1);
		expect(registry.list()[0]?.token).toBe(publication?.token);
		expect(putEpicPage).toHaveBeenCalledOnce();
		expect(putEpicPage.mock.calls[0]?.[0]).toBe(publication?.token);
		expect(blobs.get(publication?.token ?? "")).toContain(
			"Content-Security-Policy",
		);
	});

	it("passes a hash-bound sidecar to the hosted upload", async () => {
		expect(await publisher().publishHosted(epicPage())).toBe("ok:1");
		const [, html, audit] = putEpicPage.mock.calls[0]!;
		expect(audit).toMatchObject({
			sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			json: expect.any(String),
		});
		expect(html).toContain(`${audit.sha256}/index.audit.json`);
		expect(html).not.toContain("epic-audit-data");
	});

	it("rejects a page whose hardened publication exceeds 512 KiB", async () => {
		const prefix = "<html><head></head><body>";
		const suffix = "</body></html>";
		const html =
			prefix + "x".repeat(512 * 1024 - prefix.length - suffix.length) + suffix;
		expect(
			await publisher({ renderHtml: () => html }).publishHosted(epicPage()),
		).toBe("structural: epic_html_too_large");
		expect(putEpicPage).not.toHaveBeenCalled();
		expect(registry.list()).toEqual([]);
	});

	it("reports unsupported hosting without reserving or publishing", async () => {
		const noBlob = publisher({ blobStore: undefined });
		expect(await noBlob.publishHosted(epicPage())).toBe(
			"ok_unpublished:1:skipped_hosting_not_configured",
		);

		const unmarkedDir = mkdtempSync(join(tmpdir(), "fly2143-unmarked-"));
		const unmarkedRegistry = new ReportRegistry(unmarkedDir);
		try {
			expect(
				await publisher({ registry: unmarkedRegistry }).publishHosted(
					epicPage(),
				),
			).toBe("ok_unpublished:1:skipped_hosting_not_configured");
		} finally {
			rmSync(unmarkedDir, { recursive: true, force: true });
		}

		expect(
			await publisher({
				hostOverride: {
					apiBaseUrl: "http://127.0.0.1:3000",
					publicBaseUrl: "http://127.0.0.1:3000",
				},
			}).publishHosted(epicPage()),
		).toBe("ok_unpublished:1:skipped_hosting_unsupported");
		expect(store.getEpicPagePublication("example")).toBeUndefined();
		expect(putEpicPage).not.toHaveBeenCalled();
	});

	it("P0 keeps only a reserved publication when rendered HTML is too large", async () => {
		const outcome = await publisher({
			renderHtml: () => "x".repeat(512 * 1024 + 1),
		}).publishHosted(epicPage());

		expect(outcome).toBe("structural: epic_html_too_large");
		expect(store.getEpicPagePublication("example")).toMatchObject({
			published: false,
		});
		expect(registry.list()).toEqual([]);
		expect(putEpicPage).not.toHaveBeenCalled();
	});

	it("P1 maps stage failure without attempting upload or abort", async () => {
		vi.spyOn(registry, "stageEpicPageRepublish").mockImplementation(() => {
			throw new Error("stage failed");
		});

		expect(await publisher().publishHosted(epicPage())).toBe(
			"transient: publish_failed:stage",
		);
		expect(store.getEpicPagePublication("example")).toMatchObject({
			published: false,
		});
		expect(registry.list()).toEqual([]);
		expect(putEpicPage).not.toHaveBeenCalled();
	});

	it("P2 aborts staging after upload failure and retries at the same token", async () => {
		const originalStage = registry.stageEpicPageRepublish.bind(registry);
		const abort = vi.fn();
		vi.spyOn(registry, "stageEpicPageRepublish").mockImplementation(
			(projectName, html, token, title) => {
				const staged = originalStage(projectName, html, token, title);
				abort.mockImplementation(staged.abort);
				return { ...staged, abort };
			},
		);
		putEpicPage
			.mockRejectedValueOnce(new Error("blob down"))
			.mockImplementationOnce(async (token: string, html: string) => {
				blobs.set(token, html);
				return {
					pathname: `r/${token}/index.html`,
					url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
				};
			});
		const subject = publisher();

		expect(await subject.publishHosted(epicPage())).toBe(
			"transient: publish_failed:blob",
		);
		expect(abort).toHaveBeenCalledOnce();
		expect(registry.list()).toEqual([]);
		expect(store.getEpicPagePublication("example")?.published).toBe(false);
		expect(await subject.publishHosted(epicPage())).toBe("ok:1");
		expect(putEpicPage.mock.calls[0]?.[0]).toBe(putEpicPage.mock.calls[1]?.[0]);
		expect(registry.list()).toHaveLength(1);
	});

	it("P2 treats a post-upload response validation error as unknown Blob state", async () => {
		let uploadedToken = "";
		const validatingBlobStore = new VercelBlobReportStore("blob-secret", {
			get: vi.fn().mockResolvedValue(null),
			put: vi.fn(async (pathname: string, html: string) => {
				uploadedToken = pathname.split("/")[1] ?? "";
				blobs.set(uploadedToken, html);
				return { pathname, url: "https://wrong.example/object" };
			}),
			list: vi.fn(),
			del: vi.fn(),
		});

		expect(
			await publisher({ blobStore: validatingBlobStore }).publishHosted(
				epicPage(),
			),
		).toBe("transient: publish_failed:blob");
		expect(blobs.has(uploadedToken)).toBe(true);
		expect(registry.list()).toEqual([]);
		expect(store.getEpicPagePublication("example")?.published).toBe(false);
	});

	it("P3 preserves the registry failure and never calls abort after commit starts", async () => {
		const originalStage = registry.stageEpicPageRepublish.bind(registry);
		const abort = vi.fn();
		vi.spyOn(registry, "stageEpicPageRepublish").mockImplementation(
			(projectName, html, token, title) => {
				const staged = originalStage(projectName, html, token, title);
				abort.mockImplementation(staged.abort);
				return { ...staged, abort };
			},
		);
		mkdirSync(join(dir, "registry.json.tmp"));

		const subject = publisher();
		expect(await subject.publishHosted(epicPage())).toBe(
			"transient: publish_failed:registry",
		);
		expect(abort).not.toHaveBeenCalled();
		expect(blobs.size).toBe(1);
		expect(registry.list()).toEqual([]);
		expect(store.getEpicPagePublication("example")?.published).toBe(false);
		const token = store.getEpicPagePublication("example")?.token;
		rmSync(join(dir, "registry.json.tmp"), { recursive: true, force: true });
		expect(await subject.publishHosted(epicPage())).toBe("ok:1");
		expect(putEpicPage.mock.calls[0]?.[0]).toBe(token);
		expect(putEpicPage.mock.calls[1]?.[0]).toBe(token);
		expect(registry.list()).toHaveLength(1);
	});

	it("P4 keeps visible bytes when publication CAS fails, then converges", async () => {
		const realCommit = store.commitEpicPagePublication.bind(store);
		const commitEpicPagePublication = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("publication failed");
			})
			.mockImplementation(realCommit);
		const state = {
			reserveEpicPageToken: store.reserveEpicPageToken.bind(store),
			commitEpicPagePublication,
		};
		const subject = publisher({ store: state });

		expect(await subject.publishHosted(epicPage())).toBe(
			"transient: publish_failed:publication",
		);
		const token = store.getEpicPagePublication("example")?.token;
		expect(blobs.has(token ?? "")).toBe(true);
		expect(registry.list()).toHaveLength(1);
		expect(store.getEpicPagePublication("example")?.published).toBe(false);
		expect(await subject.publishHosted(epicPage())).toBe("ok:1");
		expect(putEpicPage.mock.calls[0]?.[0]).toBe(putEpicPage.mock.calls[1]?.[0]);
		expect(store.getEpicPagePublication("example")?.published).toBe(true);
		expect(registry.list()).toHaveLength(1);
	});
});

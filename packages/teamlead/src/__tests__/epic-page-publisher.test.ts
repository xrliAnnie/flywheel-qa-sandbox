import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { parseEpicPageRefreshOutcome, StateStore } from "../StateStore.js";

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
		await registry.ensureVercelProjectName();
		await registry.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: "2026-09-03T03:00:00.000Z",
				gatewayDeploymentId: "dpl_gateway",
			},
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
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

	it("publishes only a history footer and retains the last page when essential content cannot fit", async () => {
		const { pageForShipJudgmentBudget } = await import(
			"../epic-page/__tests__/fixtures/founder-budget.js"
		);
		const { renderEpicPageBundle } = await import(
			"../epic-page/render-html.js"
		);
		const page = pageForShipJudgmentBudget();
		// Keep the positive fixture near the hosted limit while leaving headroom
		// for the runtime-truth markup and platform-dependent URL serialization.
		page.items[0]!.title.value = "X".repeat(293000);
		expect(
			Buffer.byteLength(renderEpicPageBundle(page, EPIC_SHAPE_NOW).html),
		).toBeLessThanOrEqual(524288);
		expect(await publisher().publishHosted(page)).toBe("ok:1");
		const previous = store.getEpicPagePublication("flywheel");
		const html = blobs.get(previous!.token)!;
		expect(Buffer.byteLength(html) + 88).toBeLessThanOrEqual(524288);
		expect(html.match(/class="kid"/g)).toHaveLength(60);
		expect(html.match(/data-root=/g)).toHaveLength(8);
		expect(html).not.toContain("data-history-row");
		expect(html.match(/机器试判历史按需生成/g)).toHaveLength(1);
		const { decodeAuditSidecar } = await import(
			"../epic-page/audit-sidecar.js"
		);
		expect(
			decodeAuditSidecar(putEpicPage.mock.calls[0]?.[2].json),
		).toContainEqual(page.ship_judgment_history);
		expect(html).toContain("Content-Security-Policy");
		page.items[0]!.title.value = "X".repeat(600000);
		expect(await publisher().publishHosted(page)).toBe(
			"structural: epic_html_too_large",
		);
		expect(putEpicPage).toHaveBeenCalledOnce();
		expect(store.getEpicPagePublication("flywheel")).toEqual(previous);
		expect(blobs.get(previous!.token)).toBe(html);
	});

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

	it("rejects hosting changes between caller snapshot and staging before any put", async () => {
		const stage = registry.stageEpicPageRepublish.bind(registry);
		vi.spyOn(registry, "stageEpicPageRepublish").mockImplementationOnce(
			(...args) => {
				writeFileSync(
					join(dir, "registry.json"),
					JSON.stringify({
						vercelProjectName: "fw-reports-abcdef",
						reports: [],
						hosting: { ...registry.hosting(), storeId: "next" },
					}),
				);
				return stage(...args);
			},
		);
		const result = await publisher().publishHosted(epicPage());
		expect(result).toBe("transient: publish_failed:credentials");
		expect(putEpicPage).not.toHaveBeenCalled();
		expect(registry.list()).toEqual([]);
	});

	it("reports a credential conflict without deleting the stable page after retarget during put", async () => {
		const del = vi.fn();
		putEpicPage.mockImplementationOnce(async (token: string, html: string) => {
			blobs.set(token, html);
			await registry.markHostingMigrated(
				{
					...registry.hosting()!,
					storeId: "newstore",
				},
				{ expectedHostingKey: registry.hostingBinding().hostingKey },
			);
		});
		const outcome = await publisher({
			blobStore: { putEpicPage, deleteReports: del },
		}).publishHosted(epicPage());
		expect(outcome).toBe("transient: publish_failed:credentials");
		expect(parseEpicPageRefreshOutcome(outcome)).toBe(outcome);
		expect(registry.list()).toEqual([]);
		expect(blobs.size).toBe(1);
		expect(del).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"defers real Epic cleanup until registry commit succeeds (conflict=%s)",
		async (conflict) => {
			const objects = new Map<string, string | Buffer>();
			let listSawCommitted = false;
			const list = vi.fn(async () => {
				listSawCommitted = registry.list().length === 1;
				return { blobs: [], hasMore: false };
			});
			const del = vi.fn();
			const actual = new VercelBlobReportStore("fake", {
				get: vi.fn().mockResolvedValue(null),
				list,
				del,
				put: async (pathname, body) => {
					objects.set(pathname, body);
					if (conflict && pathname.endsWith("/index.html"))
						await registry.markHostingMigrated(
							{ ...registry.hosting()!, storeId: "replacement" },
							{ expectedHostingKey: registry.hostingBinding().hostingKey },
						);
					return {
						pathname,
						url: `https://store.private.blob.vercel-storage.com/${pathname}`,
					};
				},
			});
			expect(
				await publisher({
					blobStore: actual,
					probeAudit: async () => true,
				}).publishHosted(epicPage()),
			).toBe(conflict ? "transient: publish_failed:credentials" : "ok:1");
			expect(objects.size).toBe(2);
			expect(list).toHaveBeenCalledTimes(conflict ? 0 : 1);
			expect(listSawCommitted).toBe(!conflict);
			expect(del).not.toHaveBeenCalled();
			expect(registry.list()).toHaveLength(conflict ? 0 : 1);
		},
	);

	it("uses one credential snapshot across Epic audit IO and skips resolving unchanged publications", async () => {
		const a = "vercel_blob_rw_storea_secret";
		let value = "vercel_blob_rw_storeb_secret";
		const snapshot = vi.fn(() => ({
			key: "BLOB_READ_WRITE_TOKEN" as const,
			value,
			source: "file" as const,
			generation: 1,
		}));
		await registry.markHostingMigrated(
			{ ...registry.hosting()!, storeId: "storea" },
			{ expectedHostingKey: registry.hostingBinding().hostingKey },
		);
		const list = vi.fn().mockResolvedValue({ blobs: [], hasMore: false });
		const put = vi.fn(
			async (pathname: string, _body: unknown, options: { token: string }) => {
				value = "vercel_blob_rw_storeb_secret";
				return {
					pathname,
					url: `https://${options.token.split("_")[3]}.private.blob.vercel-storage.com/${pathname}`,
				};
			},
		);
		const actual = new VercelBlobReportStore(undefined, {
			put,
			list,
			del: vi.fn(),
			get: vi.fn().mockResolvedValue(null),
		});
		const subject = publisher({
			credentials: { snapshot },
			blobStore: actual,
			probeAudit: async () => true,
		});
		expect(await subject.publishHosted(epicPage())).toBe(
			"transient: publish_failed:credentials",
		);
		expect(put).not.toHaveBeenCalled();
		value = a;
		expect(await subject.publishHosted(epicPage())).toBe("ok:1");
		expect(put.mock.calls.map((call) => call[2].token)).toEqual([a, a]);
		expect(list.mock.calls[0]![0].token).toBe(a);
		snapshot.mockClear();
		expect(await subject.publishHosted(epicPage())).toBe(
			"ok_unpublished:1:unchanged_digest",
		);
		expect(snapshot).not.toHaveBeenCalled();
	});

	it("skips an unchanged Epic on the same hosting within the 24-hour keepalive", async () => {
		const page = epicPage();
		expect(await publisher().publishHosted(page)).toBe("ok:1");
		page.freshness.current.value!.version = 2;
		const binding = vi.spyOn(registry, "hostingBinding");
		const result = await publisher({
			now: () => new Date(EPIC_SHAPE_NOW.getTime() + 60 * 60 * 1000),
		}).publishHosted(page);
		expect(result).toBe("ok_unpublished:2:unchanged_digest");
		expect(parseEpicPageRefreshOutcome(result)).toBe(result);
		expect(() => parseEpicPageRefreshOutcome("ok_unpublished:2:bogus")).toThrow(
			"epic_page_refresh_outcome_invalid",
		);
		expect(putEpicPage).toHaveBeenCalledTimes(1);
		expect(binding).toHaveBeenCalledTimes(1);
		expect(store.getEpicPagePublication("example")?.last_version).toBe(1);
	});

	it.each(["24h", "25h", "content", "hosting", "legacy-null"])(
		"reuploads instead of skipping when %s invalidates publication proof",
		async (reason) => {
			const page = epicPage();
			expect(await publisher().publishHosted(page)).toBe("ok:1");
			if (reason === "content") page.items[0]!.title.value = "changed content";
			if (reason === "hosting")
				await registry.markHostingMigrated(
					{ ...registry.hosting()!, storeId: "replacement" },
					{ expectedHostingKey: registry.hostingBinding().hostingKey },
				);
			if (reason === "legacy-null")
				(store as unknown as { db: { run(sql: string): void } }).db.run(
					"UPDATE epic_page_publication SET last_content_digest = NULL",
				);
			const hours = reason === "24h" ? 24 : reason === "25h" ? 25 : 1;
			expect(
				await publisher({
					now: () =>
						new Date(EPIC_SHAPE_NOW.getTime() + hours * 60 * 60 * 1000),
				}).publishHosted(page),
			).toBe("ok:1");
			expect(putEpicPage).toHaveBeenCalledTimes(2);
			expect(store.getEpicPagePublication("example")?.last_hosting_key).toBe(
				registry.hostingBinding().hostingKey,
			);
		},
	);

	it("passes the verified gateway format to the Epic Blob write", async () => {
		await registry.markGatewayFormat({
			expectedHostingKey: registry.hostingBinding().hostingKey,
			gatewayDeploymentId: "proved",
		});
		expect(await publisher().publishHosted(epicPage())).toBe("ok:1");
		expect(putEpicPage.mock.calls[0]?.[3]).toEqual({ gzip: true });
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
			(projectName, html, token, title, binding) => {
				const staged = originalStage(projectName, html, token, title, binding);
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
			(projectName, html, token, title, binding) => {
				const staged = originalStage(projectName, html, token, title, binding);
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
			getEpicPagePublication: store.getEpicPagePublication.bind(store),
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	type ReportBlobClient,
	VercelBlobReportStore,
} from "../../bridge/report-blob-store.js";
import { createReportCriticalSection } from "../../bridge/report-critical-section.js";
import { ReportRegistry } from "../../bridge/report-registry.js";
import { StateStore } from "../../StateStore.js";
import { HistoryReportPublisher } from "../history-publisher.js";
import { ShipJudgmentHistoryRuntime } from "../history-runtime.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("recovers a real two-page publish across database and registry restart, reuses unchanged URLs and renews after twelve days", async () => {
	const dir = mkdtempSync(join(tmpdir(), "history-integration-"));
	const seed = await bindingFixture();
	let store: StateStore | undefined,
		runtime: ShipJudgmentHistoryRuntime | undefined;
	try {
		for (let i = 1; i < 21; i++) {
			seed.store.createWorkflowRun({
				runId: "r" + i,
				issueId: "FLY-" + (3000 + i),
				projectName: "flywheel",
				claimsReadEnrolled: true,
			});
			seed.db
				.prepare(
					`INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,authority_mode,subject_kind,carrier_binding_state,card_message_id,state,materialization_stage,created_at,updated_at) SELECT ?,gate_node_id,1,head_sha,source_execution_id,?,authority_mode,subject_kind,carrier_binding_state,card_message_id,state,materialization_stage,created_at,updated_at FROM workflow_gate_holder WHERE question_id='q'`,
				)
				.run("r" + i, "q" + i);
		}
		const path = join(dir, "fixture.db");
		await seed.db.backup(path);
		seed.store.close();
		let now = Date.parse(NOW),
			failFirstPage = true;
		let release!: () => void, reached!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const objects = new Map<string, string>();
		const events: string[] = [];
		const client: ReportBlobClient = {
			get: vi.fn(async (path) => {
				events.push("get:" + path);
				const html = objects.get(path);
				return html === undefined
					? null
					: { statusCode: 200, stream: new Response(html).body! };
			}),
			put: vi.fn(async (path, html, options) => {
				events.push("put:" + path);
				expect(options.allowOverwrite).toBe(false);
				expect(objects.has(path)).toBe(false);
				objects.set(path, html);
				return { pathname: path, url: "https://blob.example/" + path };
			}),
			list: vi.fn(async () => ({ blobs: [], hasMore: false })),
			del: vi.fn(async () => {}),
		};
		const fetchImpl = vi.fn<typeof fetch>(async (url) => {
			const path =
				new URL(String(url)).pathname.replace(/^\//, "").replace(/\/$/, "") +
				"/index.html";
			const html = objects.get(path);
			events.push("verify:" + path);
			if (failFirstPage && html?.includes("第 1 / 2 页")) {
				reached();
				await held;
				return new Response("unavailable", { status: 503 });
			}
			return new Response(html ?? "missing", { status: html ? 200 : 404 });
		});
		const registry = () =>
			new ReportRegistry(join(dir, "reports"), { now: () => now });
		const initial = registry();
		await initial.ensureVercelProjectName();
		await initial.markHostingMigrated(
			{
				provider: "vercel-blob",
				migratedAt: NOW,
				gatewayDeploymentId: "fixture",
			},
			{ expectedHostingKey: initial.hostingBinding().hostingKey },
		);
		const open = async () => {
			store = await StateStore.create(path);
			const publisher = new HistoryReportPublisher({
				registry: registry(),
				blob: new VercelBlobReportStore("fixture-token", client),
				critical: createReportCriticalSection(),
				fetchImpl,
			});
			runtime = new ShipJudgmentHistoryRuntime({
				state: store.getShipJudgmentHistoryState(),
				reader: store.getShipJudgmentHistory(),
				publisher,
				now: () => now,
			});
		};
		await open();
		const pending = runtime!.run();
		await entered;
		expect(store!.getEpicShipJudgmentHistory(NOW)).toMatchObject({
			total: 21,
			readError: false,
		});
		expect(store!.getEpicShipJudgmentHistory(NOW).rows).toHaveLength(20);
		release();
		expect((await pending).status).toBe("failed");
		expect(objects.size).toBe(2);
		expect([...objects.values()][0]).toContain("第 2 / 2 页");
		expect(store!.getShipJudgmentHistoryState().view().url).toBeNull();
		expect(store!.getEpicShipJudgmentHistory(NOW)).toMatchObject({
			total: 21,
			readError: false,
		});
		const oldPaths = [...objects.keys()];
		await runtime!.stop();
		store!.close();
		await open();
		events.length = 0;
		expect((await runtime!.run()).status).toBe("deferred");
		expect(events).toEqual([]);
		now += 1800000;
		failFirstPage = false;
		expect((await runtime!.run()).status).toBe("published");
		expect(events.filter((e) => e.startsWith("put:"))).toEqual([]);
		expect(events.filter((e) => e.startsWith("verify:"))).toHaveLength(1);
		expect([...objects.keys()]).toEqual(oldPaths);
		const published = store!.getShipJudgmentHistoryState().view();
		expect(published.asOf).toBe(NOW);
		const firstHtml = objects.get(
			new URL(published.url!).pathname.replace(/^\//, "").replace(/\/$/, "") +
				"/index.html",
		)!;
		expect(firstHtml).toContain("21");
		expect(firstHtml).toContain("第 1 / 2 页");
		expect(firstHtml).toContain(oldPaths[0]!.replace("/index.html", "/"));
		now += 1800000;
		events.length = 0;
		expect((await runtime!.run()).status).toBe("unchanged");
		expect(events).toEqual([]);
		expect(store!.getShipJudgmentHistoryState().view().url).toBe(published.url);
		now = Date.parse(NOW) + 12 * 86400000;
		events.length = 0;
		expect((await runtime!.run()).status).toBe("published");
		expect(events.filter((e) => e.startsWith("put:"))).toHaveLength(2);
		expect(store!.getShipJudgmentHistoryState().view().url).not.toBe(
			published.url,
		);
		expect(objects.size).toBe(4);
		expect(registry().list()).toHaveLength(4);
	} finally {
		await runtime?.stop();
		store?.close();
		if (seed.db.open) seed.store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

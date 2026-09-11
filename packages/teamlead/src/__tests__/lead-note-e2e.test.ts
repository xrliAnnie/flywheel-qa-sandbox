import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import express from "express";
import { expect, it } from "vitest";
import { masterOnlyAuthMiddleware } from "../bridge/dependency-route.js";
import { createEpicPagePublisher } from "../bridge/epic-page-publisher.js";
import {
	createEpicPageRefresher,
	createEpicPageSerializer,
	runEpicPageAttempt,
} from "../bridge/epic-page-refresher.js";
import { createLeadNoteRouter } from "../bridge/lead-note-route.js";
import type { LinearIssue } from "../bridge/linear-query.js";
import { createReportCriticalSection } from "../bridge/report-critical-section.js";
import { ReportRegistry } from "../bridge/report-registry.js";
import { attentionFixture } from "../epic-page/__tests__/fixtures/attention.js";
import {
	EPIC_SHAPE_NOW,
	emptyItemFacts,
	epicShapeSnapshot,
} from "../epic-page/__tests__/fixtures/epic-shape.js";
import { generateAttentionEpicPage } from "../epic-page/generate.js";
import { materializeEpicPage } from "../epic-page/materialize.js";
import { buildEpicPageRenderReceipt } from "../epic-page/receipt.js";
import { readSignals } from "../epic-page/signals.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

it("real CLI writes and clears project-isolated role notes through the queue and stable publisher", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lead-note-e2e-"));
	const store = await StateStore.create(join(dir, "fixture.db"));
	const snapshot = epicShapeSnapshot();
	const all = [...snapshot.roots, ...snapshot.items];
	all.forEach((item, i) => {
		item.id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
	});
	snapshot.descendantIds = snapshot.items.map((item) => item.id);
	const projects: ProjectEntry[] = ["example", "second"].map(
		(projectName, i) => ({
			projectName,
			projectRoot: dir,
			linear: { team: "EPX" },
			epicPage: { leadNoteFadeDays: 2.5 },
			leads: [
				{
					agentId: "PRIVATE_FIXTURE_AUTHOR",
					department: i ? "生活 部门" : "engineering",
					summaryRole: "producer",
					chatChannel: "123",
					match: { labels: [] },
				},
				{
					agentId: "PRIVATE_FIXTURE_SECOND",
					department: "product",
					summaryRole: "producer",
					chatChannel: "124",
					match: { labels: [] },
				},
			],
		}),
	);
	const registry = new ReportRegistry(dir);
	registry.ensureVercelProjectName();
	registry.markHostingMigrated({
		provider: "vercel-blob",
		migratedAt: EPIC_SHAPE_NOW.toISOString(),
		gatewayDeploymentId: "fixture",
	});
	const blobs = new Map<string, string>();
	const publisher = createEpicPagePublisher({
		store,
		registry,
		criticalSection: createReportCriticalSection(),
		blobStore: {
			putEpicPage: async (token, html) => {
				blobs.set(token, html);
				return {
					pathname: `r/${token}/index.html`,
					url: `https://fixture.private.blob.vercel-storage.com/r/${token}/index.html`,
				};
			},
		},
		now: () => EPIC_SHAPE_NOW,
	});
	const serializer = createEpicPageSerializer();
	let readFailure = false;
	const refresher = createEpicPageRefresher({
		store,
		projects,
		linearApiKey: "fixture",
		runAttempt: (input) =>
			runEpicPageAttempt(
				{
					store,
					serializer,
					publisher,
					now: () => EPIC_SHAPE_NOW,
					materialize: (attempt) =>
						materializeEpicPage(
							{
								fetchSnapshot: async () => snapshot,
								readItemFacts: () => emptyItemFacts(),
								readLeadNotes: (project, ids) => {
									if (readFailure) throw new Error("fixture read failure");
									return store.getLeadNotes(project, ids);
								},
								readSignals: (projectName, items, now) =>
									readSignals(
										{
											stateStore: store,
											openCommReadonly: () => ({
												listEpicPageSignals: () => ({
													signals: [],
													truncated: false,
												}),
												close: () => undefined,
											}),
										},
										{ projectName, items, now },
									),
								readFreshness: (projectName) => ({
									history: store.getEpicPageFreshness(projectName),
									publication: store.getEpicPagePublication(projectName),
								}),
								readAttention: async () => attentionFixture(),
								generatePage: generateAttentionEpicPage,
								buildReceipt: buildEpicPageRenderReceipt,
								now: () => EPIC_SHAPE_NOW,
							},
							{ ...attempt, leadNoteFadeDays: 2.5 },
						),
				},
				input,
			),
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/lead-note",
		masterOnlyAuthMiddleware("fixture-token"),
		createLeadNoteRouter({
			store,
			projects,
			linearApiKey: "fixture",
			lookup: async (identifier) => {
				const item = all.find((item) => item.identifier === identifier);
				return item
					? ({ ...item, labels: [], project: null } as unknown as LinearIssue)
					: null;
			},
			now: () => EPIC_SHAPE_NOW,
			onEpicChange: refresher.requestRefresh,
		}),
	);
	const server = createServer(app);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		for (const [project, role] of [
			["example", "engineering"],
			["second", "生活 部门"],
		]) {
			const invoke = async (
				command: string,
				id: string,
				selectedRole: string,
				text?: string,
			) => {
				const args = [
					command,
					"--issue",
					id,
					"--role",
					selectedRole,
					...(text === undefined ? [] : ["--text", text]),
				];
				const { stdout, stderr } = await promisify(execFile)(
					process.execPath,
					[
						resolve("../flywheel-comm/dist/index.js"),
						"lead-note",
						...args,
						"--project",
						project!,
					],
					{
						env: {
							PATH: process.env.PATH,
							TEAMLEAD_API_TOKEN: "fixture-token",
							FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
						},
						timeout: 15000,
					},
				);
				expect(stderr).toBe("");
				return JSON.parse(stdout.trim());
			};
			expect(
				await invoke(
					"set",
					snapshot.roots[0]!.identifier,
					role!,
					`${project} 根判断`,
				),
			).toMatchObject({ ok: true, refresh: "invoked" });
			expect(
				await invoke(
					"set",
					snapshot.items[0]!.identifier,
					role!,
					`${project} 子判断`,
				),
			).toMatchObject({ ok: true });
			expect(
				await invoke(
					"set",
					snapshot.items[0]!.identifier,
					"product",
					"并列保留",
				),
			).toMatchObject({ ok: true });
			await refresher.flushForTest();
			const publication = store.getEpicPagePublication(project!);
			expect(publication).toBeDefined();
			const token = publication!.token;
			const html = blobs.get(token)!;
			expect(html).toContain(`${project} 根判断`);
			expect(html).toContain(`${project} 子判断`);
			expect(html).toContain("并列保留");
			expect(html).toContain('data-lead-fade-days="2.5"');
			expect(html).not.toContain("PRIVATE_FIXTURE");
			if (project === "second") expect(html).not.toContain("example 子判断");
			expect(
				await invoke("clear", snapshot.items[0]!.identifier, role!),
			).toMatchObject({ ok: true, changed: true });
			await refresher.flushForTest();
			expect(blobs.get(token)).not.toContain(`${project} 子判断`);
			expect(blobs.get(token)).toContain("并列保留");
			const beforeFailure = blobs.get(token);
			readFailure = true;
			await invoke("set", snapshot.items[0]!.identifier, role!, "等待读库恢复");
			await refresher.flushForTest();
			expect(blobs.get(token)).toBe(beforeFailure);
			readFailure = false;
			refresher.requestRefresh(project!, "lead_note_changed");
			await refresher.flushForTest();
			expect(blobs.get(token)).toContain("等待读库恢复");
			for (const [id, r] of [
				[snapshot.items[0]!.id, role!],
				[snapshot.items[0]!.id, "product"],
				[snapshot.roots[0]!.id, role!],
			])
				await invoke("clear", id!, r!);
			await refresher.flushForTest();
			expect(store.getEpicPagePublication(project!)!.token).toBe(token);
			expect(blobs.get(token)).not.toMatch(/<(?:aside|span) class="lead-note/);
			expect(blobs.get(token)).toContain("data-machine-line");
			expect(blobs.get(token)).toContain("机器测的");
			expect(await invoke("show", snapshot.items[0]!.id, role!)).toMatchObject({
				ok: true,
				notes: [],
			});
		}
	} finally {
		await refresher.flushForTest();
		await new Promise<void>((r) => server.close(() => r()));
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	bindingFixture,
	CHANNEL,
} from "../../ship-judgment/__tests__/binding-fixture.js";
import { createShipJudgmentBridgeRuntime } from "../ship-judgment-runtime.js";

it.each([false, true])(
	"retains bounded unknown evidence and delivers only with configured bot identity (%s)",
	async (botConfigured) => {
		const { store, db } = await bindingFixture();
		try {
			vi.spyOn(store, "getSessionLabels").mockReturnValue(["Engineering"]);
			const project: ProjectEntry = {
				projectName: "flywheel",
				projectRoot: "/tmp/fixture",
				projectRepo: "owner/repo",
				leads: [
					{
						agentId: "lead",
						summaryRole: "engineering",
						chatChannel: CHANNEL,
						match: { labels: ["Engineering"] },
					},
				],
			};
			if (botConfigured) {
				project.leads![0]!.botUserId = "123456789012345690";
				project.leads![0]!.botToken = "fixture-token";
			}
			const discord = vi.fn(
				async (_url: string, options: RequestInit) =>
					new Response(
						JSON.stringify({
							id: "123456789012345682",
							channel_id: "123456789012345679",
							author: { id: "123456789012345690", bot: true },
							content: JSON.parse(String(options.body)).content,
							timestamp: new Date().toISOString(),
							edited_timestamp:
								options.method === "PATCH" ? new Date().toISOString() : null,
						}),
					),
			);
			vi.stubGlobal("fetch", discord);
			let mode = "off";
			const token = vi.fn(async () => "secret"),
				modelBin = vi.fn(() => "must-not-run");
			const deps = {
				store,
				projects: [project],
				mode: () => mode,
				registry: { readReportHtml: () => "" },
				hosting: {},
				token,
				modelBin,
				onError: vi.fn(),
			};
			expect(
				createShipJudgmentBridgeRuntime({
					...deps,
					projects: [{ ...project, projectName: "other" }],
				}),
			).toBeUndefined();
			const runtime = createShipJudgmentBridgeRuntime(deps)!;
			await runtime.scanner.tick();
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_opinion").get(),
			).toEqual({ n: 0 });
			mode = "dry_run";
			await runtime.scanner.tick();
			await runtime.worker.tick();
			expect(
				db.prepare("SELECT overall,reason FROM ship_judgment_opinion").get(),
			).toEqual({
				overall: "undetermined",
				reason: "project_sources_unavailable",
			});
			await runtime.scanner.tick();
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_opinion").get(),
			).toEqual({ n: 1 });
			expect(token).not.toHaveBeenCalled();
			expect(modelBin).not.toHaveBeenCalled();
			expect(deps.onError).not.toHaveBeenCalled();
			expect(discord).toHaveBeenCalledTimes(botConfigured ? 1 : 0);
			if (botConfigured) {
				expect(
					db
						.prepare("SELECT state,message_id FROM ship_judgment_delivery")
						.get(),
				).toEqual({ state: "delivered", message_id: "123456789012345682" });
				expect(
					db
						.prepare(
							"SELECT COUNT(*) AS n FROM workflow_run_event WHERE kind='ship_judgment_visible'",
						)
						.get(),
				).toEqual({ n: 1 });
			}

			mode = "auto";
			await runtime.modeTick();
			await runtime.modeTick();
			expect(discord).toHaveBeenCalledTimes(botConfigured ? 2 : 0);
			if (botConfigured)
				expect(
					db.prepare("SELECT mode_label FROM ship_judgment_delivery").get(),
				).toEqual({ mode_label: "history" });
			mode = "dry_run";
			await runtime.modeTick();
			await runtime.scanner.tick();
			expect(discord).toHaveBeenCalledTimes(botConfigured ? 3 : 0);
			if (botConfigured)
				expect(
					db
						.prepare("SELECT message_id,mode_label FROM ship_judgment_delivery")
						.get(),
				).toEqual({ message_id: "123456789012345682", mode_label: "current" });
			await runtime.stop();
		} finally {
			vi.unstubAllGlobals();
			store.close();
		}
	},
);

it.each([true, false])(
	"sends at most two pending learning receipts with configured bot (%s)",
	async (botConfigured) => {
		const { LearningDelivery } = await import(
			"../../ship-judgment/learning-delivery.js"
		);
		const { store, db } = await bindingFixture();
		let runtime: ReturnType<typeof createShipJudgmentBridgeRuntime>;
		try {
			vi.spyOn(store, "getSessionLabels").mockReturnValue(["Engineering"]);
			const project: ProjectEntry = {
				projectName: "flywheel",
				projectRoot: "/tmp/fixture",
				projectRepo: "owner/repo",
				leads: [
					{
						agentId: "lead",
						summaryRole: "engineering",
						chatChannel: CHANNEL,
						match: { labels: ["Engineering"] },
						botUserId: botConfigured ? "123456789012345690" : undefined,
						botToken: "fixture-token",
					},
				],
			};
			const insert = db.prepare(
				`INSERT INTO ship_judgment_delivery(purpose,subject_id,question_id,thread_id,card_message_id,desired_id,state,marker) VALUES ('ack',?,'q','123456789012345679','123456789012345678',?,'pending',?)`,
			);
			for (const prefix of ["a", "b", "c"]) {
				const id = prefix.repeat(64);
				insert.run(id, id, `ship-judgment:ack:${id}`);
			}
			vi.spyOn(LearningDelivery.prototype, "view").mockReturnValue({
				content: "已记录，未改变批准",
				replyTo: "123456789012345691",
				since: "2026-09-11T00:00:00.000Z",
			});
			let mode = "off";
			let posts = 0;
			const network = vi.fn(async (_url: unknown, options?: RequestInit) => {
				expect((options?.headers as Record<string, string>).Authorization).toBe(
					"Bot fixture-token",
				);
				if (options?.method === "POST") {
					posts++;
					return new Response(
						JSON.stringify({
							id: String(123456789012345695n + BigInt(posts)),
							channel_id: "123456789012345679",
							author: { id: "123456789012345690", bot: true },
							content: JSON.parse(String(options.body)).content,
							timestamp: new Date().toISOString(),
						}),
					);
				}
				return new Response(
					JSON.stringify({
						id: "123456789012345679",
						guild_id: CHANNEL,
						type: 11,
						thread_metadata: { archived: false },
					}),
				);
			});
			vi.stubGlobal("fetch", network);
			runtime = createShipJudgmentBridgeRuntime({
				store,
				projects: [project],
				guildId: CHANNEL,
				mode: () => mode,
				registry: { readReportHtml: () => "" },
				hosting: {},
				token: async () => "",
				modelBin: () => "",
				onError: vi.fn(),
			});
			const beforeOff = db.prepare("SELECT total_changes() AS n").get();
			await runtime!.modeTick();
			expect(posts).toBe(0);
			expect(network).not.toHaveBeenCalled();
			expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(
				beforeOff,
			);
			expect(
				db
					.prepare(
						"SELECT count(*) AS n FROM ship_judgment_delivery WHERE purpose='ack' AND state='pending' AND last_error IS NULL AND retry_after IS NULL",
					)
					.get(),
			).toEqual({ n: 3 });
			mode = "dry_run";
			await runtime!.modeTick();
			expect(posts).toBe(botConfigured ? 2 : 0);
			expect(
				db
					.prepare(
						"SELECT count(*) AS n FROM ship_judgment_delivery WHERE purpose='ack' AND state='delivered'",
					)
					.get(),
			).toEqual({ n: botConfigured ? 2 : 0 });
			await runtime!.modeTick();
			expect(posts).toBe(botConfigured ? 3 : 0);
			if (!botConfigured) {
				expect(network).not.toHaveBeenCalled();
				expect(
					db
						.prepare(
							"SELECT count(*) AS n FROM ship_judgment_delivery WHERE purpose='ack' AND last_error='learning_owner_or_guild_missing' AND retry_after IS NOT NULL",
						)
						.get(),
				).toEqual({ n: 3 });
			}
		} finally {
			await runtime?.stop();
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			store.close();
		}
	},
);

it("production model wiring resolves Claude independently of the account-switch executable", () => {
	const source = readFileSync(new URL("../plugin.ts", import.meta.url), "utf8");
	const wiring = source.slice(
		source.indexOf(
			"const shipJudgmentRuntime = createShipJudgmentBridgeRuntime({",
		),
		source.indexOf("let autoNarrowGateScanCursor"),
	);
	const expression = wiring.match(/modelBin:\s*(.+),/)?.[1];
	expect(expression).toBeDefined();
	const profileBin = vi.fn(() => "/fixture/flywheel-claude-profile");
	const resolve = runInNewContext(`(${expression})`, {
		claudeProfileBinPath: profileBin,
	}) as () => string;
	expect(resolve()).toBe("claude");
	expect(profileBin).not.toHaveBeenCalled();
});

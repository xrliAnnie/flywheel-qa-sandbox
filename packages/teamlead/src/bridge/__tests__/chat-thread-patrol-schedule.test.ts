/** FLY-2914: patrol root-cause schedule asks through the existing /chat-threads/send route. */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { rootCauseRequestHeader } from "../../patrol-root-causes.js";
import { StateStore } from "../../StateStore.js";
import { createQueryRouter, type QueryRouterOptions } from "../tools.js";

const CHILD = "bff5c1b6-c7f6-4017-9710-52ff55b37c34";
const KEY = "c".repeat(64);

vi.mock("@linear/sdk", () => ({
	LinearClient: class {
		async issue(id: string) {
			return { id, identifier: "FLY-2373", title: "[病根] drain · ×34" };
		}
		async searchIssues() {
			return { nodes: [] };
		}
	},
}));

const PROJECT: ProjectEntry = {
	projectName: "flywheel",
	projectRoot: "/tmp/flywheel",
	leads: [
		{
			agentId: "flywheel-eng-lead",
			chatChannel: "ch-eng",
			match: { labels: ["Flywheel"] },
			botToken: "tadashi-token",
		},
		{
			agentId: "flywheel-product-lead",
			chatChannel: "ch-product",
			match: { labels: ["product"] },
			botToken: "product-token",
		},
	],
};

let server: Server;
let store: StateStore;
let fetchMock: ReturnType<typeof vi.fn>;
let resolver: ReturnType<typeof vi.fn>;

async function post(body: unknown) {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("unbound");
	const res = await fetch(
		`http://127.0.0.1:${addr.port}/api/chat-threads/send`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

function body(over: Record<string, unknown> = {}) {
	return {
		issueId: CHILD,
		channelId: "ch-eng",
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		text: "FLY-2373 已出现 34 次且没有修复在跑，请决定是否排修。",
		founderAsk: { patrolSchedule: { issueUuid: CHILD } },
		...over,
	};
}

describe("FLY-2914 /chat-threads/send founderAsk.patrolSchedule", () => {
	beforeEach(async () => {
		process.env.LINEAR_API_KEY = "test-linear";
		store = await StateStore.create(":memory:");
		store.upsertChatThread(
			"thread-2373",
			"ch-eng",
			"FLY-2373",
			"flywheel-eng-lead",
		);
		fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ id: "1553272103002709999" }),
		}));
		resolver = vi.fn(async () => ({
			scheduleKey: KEY,
			identifier: "FLY-2373",
			parentUuid: "5914cef5-05bf-45a3-be14-edbc858147a2",
		}));
		const options: QueryRouterOptions = {
			chatThreadsEnabled: true,
			replyByIssueEnabled: true,
			apiTokenConfigured: true,
			discordFetch: fetchMock as unknown as typeof fetch,
			resolveRootCauseSchedule: resolver,
		};
		const app = express();
		app.use(express.json());
		app.use("/api", createQueryRouter(store, [PROJECT], options));
		server = createServer(app);
		server.listen(0);
	});
	afterEach(() => {
		server.close();
		store.close();
	});

	it("binds the server-computed key, sends one attributable message, and never re-sends while open", async () => {
		const first = await post(body());
		expect(first.status).toBe(200);
		const askId = first.body.founderAskId as string;
		expect(resolver).toHaveBeenCalledWith(
			CHILD,
			"flywheel",
			"flywheel-eng-lead",
		);
		expect(store.getFounderAsk(askId)).toMatchObject({
			patrol_schedule_key: KEY,
			issue_id: "FLY-2373",
			thread_id: "thread-2373",
			message_id: "1553272103002709999",
			settled_at: null,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const sent = JSON.parse(
			(fetchMock.mock.calls[0]![1] as { body: string }).body,
		) as { content: string };
		expect(sent.content.startsWith(rootCauseRequestHeader("FLY-2373"))).toBe(
			true,
		);
		expect(sent.content).toContain("FLY-2373 已出现 34 次");
		expect(sent.content).toContain(`rootcause:${KEY.slice(0, 12)}`);

		const again = await post(body());
		expect(again.status).toBe(409);
		expect(again.body).toMatchObject({
			error: "patrol_schedule_ask_open",
			founderAskId: askId,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("releases the key when the send is confirmed failed", async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 403,
			text: async () => "forbidden",
		});
		const failed = await post(body());
		expect(failed.status).toBe(502);
		expect(
			store.getFounderAsk(failed.body.founderAskId as string)?.settled_by,
		).toBe("send_failed");
		expect(store.getOpenPatrolScheduleAsk("flywheel", KEY)).toBeUndefined();
		expect((await post(body())).status).toBe(200);
	});

	it.each([
		[
			"a model-chosen key",
			{
				founderAsk: { patrolSchedule: { issueUuid: CHILD, scheduleKey: KEY } },
			},
			400,
		],
		[
			"a mismatched thread issue",
			{ issueId: "5914cef5-05bf-45a3-be14-edbc858147a2" },
			400,
		],
		["a multi-chunk body", { text: `FLY-2373 ${"很".repeat(1800)}` }, 400],
		[
			"a body short in code points but multi-chunk in UTF-16",
			{ text: `FLY-2373 ${"😀".repeat(900)}` },
			400,
		],
		[
			"a non-owner Lead",
			{ leadId: "flywheel-product-lead", channelId: "ch-product" },
			403,
		],
	])("rejects %s before any Discord write", async (_name, over, status) => {
		if (status === 403)
			resolver.mockRejectedValueOnce(
				Object.assign(new Error("patrol_schedule_scope"), {
					token: "patrol_schedule_scope",
				}),
			);
		const res = await post(body(over));
		expect(res.status).toBe(status);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(store.listOpenFounderAsks("flywheel")).toEqual([]);
	});

	it("prefixes the server-owned request even when the Lead text omits or contradicts it", async () => {
		const res = await post(body({ text: "FLY-2373 无需排修" }));
		expect(res.status).toBe(200);
		const sent = JSON.parse(
			(fetchMock.mock.calls[0]![1] as { body: string }).body,
		) as { content: string };
		expect(sent.content.split("\n")[0]).toBe(
			rootCauseRequestHeader("FLY-2373"),
		);
	});
});

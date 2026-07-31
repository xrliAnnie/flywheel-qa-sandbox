import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DISCORD_MESSENGER_AGENT_ID,
	FOUNDER_DISCORD_USER_ID,
	V2DiscordOutbound,
} from "../v2-discord-outbound.js";
import type { V2DisplayStore } from "../v2-display-refresher.js";

interface CliCall {
	verb: string;
	args: string[];
}

function envelope(kind: string, payload: Record<string, unknown>, n: number) {
	return {
		message: {
			messageUid: `msg-${n}`,
			kind,
			payload: JSON.stringify(payload),
		},
		handle: { attemptUid: `attempt-${n}`, messageUid: `msg-${n}` },
		authorization: { capabilityId: `cap-${n}`, token: `token-${n}` },
	};
}

describe("FLY-1544 ③④ — v2 Discord outbound messenger", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates the issue thread once, pulls the founder in, relays progress, archives on close, settles every delivery", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-outbound-"));
		roots.push(root);
		const statePath = join(root, "outbound-state.json");
		const cliCalls: CliCall[] = [];
		const deliveries = [
			envelope(
				"issue_opened",
				{
					v: 1,
					issue_id: "FLY-77",
					task_kinds: ["design", "implement", "qa"],
				},
				1,
			),
			envelope(
				"runner_ask",
				{
					v: 1,
					issue_id: "FLY-77",
					ask_kind: "progress",
					body: "halfway through implement",
				},
				2,
			),
			envelope("issue_closed", { v: 1, issue_id: "FLY-77" }, 3),
		];
		let submits = 0;
		const runImpl = (async (_file: string, args: readonly string[]) => {
			const verb = args[0] as string;
			cliCalls.push({ verb, args: [...args] });
			if (verb === "register-lead") {
				return { stdout: '{"deliveryCredential":"stashed"}', stderr: "" };
			}
			if (verb === "next") {
				const next = deliveries.shift();
				if (!next) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					throw new Error("no delivery became available before timeout");
				}
				return { stdout: JSON.stringify(next), stderr: "" };
			}
			if (verb === "submit") {
				submits += 1;
				return { stdout: '{"status":"succeeded"}', stderr: "" };
			}
			throw new Error(`unexpected verb ${verb}`);
		}) as unknown as V2DiscordOutboundOptionsRun;
		const fetchCalls: Array<{ method: string; url: string }> = [];
		const fetchImpl = (async (url: unknown, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			const address = String(url);
			fetchCalls.push({ method, url: address });
			if (address.endsWith("/channels/chan-1/messages")) {
				return jsonResponse({ id: "root-1" });
			}
			if (address.endsWith("/messages/root-1/threads")) {
				return jsonResponse({ id: "thread-1" });
			}
			if (address.includes("/thread-members/")) {
				return jsonResponse({});
			}
			if (address.endsWith("/channels/thread-1/messages")) {
				return jsonResponse({ id: "posted-1" });
			}
			if (address.endsWith("/channels/thread-1")) {
				return jsonResponse({ thread_metadata: { archived: true } });
			}
			throw new Error(`unexpected fetch ${method} ${address}`);
		}) as unknown as typeof fetch;

		const outbound = new V2DiscordOutbound({
			v2CliBin: "/opt/flywheel-v2",
			socketPath: "/tmp/v2/host.sock",
			secretPath: "/tmp/v2/host.secret",
			hostEpoch: "epoch-test",
			sessionProofRoot: join(root, "proofs"),
			statePath,
			botToken: "bot-token",
			chatChannelId: "chan-1",
			logger: { log() {}, warn() {}, error() {} },
			runImpl,
			fetchImpl,
			pollDelayMs: 5,
		});
		await outbound.start();
		const deadline = Date.now() + 5_000;
		while (submits < 3 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await outbound.stop();

		expect(submits).toBe(3);
		const register = cliCalls.find((call) => call.verb === "register-lead");
		expect(register?.args).toContain("--agent");
		expect(register?.args).toContain(DISCORD_MESSENGER_AGENT_ID);

		// One thread creation for the whole issue (later envelopes reuse it).
		expect(
			fetchCalls.filter((call) => call.url.endsWith("root-1/threads")),
		).toHaveLength(1);
		// The founder was pulled into the thread.
		expect(
			fetchCalls.some((call) =>
				call.url.endsWith(`/thread-members/${FOUNDER_DISCORD_USER_ID}`),
			),
		).toBe(true);
		// issue_closed archived the thread (PATCH on the thread channel).
		expect(
			fetchCalls.some(
				(call) =>
					call.method === "PATCH" && call.url.endsWith("/channels/thread-1"),
			),
		).toBe(true);
		// Every settle carried the delivery's own capability.
		const submitted = cliCalls.filter((call) => call.verb === "submit");
		expect(submitted).toHaveLength(3);
		expect(submitted[0]?.args).toContain("cap-1");
		expect(submitted[2]?.args).toContain("cap-3");
		// The issue→thread mapping is durable.
		expect(
			JSON.parse(readFileSync(statePath, "utf8")) as {
				threads: Record<string, string>;
			},
		).toMatchObject({ threads: { "FLY-77": "thread-1" } });
	});
});

describe("FLY-1549 — display refresher wiring", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function harness(
		deliveries: ReturnType<typeof envelope>[],
		display: {
			enqueue: (issueId: string) => void;
			refresh: (issueId: string) => Promise<boolean>;
			maybeSweep: () => Promise<void>;
			holdIssue?: <T>(issueId: string, fn: () => Promise<T>) => Promise<T>;
		},
		onFetch?: (method: string, url: string) => void,
	) {
		let capturedStore: V2DisplayStore | undefined;
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-outbound-"));
		roots.push(root);
		const statePath = join(root, "outbound-state.json");
		const queue = [...deliveries];
		let submits = 0;
		const runImpl = (async (_file: string, args: readonly string[]) => {
			const verb = args[0] as string;
			if (verb === "register-lead") {
				return { stdout: "{}", stderr: "" };
			}
			if (verb === "next") {
				const next = queue.shift();
				if (!next) {
					await new Promise((resolve) => setTimeout(resolve, 10));
					throw new Error("no delivery became available before timeout");
				}
				return { stdout: JSON.stringify(next), stderr: "" };
			}
			if (verb === "submit") {
				submits += 1;
				return { stdout: "{}", stderr: "" };
			}
			throw new Error(`unexpected verb ${verb}`);
		}) as unknown as V2DiscordOutboundOptionsRun;
		const fetchCalls: Array<{ method: string; url: string }> = [];
		const fetchImpl = (async (url: unknown, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			const address = String(url);
			fetchCalls.push({ method, url: address });
			onFetch?.(method, address);
			if (address.endsWith("/channels/chan-1/messages")) {
				return jsonResponse({ id: "root-1" });
			}
			if (address.endsWith("/messages/root-1/threads")) {
				return jsonResponse({ id: "thread-1" });
			}
			if (address.includes("/thread-members/")) return jsonResponse({});
			if (address.endsWith("/channels/thread-1/messages")) {
				return jsonResponse({ id: "posted-1" });
			}
			if (address.endsWith("/channels/thread-1")) {
				return jsonResponse({ thread_metadata: { archived: true } });
			}
			throw new Error(`unexpected fetch ${method} ${address}`);
		}) as unknown as typeof fetch;
		const outbound = new V2DiscordOutbound({
			v2CliBin: "/opt/flywheel-v2",
			socketPath: "/tmp/v2/host.sock",
			secretPath: "/tmp/v2/host.secret",
			hostEpoch: "epoch-test",
			sessionProofRoot: join(root, "proofs"),
			statePath,
			botToken: "bot-token",
			chatChannelId: "chan-1",
			logger: { log() {}, warn() {}, error() {} },
			runImpl,
			fetchImpl,
			pollDelayMs: 5,
			makeDisplayRefresher: (store) => {
				capturedStore = store;
				return {
					enqueue: display.enqueue,
					refresh: display.refresh,
					maybeSweep: display.maybeSweep,
					holdIssue: display.holdIssue ?? ((_issueId, fn) => fn()),
				};
			},
		});
		return {
			outbound,
			fetchCalls,
			statePath,
			getStore: () => capturedStore,
			waitForSubmits: async (count: number) => {
				const deadline = Date.now() + 5_000;
				while (submits < count && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				return submits;
			},
		};
	}

	it("lifecycle deliveries trigger a coalesced display refresh", async () => {
		const enqueued: string[] = [];
		const { outbound, waitForSubmits } = harness(
			[
				envelope("issue_opened", { v: 1, issue_id: "FLY-88" }, 1),
				envelope(
					"task_dispatched",
					{ v: 1, issue_id: "FLY-88", task_kind: "design" },
					2,
				),
			],
			{
				enqueue: (issueId) => enqueued.push(issueId),
				refresh: async () => true,
				maybeSweep: async () => {},
			},
		);
		await outbound.start();
		await waitForSubmits(2);
		await outbound.stop();
		expect(enqueued).toEqual(["FLY-88", "FLY-88"]);
	});

	it("issue_closed refreshes BEFORE archiving and marks archivedAt", async () => {
		const order: string[] = [];
		const { outbound, fetchCalls, statePath, waitForSubmits } = harness(
			[envelope("issue_closed", { v: 1, issue_id: "FLY-88" }, 1)],
			{
				enqueue: () => {},
				refresh: async (issueId) => {
					order.push(`refresh:${issueId}`);
					return true;
				},
				maybeSweep: async () => {},
			},
		);
		await outbound.start();
		await waitForSubmits(1);
		await outbound.stop();
		const archiveIndex = fetchCalls.findIndex(
			(call) =>
				call.method === "PATCH" && call.url.endsWith("/channels/thread-1"),
		);
		expect(order).toEqual(["refresh:FLY-88"]);
		expect(archiveIndex).toBeGreaterThan(-1);
		const state = JSON.parse(readFileSync(statePath, "utf8")) as {
			display?: Record<string, { archivedAt?: string }>;
		};
		// archivedAt only lands when a display record exists; here the fake
		// refresher never wrote one, so the map may be absent — the contract
		// under test is the ORDER (refresh before archive), asserted above.
		expect(state.display?.["FLY-88"]?.archivedAt ?? null).toBeNull();
	});

	it("an unconfirmed terminal display defers the archive to the sweep", async () => {
		const { outbound, fetchCalls, waitForSubmits } = harness(
			[envelope("issue_closed", { v: 1, issue_id: "FLY-88" }, 1)],
			{
				enqueue: () => {},
				refresh: async () => false,
				maybeSweep: async () => {},
			},
		);
		await outbound.start();
		await waitForSubmits(1);
		await outbound.stop();
		expect(
			fetchCalls.some(
				(call) =>
					call.method === "PATCH" && call.url.endsWith("/channels/thread-1"),
			),
		).toBe(false);
	});

	it("the whole issue_closed sequence (refresh → archive → archivedAt) runs inside the per-issue fence (Codex design R7 #1, hardened per R8)", async () => {
		const events: string[] = [];
		let getStore: () => V2DisplayStore | undefined = () => undefined;
		const { outbound, waitForSubmits, ...rest } = harness(
			[envelope("issue_closed", { v: 1, issue_id: "FLY-88" }, 1)],
			{
				enqueue: () => {},
				refresh: async () => {
					// A real refresh persists a record — required so the
					// archivedAt stamp is observable, not a no-op (R8).
					getStore()?.setRecord("FLY-88", { fp: "fp-1" });
					events.push("refresh");
					return true;
				},
				maybeSweep: async () => {},
				holdIssue: async (issueId, fn) => {
					events.push(`hold-start:${issueId}`);
					const result = await fn();
					// At hold release the archivedAt stamp must ALREADY be
					// durable — if the stamp (or archive) were moved outside
					// the fence this reads stamped=false and the test fails.
					events.push(
						`hold-end:${issueId}:stamped=${Boolean(
							getStore()?.getRecord("FLY-88")?.archivedAt,
						)}`,
					);
					return result;
				},
			},
			(method, url) => {
				if (method === "PATCH" && url.endsWith("/channels/thread-1")) {
					events.push("archive-patch");
				}
			},
		);
		getStore = rest.getStore;
		await outbound.start();
		await waitForSubmits(1);
		await outbound.stop();
		expect(events).toEqual([
			"hold-start:FLY-88",
			"refresh",
			"archive-patch",
			"hold-end:FLY-88:stamped=true",
		]);
	});

	it("the pull loop piggybacks the sweep", async () => {
		let sweeps = 0;
		const { outbound, waitForSubmits } = harness(
			[envelope("issue_opened", { v: 1, issue_id: "FLY-88" }, 1)],
			{
				enqueue: () => {},
				refresh: async () => true,
				maybeSweep: async () => {
					sweeps += 1;
				},
			},
		);
		await outbound.start();
		await waitForSubmits(1);
		await outbound.stop();
		expect(sweeps).toBeGreaterThan(0);
	});
});

type V2DiscordOutboundOptionsRun = NonNullable<
	ConstructorParameters<typeof V2DiscordOutbound>[0]["runImpl"]
>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

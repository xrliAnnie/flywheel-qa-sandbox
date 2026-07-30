import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DISCORD_MESSENGER_AGENT_ID,
	FOUNDER_DISCORD_USER_ID,
	V2DiscordOutbound,
} from "../v2-discord-outbound.js";

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

type V2DiscordOutboundOptionsRun = NonNullable<
	ConstructorParameters<typeof V2DiscordOutbound>[0]["runImpl"]
>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

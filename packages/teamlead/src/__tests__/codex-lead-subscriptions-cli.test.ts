import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runSubscriptionsCli } from "../codex-lead-subscriptions-cli.js";
import {
	CodexLeadInboxServer,
	resolveCodexLeadInboxSocketPath,
} from "../lead-backends/codex/CodexLeadInboxSocket.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function harness(token: string | undefined = "test-secret") {
	const root = mkdtempSync(join(tmpdir(), "fly1942-sub-cli-"));
	roots.push(root);
	const output: string[] = [];
	const errors: string[] = [];
	return {
		root,
		output,
		errors,
		deps: {
			loadProjects: () => [
				{
					projectName: "flywheel",
					leads: [{ agentId: "lead-a", botToken: token }],
				},
			],
			resolveStateDir: () => root,
			env: {},
			now: () => Date.parse("2026-09-11T12:00:00Z"),
			stdout: (s: string) => output.push(s),
			stderr: (s: string) => errors.push(s),
		},
	};
}
const args = ["list", "--project", "flywheel", "--lead", "lead-a", "--json"];
it("lists active/expired entries without writing the ledger or needing a running socket", async () => {
	const h = harness();
	const path = join(h.root, "roundtable-subscriptions.json");
	const make = (threadId: string, expiresAt: string) => ({
		threadId,
		parentChannelId: "22345678901234567",
		source: "mention",
		subscribedAt: "2026-09-11T00:00:00Z",
		lastActivityAt: "2026-09-11T00:00:00Z",
		expiresAt,
	});
	const bytes = JSON.stringify({
		version: 1,
		entries: [
			make("12345678901234567", "2026-09-12T00:00:00Z"),
			make("12345678901234568", "2026-09-11T01:00:00Z"),
		],
	});
	writeFileSync(path, bytes);
	expect(await runSubscriptionsCli(args, h.deps)).toBe(0);
	expect(
		JSON.parse(h.output[0]!).entries.map((e: { status: string }) => e.status),
	).toEqual(["active", "expired"]);
	expect(readFileSync(path, "utf8")).toBe(bytes);
	expect(readdirSync(h.root)).toEqual(["roundtable-subscriptions.json"]);
});
it("reports corruption without quarantining or rewriting", async () => {
	const h = harness();
	const path = join(h.root, "roundtable-subscriptions.json");
	writeFileSync(path, "broken");
	expect(await runSubscriptionsCli(args, h.deps)).toBe(4);
	expect(readFileSync(path, "utf8")).toBe("broken");
	expect(readdirSync(h.root)).toEqual(["roundtable-subscriptions.json"]);
});
it("requires the runtime secret and accepts the production fallback env", async () => {
	const h = harness();
	h.deps.loadProjects = () => [
		{
			projectName: "flywheel",
			leads: [{ agentId: "lead-a", botToken: undefined }],
		},
	];
	expect(await runSubscriptionsCli(args, h.deps)).toBe(2);
	expect(
		await runSubscriptionsCli(args, {
			...h.deps,
			env: { DISCORD_BOT_TOKEN: "fallback-secret" },
		}),
	).toBe(0);
});
it("returns 3 for an absent runtime and rejects malformed thread before connecting", async () => {
	const h = harness();
	const base = [
		"unsubscribe",
		"--project",
		"flywheel",
		"--lead",
		"lead-a",
		"--thread",
	];
	expect(
		await runSubscriptionsCli([...base, "12345678901234567"], h.deps),
	).toBe(3);
	expect(await runSubscriptionsCli([...base, "../wrong"], h.deps)).toBe(2);
});

it("delivers authenticated CLI unsubscribe to the runtime with the production fallback secret", async () => {
	const h = harness();
	const calls: string[][] = [];
	const server = new CodexLeadInboxServer({
		socketPath: resolveCodexLeadInboxSocketPath(h.root),
		leadId: "lead-a",
		authSecret: "fallback-secret",
		router: {
			submitBatch: () => {
				throw new Error("not model input");
			},
		},
		subscriptions: {
			list: () => [],
			remove: async (...args: string[]) => {
				calls.push(args);
				return true;
			},
		},
	});
	await server.listen();
	try {
		const code = await runSubscriptionsCli(
			[
				"unsubscribe",
				"--project",
				"flywheel",
				"--lead",
				"lead-a",
				"--thread",
				"12345678901234567",
				"--reason",
				"manual cleanup",
				"--json",
			],
			{
				...h.deps,
				loadProjects: () => [
					{ projectName: "flywheel", leads: [{ agentId: "lead-a" }] },
				],
				env: { DISCORD_BOT_TOKEN: "fallback-secret" },
			},
		);
		expect(code).toBe(0);
		expect(calls).toEqual([["12345678901234567", "manual cleanup", "cli"]]);
		expect(JSON.parse(h.output[0]!)).toEqual({
			thread_id: "12345678901234567",
			removed: true,
		});
	} finally {
		await server.close();
	}
});

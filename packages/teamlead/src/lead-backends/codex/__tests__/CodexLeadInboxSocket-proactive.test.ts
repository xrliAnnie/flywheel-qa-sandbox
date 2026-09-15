import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	CodexLeadInboxServer,
	engageCodexLeadProactiveTopic,
	probeCodexLeadInboxCapabilities,
} from "../CodexLeadInboxSocket.js";

const roots: string[] = [];
const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) await s.close();
	for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const receipt = {
	socketOwnerId: "owner",
	parentChannelId: "12345678901234567",
	messageId: "12345678901234568",
	eventId: "event:out",
	payloadHash: "a".repeat(64),
};
async function setup(
	engage?: (
		receipt: typeof receipt,
		assertCurrentOwner: () => void,
	) => Promise<"pending" | "ready">,
	isCurrentOwner = () => true,
) {
	const root = mkdtempSync(join(tmpdir(), "rt-socket-"));
	roots.push(root);
	const args = {
		socketPath: join(root, "inbox.sock"),
		leadId: "lead",
		authSecret: "test-secret",
	};
	const submitBatch = vi.fn(() => {
		throw Error("must not start a turn");
	});
	const server = new CodexLeadInboxServer({
		...args,
		socketOwnerId: "owner",
		router: { submitBatch },
		...(engage
			? {
					proactiveTopic: {
						parentChannelId: receipt.parentChannelId,
						isCurrentOwner,
						engage,
					},
				}
			: {}),
	});
	servers.push(server);
	await server.listen();
	return { args, server, submitBatch };
}
it("advertises only a live configured hook and binds authenticated receipts before invoking it", async () => {
	const engage = vi.fn(async () => "ready" as const);
	const { args, submitBatch } = await setup(engage);
	expect((await probeCodexLeadInboxCapabilities(args)).features).toContain(
		"roundtable_proactive_engage_v1",
	);
	for (const change of [
		{ authSecret: "bad" },
		{ leadId: "other" },
		{ socketOwnerId: "stale" },
		{ parentChannelId: "12345678901234569" },
		{ messageId: "bad" },
		{ payloadHash: "bad" },
	]) {
		await expect(
			engageCodexLeadProactiveTopic({ ...args, ...receipt, ...change }),
		).rejects.toThrow();
	}
	expect(engage).not.toHaveBeenCalled();
	await expect(
		engageCodexLeadProactiveTopic({ ...args, ...receipt }),
	).resolves.toEqual({ engagement: "ready", threadId: receipt.messageId });
	expect(engage).toHaveBeenCalledOnce();
	expect(submitBatch).not.toHaveBeenCalled();
	const legacy = await setup();
	expect(
		(await probeCodexLeadInboxCapabilities(legacy.args)).features,
	).not.toContain("roundtable_proactive_engage_v1");
	await expect(
		engageCodexLeadProactiveTopic({ ...legacy.args, ...receipt }),
	).rejects.toThrow(/unavailable/);
});
it("rechecks ownership after awaited work and before the hook writes", async () => {
	let owner = true;
	let entered!: () => void;
	let resume!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const deferred = new Promise<void>((r) => {
		resume = r;
	});
	const write = vi.fn();
	const { args } = await setup(
		async (_receipt, assertCurrentOwner) => {
			entered();
			await deferred;
			assertCurrentOwner();
			write();
			return "ready";
		},
		() => owner,
	);
	const result = engageCodexLeadProactiveTopic({ ...args, ...receipt });
	const rejected = expect(result).rejects.toThrow(/owner/);
	await started;
	owner = false;
	resume();
	await rejected;
	expect(write).not.toHaveBeenCalled();
	expect((await probeCodexLeadInboxCapabilities(args)).features).not.toContain(
		"roundtable_proactive_engage_v1",
	);
});

it("rejects an awaited engagement when the socket path has been replaced", async () => {
	let entered!: () => void;
	let resume!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const deferred = new Promise<void>((r) => {
		resume = r;
	});
	const write = vi.fn();
	const { args } = await setup(async (_receipt, assertCurrentOwner) => {
		entered();
		await deferred;
		assertCurrentOwner();
		write();
		return "ready";
	});
	const pending = expect(
		engageCodexLeadProactiveTopic({ ...args, ...receipt }),
	).rejects.toThrow(/owner/);
	await started;
	renameSync(args.socketPath, `${args.socketPath}.old`);
	writeFileSync(args.socketPath, "replacement");
	resume();
	await pending;
	expect(write).not.toHaveBeenCalled();
});

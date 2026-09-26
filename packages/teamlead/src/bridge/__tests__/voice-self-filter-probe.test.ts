import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexDiscordGateway } from "../../lead-backends/codex/CodexDiscordGateway.js";
import { CodexLeadInboxServer } from "../../lead-backends/codex/CodexLeadInboxSocket.js";
import * as filterContract from "../../voice-self-filter-contract.js";
import {
	observeVoiceSelfFilter,
	selfAuthorAllowed,
	signVoiceSelfFilterResponse,
} from "../../voice-self-filter-contract.js";
import { probeVoiceSelfFilterSocket } from "../voice-self-filter-probe.js";

const bot = "100000000000000005";
const secret = "fixture-token";
const leadId = "lead";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	vi.restoreAllMocks();
});
function socketPath() {
	const root = mkdtempSync(join(tmpdir(), "vprobe-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	return join(root, "v.sock");
}

it("evaluates actual guard behavior, including unknown identity and non-ready state", () => {
	expect(observeVoiceSelfFilter(bot, true)).toEqual({
		botUserId: bot,
		ready: true,
		selfDropped: true,
		unknownDropped: true,
		otherPassed: true,
	});
	expect(observeVoiceSelfFilter(bot, true, () => true).selfDropped).toBe(false);
	expect(observeVoiceSelfFilter(bot, true, () => false).otherPassed).toBe(
		false,
	);
	expect(selfAuthorAllowed(undefined, true, "other")).toBe(false);
	expect(selfAuthorAllowed(bot, false, "other")).toBe(false);
});

it("authenticates a live Codex gateway probe without mailbox or Discord side effects", async () => {
	const socket = socketPath();
	const submit = vi.fn();
	const submitBatch = vi.fn();
	let onMessage: ((msg: any) => boolean) | undefined;
	const gateway = new CodexDiscordGateway({
		botUserId: bot,
		channelIds: ["chat"],
		router: { submit },
		source: {
			assertAuthenticatedBotUser: async () => {},
			onMessage: (fn) => {
				onMessage = fn;
			},
			start: async () => {},
			stop: async () => {},
		},
	});
	const server = new CodexLeadInboxServer({
		socketPath: socket,
		leadId,
		authSecret: secret,
		router: { submitBatch },
		voiceSelfFilter: () => gateway.probeVoiceSelfFilter(),
	});
	await server.listen();
	cleanup.push(() => server.close());
	const args = {
		socketPath: socket,
		leadId,
		expectedBotUserId: bot,
		authSecret: secret,
		backend: "codex" as const,
	};
	await expect(probeVoiceSelfFilterSocket(args)).rejects.toThrow(/self_filter/);
	await gateway.start();
	cleanup.push(() => gateway.stop());
	const receipt = await probeVoiceSelfFilterSocket(args);
	expect(receipt).toMatchObject({
		version: 1,
		botUserId: bot,
		leadId,
		ready: true,
		selfDropped: true,
		unknownDropped: true,
		otherPassed: true,
	});
	expect(receipt.runtimeId).toMatch(/^[a-f0-9-]{36}$/);
	onMessage!({
		id: "mirror",
		authorId: bot,
		channelId: "chat",
		content: "🗣️ hello",
		authorBot: true,
	});
	expect(submit).not.toHaveBeenCalled();
	expect(submitBatch).not.toHaveBeenCalled();
	await expect(
		probeVoiceSelfFilterSocket({ ...args, authSecret: "wrong" }),
	).rejects.toThrow(/self_filter/);
	await gateway.stop();
	await expect(probeVoiceSelfFilterSocket(args)).rejects.toThrow(/self_filter/);
});

async function fakeServer(reply: (request: any) => unknown | undefined) {
	const socket = socketPath();
	const peers = new Set<import("node:net").Socket>();
	const server: Server = createServer({ allowHalfOpen: true }, (peer) => {
		peers.add(peer);
		peer.once("close", () => peers.delete(peer));
		let raw = "";
		peer.on("error", () => {});
		let answered = false;
		const respond = () => {
			if (answered) return;
			answered = true;
			const out = reply(JSON.parse(raw));
			if (out !== undefined)
				peer.end(typeof out === "string" ? out : JSON.stringify(out));
		};
		peer.on("data", (chunk) => {
			raw += chunk;
			if (raw.includes("\n")) respond();
		});
		peer.on("end", respond);
	});
	await new Promise<void>((done) => server.listen(socket, done));
	cleanup.push(
		() =>
			new Promise<void>((done) => {
				for (const peer of peers) peer.destroy();
				server.close(() => done());
			}),
	);
	return socket;
}
function response(req: any) {
	return signVoiceSelfFilterResponse(
		{
			version: 1,
			leadId,
			botUserId: bot,
			runtimeId: "12345678-1234-4123-8123-123456789012",
			nonce: req.nonce,
			ready: true,
			selfDropped: true,
			unknownDropped: true,
			otherPassed: true,
		},
		secret,
	);
}

it("accepts a Claude newline response without half-closing the request", async () => {
	const socket = socketPath();
	let endedBeforeReply = false;
	let receivedNewline = false;
	const peers = new Set<import("node:net").Socket>();
	const server = createServer({ allowHalfOpen: true }, (peer) => {
		peers.add(peer);
		peer.once("close", () => peers.delete(peer));
		let ended = false;
		let raw = "";
		peer.on("error", () => {});
		peer.once("end", () => {
			ended = true;
		});
		peer.on("data", (chunk) => {
			raw += chunk;
			if (!raw.includes("\n")) return;
			receivedNewline = true;
			endedBeforeReply = ended;
			peer.end(`${JSON.stringify(response(JSON.parse(raw)))}\n`);
		});
	});
	await new Promise<void>((done) => server.listen(socket, done));
	cleanup.push(
		() =>
			new Promise<void>((done) => {
				for (const peer of peers) peer.destroy();
				server.close(() => done());
			}),
	);

	const receipt = await probeVoiceSelfFilterSocket({
		socketPath: socket,
		leadId,
		expectedBotUserId: bot,
		authSecret: secret,
		backend: "claude",
	});

	expect(receivedNewline).toBe(true);
	expect(endedBeforeReply).toBe(false);
	expect(receipt.runtimeId).toBe("12345678-1234-4123-8123-123456789012");
});

it.each([
	"nonce",
	"botUserId",
	"leadId",
	"runtimeId",
	"version",
	"selfDropped",
	"unknownDropped",
	"otherPassed",
	"ready",
	"auth",
	"oversize",
])("rejects %s response tampering or failed guard", async (field) => {
	const socket = await fakeServer((req) => {
		const receipt: any = response(req);
		if (field === "oversize") return "x".repeat(4097);
		receipt[field] = [
			"ready",
			"selfDropped",
			"unknownDropped",
			"otherPassed",
		].includes(field)
			? false
			: field === "version"
				? 2
				: "wrong";
		return receipt;
	});
	await expect(
		probeVoiceSelfFilterSocket({
			socketPath: socket,
			leadId,
			expectedBotUserId: bot,
			authSecret: secret,
			backend: "claude",
		}),
	).rejects.toThrow(/self_filter/);
});
it("bounds a nonresponding socket and refuses an old server", async () => {
	const slow = await fakeServer(() => undefined);
	await expect(
		probeVoiceSelfFilterSocket({
			socketPath: slow,
			leadId,
			expectedBotUserId: bot,
			authSecret: secret,
			backend: "claude",
			timeoutMs: 30,
		}),
	).rejects.toThrow(/self_filter/);
	const old = await fakeServer(() => ({ ok: false, error: "unknown method" }));
	await expect(
		probeVoiceSelfFilterSocket({
			socketPath: old,
			leadId,
			expectedBotUserId: bot,
			authSecret: secret,
			backend: "codex",
		}),
	).rejects.toThrow(/self_filter/);
});

it("the live gateway probe detects a mutation of the same guard used for intake", async () => {
	const gateway = new CodexDiscordGateway({
		botUserId: bot,
		channelIds: ["chat"],
		router: { submit: vi.fn() },
		source: {
			assertAuthenticatedBotUser: async () => {},
			onMessage: () => {},
			start: async () => {},
			stop: async () => {},
		},
	});
	await gateway.start();
	cleanup.push(() => gateway.stop());
	expect(gateway.probeVoiceSelfFilter().selfDropped).toBe(true);
	vi.spyOn(filterContract, "selfAuthorAllowed").mockReturnValue(true);
	expect(gateway.probeVoiceSelfFilter()).toMatchObject({
		selfDropped: false,
		unknownDropped: false,
	});
});

it.each([
	"nonce",
	"botUserId",
	"leadId",
	"runtimeId",
	"version",
	"selfDropped",
	"unknownDropped",
	"otherPassed",
	"ready",
])("rejects a validly signed but invalid %s receipt", async (field) => {
	const socket = await fakeServer((req) => {
		const receipt: any = response(req);
		receipt[field] = [
			"ready",
			"selfDropped",
			"unknownDropped",
			"otherPassed",
		].includes(field)
			? false
			: field === "version"
				? 2
				: "wrong";
		return signVoiceSelfFilterResponse(receipt, secret);
	});
	await expect(
		probeVoiceSelfFilterSocket({
			socketPath: socket,
			leadId,
			expectedBotUserId: bot,
			authSecret: secret,
			backend: "claude",
		}),
	).rejects.toThrow(/self_filter/);
});

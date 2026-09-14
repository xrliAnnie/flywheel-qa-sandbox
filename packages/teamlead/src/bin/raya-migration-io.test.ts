import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureDiscordProbe,
	type MigrationIO,
	withRayaDeployLock,
} from "./raya-migration-io.js";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const channelId = "123456789012345678";
const botId = "223456789012345678";
const now = Date.parse("2026-09-13T00:00:00Z");
const snowflake = (ms: number) =>
	((BigInt(ms) - 1420070400000n) << 22n).toString();

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "raya-probe-"));
	roots.push(root);
	const file = join(root, "probe.json");
	const messages: Array<Record<string, unknown>> = [];
	let posts = 0;
	let loseResponse = false;
	const urls: string[] = [];
	const io: MigrationIO = {
		now: () => now,
		run: async () => {
			throw new Error("unexpected command");
		},
		fetch: async (url, init) => {
			urls.push(String(url));
			if (init?.method === "POST") {
				posts++;
				const intent = JSON.parse(readFileSync(file, "utf8"));
				expect(intent.nonce).toBeTruthy();
				expect(lstatSync(file).mode & 0o777).toBe(0o600);
				const message = {
					id: snowflake(now + 1),
					channel_id: channelId,
					author: { id: botId, bot: true },
					content: JSON.parse(String(init.body)).content,
				};
				messages.push(message);
				if (loseResponse) throw new Error("network error CANARY-TOKEN");
				return Response.json(message);
			}
			return Response.json(messages);
		},
	};
	return {
		input: {
			file,
			channelId,
			botId,
			token: "CANARY-TOKEN",
			prefix: "FLY-2445 cutover window probe",
			text: "Raya，请回复一句确认收到。",
			io,
		},
		messages,
		urls,
		posts: () => posts,
		lose: () => {
			loseResponse = true;
		},
	};
}

describe("durable Raya probes", () => {
	it("recovers a dead shared lock owner and releases the lock after a failed operation", async () => {
		const f = fixture();
		const raya = join(f.input.file, "..", "raya"),
			lock = join(raya, "deploy.lock.d");
		mkdirSync(lock, { recursive: true });
		writeFileSync(join(lock, "pid"), "2147483647\n", { mode: 0o600 });
		writeFileSync(join(lock, "start"), "dead-start\n", { mode: 0o600 });
		f.input.io.run = async () => "fixture-start";
		await expect(
			withRayaDeployLock(raya, f.input.io, async () => {
				throw new Error("work-failed");
			}),
		).rejects.toThrow("work-failed");
		expect(existsSync(lock)).toBe(false);
	});
	it("leaves a currently owned shared deploy lock untouched", async () => {
		const f = fixture();
		const raya = join(f.input.file, "..", "raya"),
			lock = join(raya, "deploy.lock.d");
		mkdirSync(lock, { recursive: true });
		writeFileSync(join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });
		writeFileSync(join(lock, "start"), "fixture-start\n", { mode: 0o600 });
		f.input.io.run = async () => "fixture-start";
		await expect(
			withRayaDeployLock(raya, f.input.io, async () => "unexpected"),
		).rejects.toThrow("deploy-lock-held");
		expect(readFileSync(join(lock, "start"), "utf8")).toBe("fixture-start\n");
	});
	it("persists a private nonce before POST and records the exact Discord message", async () => {
		const f = fixture();
		const result = await ensureDiscordProbe(f.input);
		expect(result.message_id).toBe(snowflake(now + 1));
		expect(f.posts()).toBe(1);
		expect(readFileSync(f.input.file, "utf8")).not.toContain("CANARY-TOKEN");
	});
	it("recovers a lost POST response by nonce without a second POST", async () => {
		const f = fixture();
		f.lose();
		await expect(ensureDiscordProbe(f.input)).rejects.toThrow(
			"probe-delivery-ambiguous",
		);
		const result = await ensureDiscordProbe(f.input);
		expect(result.message_id).toBe(snowflake(now + 1));
		expect(f.posts()).toBe(1);
		expect(f.urls.at(-1)).toContain(`after=${snowflake(now - 60_000)}`);
	});
	it("does not resend when recovery exhausts ten pages or loses read permission", async () => {
		const f = fixture();
		f.lose();
		await expect(ensureDiscordProbe(f.input)).rejects.toThrow();
		let pages = 0;
		f.input.io.fetch = async () =>
			Response.json(
				Array.from({ length: 100 }, (_, i) => ({
					id: snowflake(now + ++pages * 1000 + i),
					author: { id: botId, bot: true },
					content: "unrelated",
				})),
			);
		await expect(ensureDiscordProbe(f.input)).rejects.toThrow(
			"probe-delivery-ambiguous",
		);
		expect(pages).toBe(1000);
		f.input.io.fetch = async () =>
			new Response("forbidden CANARY-TOKEN", { status: 403 });
		await expect(ensureDiscordProbe(f.input)).rejects.toThrow(
			"probe-delivery-ambiguous",
		);
		expect(f.posts()).toBe(1);
	});
});

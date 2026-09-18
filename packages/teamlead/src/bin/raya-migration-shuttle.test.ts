import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discordSnowflake, type MigrationIO } from "./raya-migration-io.js";
import { runMigrationManifest } from "./raya-migration-manifest.js";
import {
	readChannelHistory,
	runShuttleStep,
} from "./raya-migration-shuttle.js";
import { seedLeadInboundCursor } from "./seed-lead-inbound-cursor.js";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const now = Date.parse("2026-09-13T00:00:00Z"),
	channel = "123456789012345678",
	bot = "223456789012345678";
function fixture(checkpoint = "P2") {
	const home = mkdtempSync(join(tmpdir(), "raya-shuttle-"));
	roots.push(home);
	const folder = join(home, ".flywheel/raya/migrations/FLY-2445-standard-lead"),
		file = join(folder, "manifest.json");
	mkdirSync(folder, { recursive: true });
	const state = join(home, "state");
	const ledger = {
		schemaVersion: 1,
		migration_id: "fixture",
		checkpoint,
		unresolved: [],
		window_probe: {
			bot_token_env: "PROBE_TOKEN",
			bot_user_id: bot,
			channel_id: channel,
		},
		legacy_owner: [
			{ stop_started_at_ms: now - 20, stopped_at_ms: now - 10 },
			{ stop_started_at_ms: now - 10, stopped_at_ms: now - 5 },
		],
		cursor: {
			path: join(state, "inbound-cursor.json"),
			seed_input: join(folder, "seed-input.json"),
		},
	};
	writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
	writeFileSync(join(home, ".flywheel/.env"), "PROBE_TOKEN=CANARY\n", {
		mode: 0o600,
	});
	let posts = 0,
		active = false,
		forbidden = false;
	const messages: Array<Record<string, unknown>> = [
		{
			id: discordSnowflake(now - 16 * 60_000),
			channel_id: channel,
			author: { id: bot, bot: true },
			content: "old bot",
		},
	];
	const io: MigrationIO = {
		now: () => now,
		run: async (_file, args) =>
			args.includes("--print-state-dir") ? state : "fixture-start",
		fetch: async (url, init) => {
			if (String(url).endsWith("/users/@me"))
				return Response.json({ id: bot, bot: true });
			if (forbidden) return new Response(null, { status: 403 });
			if (init?.method === "POST") {
				posts++;
				const message = {
					id: discordSnowflake(now + posts),
					channel_id: channel,
					author: { id: bot, bot: true },
					content: JSON.parse(String(init.body)).content,
				};
				messages.push(message);
				return Response.json(message);
			}
			const before = new URL(String(url)).searchParams.get("before");
			const specific = String(url).match(/\/messages\/([0-9]+)$/);
			if (specific)
				return Response.json(messages.find((m) => m.id === specific[1]));
			const list = active
				? [
						...messages,
						{
							id: discordSnowflake(now - 7),
							author: { id: channel, bot: false },
							content: "human",
						},
					]
				: messages;
			return Response.json(
				list.filter((m) => !before || BigInt(String(m.id)) < BigInt(before)),
			);
		},
	};
	return {
		home,
		file,
		ledger,
		state,
		io,
		messages,
		posts: () => posts,
		active: () => {
			active = true;
		},
		forbid: () => {
			forbidden = true;
		},
		run: (step: string) =>
			runShuttleStep({ home, flywheelDir: home, io, step }),
	};
}
describe("Raya shuttle I/O steps", () => {
	it("accepts the shuttle parent's regular shell lock metadata without taking or releasing its lock", async () => {
		const f = fixture(),
			lock = join(f.home, ".flywheel/raya/deploy.lock.d");
		mkdirSync(lock);
		writeFileSync(join(lock, "pid"), String(process.ppid), { mode: 0o644 });
		writeFileSync(join(lock, "start"), "fixture-start", { mode: 0o644 });
		expect(
			await runMigrationManifest(
				["quiet-check", "--lock-owner", String(process.ppid)],
				{ home: f.home, flywheelDir: f.home, io: f.io },
			),
		).toMatchObject({ status: "quiet" });
		expect(existsSync(lock)).toBe(true);
		await expect(
			runShuttleStep({
				home: f.home,
				flywheelDir: f.home,
				io: f.io,
				step: "quiet-check",
				lockOwner: process.pid,
			}),
		).rejects.toThrow("deploy-lock-owner-invalid");
	});
	it("rechecks the quiet window and refuses active or unreadable channels", async () => {
		const f = fixture();
		expect(await f.run("quiet-check")).toMatchObject({ status: "quiet" });
		f.active();
		await expect(f.run("quiet-check")).rejects.toThrow("channel-active");
		f.forbid();
		await expect(f.run("quiet-check")).rejects.toThrow();
		expect(f.posts()).toBe(0);
	});
	it("reads beyond 50 messages and caps an unproven lookback at 500", async () => {
		const f = fixture();
		const human = {
			id: discordSnowflake(now - 1000),
			author: { id: channel, bot: false },
			content: "human",
		};
		f.messages.push(
			human,
			...Array.from({ length: 50 }, (_, n) => ({
				id: discordSnowflake(now - n),
				author: { id: bot, bot: true },
				content: "bot",
			})),
		);
		await expect(f.run("quiet-check")).rejects.toThrow("channel-active");
		let calls = 0;
		f.io.fetch = async () =>
			Response.json(
				Array.from({ length: 100 }, (_, n) => ({
					id: discordSnowflake(now - calls * 100 - n),
					author: { id: bot, bot: true },
					content: "bot",
				})).map((m, n) => {
					if (n === 99) calls++;
					return m;
				}),
			);
		const result = await readChannelHistory(
			f.io,
			"fixture",
			channel,
			now - 900_000,
		);
		expect(result.complete).toBe(false);
		expect(result.messages).toHaveLength(500);
		expect(calls).toBe(5);
	});
	it("persists the prestop probe and reuses the same completed intent after a crash", async () => {
		const f = fixture();
		await f.run("prestop-probe");
		await f.run("prestop-probe");
		expect(f.posts()).toBe(1);
		expect(
			JSON.parse(readFileSync(f.file, "utf8")).prestop_probe.message_id,
		).toBeTruthy();
	});
	it("creates a real seed only after a cutover probe and a complete empty human window", async () => {
		const f = fixture("P3");
		await f.run("cutover-probe");
		await f.run("cutover-probe");
		await f.run("seed-boundary");
		expect(f.posts()).toBe(1);
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		const seed = JSON.parse(readFileSync(ledger.cursor.seed_input, "utf8"));
		expect(
			seedLeadInboundCursor({ path: ledger.cursor.path, seed }).status,
		).toBe("seeded");
		expect(ledger.baseline.kind).toBe("quiet15m");
		expect(ledger.unresolved).toEqual([]);
		expect(BigInt(ledger.cutover_probe.boundary_message_id)).toBeLessThan(
			BigInt(ledger.cutover_probe.message_id),
		);
	});
	it("marks a preexisting live cursor boundary without claiming its writer stopped", async () => {
		const f = fixture("P3");
		f.ledger.cursor.status = "preexisting";
		writeFileSync(f.file, JSON.stringify(f.ledger), { mode: 0o600 });
		await f.run("cutover-probe");
		await f.run("seed-boundary");
		const seed = JSON.parse(
			readFileSync(
				JSON.parse(readFileSync(f.file, "utf8")).cursor.seed_input,
				"utf8",
			),
		);
		expect(seed.writerStopped).toBe(false);
	});
	it("reissues a preexisting window probe after P4b activation and reuses its durable receipt", async () => {
		const f = fixture("P3");
		f.ledger.cursor.status = "preexisting";
		writeFileSync(f.file, JSON.stringify(f.ledger), { mode: 0o600 });
		await f.run("cutover-probe");
		await f.run("seed-boundary");
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		const seedProbe = ledger.cutover_probe;
		ledger.checkpoint = "P4b";
		ledger.lead_restart_installed_at = "2026-09-13T00:00:00.001Z";
		ledger.activated_at = "2026-09-13T00:00:00.002Z";
		ledger.seed_probe = seedProbe;
		ledger.probe_resets = [{ nonce: seedProbe.intent.nonce }];
		delete ledger.cutover_probe;
		writeFileSync(f.file, JSON.stringify(ledger), { mode: 0o600 });

		await f.run("cutover-probe");
		await f.run("cutover-probe");

		const after = JSON.parse(readFileSync(f.file, "utf8"));
		expect(f.posts()).toBe(2);
		expect(after.seed_probe.message_id).toBe(seedProbe.message_id);
		expect(BigInt(after.cutover_probe.message_id)).toBeGreaterThan(
			BigInt(seedProbe.message_id),
		);
		expect(Date.parse(after.cutover_probe.sent_at)).toBeGreaterThanOrEqual(
			Date.parse(ledger.activated_at),
		);
	});
	it("leaves stop-window input unresolved and never writes a seed", async () => {
		const f = fixture("P3");
		f.active();
		await f.run("cutover-probe");
		await expect(f.run("seed-boundary")).rejects.toThrow("cutover-unresolved");
		expect(JSON.parse(readFileSync(f.file, "utf8")).unresolved).toContainEqual({
			message_id: discordSnowflake(now - 7),
			reason: "stop-window",
		});
		expect(existsSync(join(dirname(f.file), "seed-input.json"))).toBe(false);
	});
});

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationIO } from "./raya-migration-io.js";
import { runMigrationManifest } from "./raya-migration-manifest.js";

const roots: string[] = [];
afterEach(() =>
	roots
		.splice(0)
		.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const first = "123456789012345678",
	second = "223456789012345678";
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "raya-resolve-"));
	roots.push(home);
	const file = join(
		home,
		".flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json",
	);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 1,
			migration_id: "test",
			checkpoint: "P3",
			unresolved: [
				{ message_id: first, reason: "stop-window" },
				{ message_id: second, reason: "stop-window" },
			],
		}),
		{ mode: 0o600 },
	);
	const io: MigrationIO = {
		now: () => Date.parse("2026-09-13T00:00:00Z"),
		run: async () => "fixture-start",
		fetch: async () => {
			throw new Error("unexpected network");
		},
	};
	const run = (id: string, as: string, action = "resolve") =>
		runMigrationManifest(
			[
				action,
				"--message-id",
				id,
				"--as",
				as,
				"--evidence",
				"Lead manually reconciled side effects",
			],
			{ home, flywheelDir: home, io },
		);
	return { file, run, home, io };
}

describe("migration resolution CLI", () => {
	it("records explicit lookback evidence while retaining every quiet-window violation", async () => {
		const f = fixture();
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		ledger.unresolved = [
			{ reason: "lookback_exhausted" },
			{ reason: "quiet-window-violated", message_id: second },
		];
		ledger.window_probe = {
			bot_token_env: "PROBE_TOKEN",
			bot_user_id: first,
			channel_id: second,
		};
		ledger.cutover_probe = { message_id: "923456789012345678" };
		writeFileSync(f.file, JSON.stringify(ledger));
		writeFileSync(join(f.home, ".flywheel/.env"), "PROBE_TOKEN=CANARY\n", {
			mode: 0o600,
		});
		f.io.fetch = async (url) =>
			String(url).endsWith("/users/@me")
				? Response.json({ id: first, bot: true })
				: Response.json({
						id: first,
						channel_id: second,
						author: { id: first, bot: true },
						content: "boundary",
					});
		await runMigrationManifest(
			[
				"resolve",
				"--as",
				"lookback_confirmed",
				"--boundary-message-id",
				first,
				"--evidence",
				"Lead checked the missing history",
			],
			{ home: f.home, flywheelDir: f.home, io: f.io },
		);
		const after = JSON.parse(readFileSync(f.file, "utf8"));
		expect(after.unresolved).toEqual([
			{ reason: "quiet-window-violated", message_id: second },
		]);
		expect(after.lookback_resolution.boundary_message_id).toBe(first);
		expect(after.resolutions[0].by).toBe("flywheel-eng-lead");
	});
	it("records explicit probe-not-delivered authority without deleting the durable nonce", async () => {
		const f = fixture();
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		ledger.unresolved = [{ reason: "probe_delivery_ambiguous" }];
		writeFileSync(f.file, JSON.stringify(ledger));
		const intentFile = join(dirname(f.file), "cutover-probe.intent");
		const intent = {
			nonce: "11111111-2222-3333-4444-555555555555",
			at: "2026-09-13T00:00:00Z",
		};
		writeFileSync(intentFile, JSON.stringify(intent), { mode: 0o600 });
		await runMigrationManifest(
			[
				"resolve",
				"--as",
				"probe_not_delivered",
				"--evidence",
				"Lead verified POST never ran",
			],
			{ home: f.home, flywheelDir: f.home, io: f.io },
		);
		expect(JSON.parse(readFileSync(intentFile, "utf8"))).toEqual(intent);
		const after = JSON.parse(readFileSync(f.file, "utf8"));
		expect(after.probe_resets[0]).toMatchObject({
			nonce: intent.nonce,
			by: "flywheel-eng-lead",
		});
		expect(after.unresolved).toEqual([]);
	});
	it("permits explicit recovery of an ambiguous post-activation preexisting probe", async () => {
		const f = fixture();
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		ledger.checkpoint = "P4b";
		ledger.cursor = { status: "preexisting" };
		ledger.lead_restart_installed_at = "2026-09-12T23:59:59Z";
		ledger.activated_at = "2026-09-13T00:00:00Z";
		ledger.seed_probe = {
			intent: { nonce: "seed-nonce" },
			message_id: first,
		};
		ledger.probe_resets = [{ nonce: "seed-nonce" }];
		ledger.unresolved = [{ reason: "probe_delivery_ambiguous" }];
		writeFileSync(f.file, JSON.stringify(ledger));
		const intentFile = join(dirname(f.file), "cutover-probe.intent");
		const intent = {
			nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			at: "2026-09-13T00:00:01Z",
		};
		writeFileSync(intentFile, JSON.stringify(intent), { mode: 0o600 });

		await runMigrationManifest(
			[
				"resolve",
				"--as",
				"probe_not_delivered",
				"--evidence",
				"Lead verified the post-activation POST never ran",
			],
			{ home: f.home, flywheelDir: f.home, io: f.io },
		);

		const after = JSON.parse(readFileSync(f.file, "utf8"));
		expect(after.probe_resets.at(-1)).toMatchObject({
			nonce: intent.nonce,
			by: "flywheel-eng-lead",
		});
		expect(after.unresolved).toEqual([]);
	});
	it("accepts a manually located probe only when REST proves its exact nonce and bot", async () => {
		const f = fixture();
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		ledger.unresolved = [{ reason: "probe_delivery_ambiguous" }];
		ledger.window_probe = {
			bot_token_env: "PROBE_TOKEN",
			bot_user_id: first,
			channel_id: second,
		};
		writeFileSync(f.file, JSON.stringify(ledger));
		writeFileSync(join(f.home, ".flywheel/.env"), "PROBE_TOKEN=CANARY\n", {
			mode: 0o600,
		});
		const intent = {
			nonce: "11111111-2222-3333-4444-555555555555",
			at: "2026-09-13T00:00:00Z",
			prefix: "FLY-2445 cutover window probe",
			text: "Raya，请回复一句确认收到。",
		};
		writeFileSync(
			join(dirname(f.file), "cutover-probe.intent"),
			JSON.stringify(intent),
			{ mode: 0o600 },
		);
		let author = second;
		f.io.fetch = async (url) =>
			String(url).endsWith("/users/@me")
				? Response.json({ id: first, bot: true })
				: Response.json({
						id: second,
						channel_id: second,
						author: { id: author, bot: true },
						content: `[${intent.prefix} ${intent.nonce}] ${intent.text}`,
					});
		const argv = [
			"resolve",
			"--as",
			"probe_message-id",
			second,
			"--evidence",
			"Lead found exact probe",
		];
		await expect(
			runMigrationManifest(argv, {
				home: f.home,
				flywheelDir: f.home,
				io: f.io,
			}),
		).rejects.toThrow();
		author = first;
		await runMigrationManifest(argv, {
			home: f.home,
			flywheelDir: f.home,
			io: f.io,
		});
		expect(
			JSON.parse(readFileSync(f.file, "utf8")).cutover_probe.message_id,
		).toBe(second);
	});
	it("requires a separate signed Lead ruling for a quiet-window violation", async () => {
		const f = fixture();
		const ledger = JSON.parse(readFileSync(f.file, "utf8"));
		ledger.unresolved[0].reason = "quiet-window-violated";
		writeFileSync(f.file, JSON.stringify(ledger));
		await expect(f.run(first, "confirmed_processed")).rejects.toThrow();
		await f.run(first, "confirmed_unprocessed", "resolve-quiet-window");
		const after = JSON.parse(readFileSync(f.file, "utf8"));
		expect(after.resolutions[0]).toMatchObject({
			target: first,
			as: "confirmed_unprocessed",
			reason: "quiet-window-violated",
			by: "flywheel-eng-lead",
		});
		await expect(f.run(second, "confirmed_processed")).rejects.toThrow(
			/non-contiguous/,
		);
	});
	it("appends immutable evidence and permits only a processed prefix followed by an unprocessed suffix", async () => {
		const f = fixture();
		await f.run(first, "confirmed_processed");
		const prefix = JSON.parse(readFileSync(f.file, "utf8")).resolutions;
		await f.run(second, "confirmed_unprocessed");
		const final = JSON.parse(readFileSync(f.file, "utf8"));
		expect(final.unresolved).toEqual([]);
		expect(final.resolutions.slice(0, 1)).toEqual(prefix);
		expect(final.resolutions).toHaveLength(2);
		expect(final.resolutions[0]).toMatchObject({
			target: first,
			as: "confirmed_processed",
			by: "flywheel-eng-lead",
		});
	});
	it("rejects processed-after-unprocessed without changing either ledger or history", async () => {
		const f = fixture();
		await f.run(first, "confirmed_unprocessed");
		const before = readFileSync(f.file, "utf8");
		await expect(f.run(second, "confirmed_processed")).rejects.toThrow(
			/non-contiguous/,
		);
		expect(readFileSync(f.file, "utf8")).toBe(before);
	});
	it("does not rewrite a resolution or accept an unknown message", async () => {
		const f = fixture();
		await f.run(first, "confirmed_processed");
		const before = readFileSync(f.file, "utf8");
		await expect(f.run(first, "confirmed_unprocessed")).rejects.toThrow();
		await expect(
			f.run("323456789012345678", "confirmed_processed"),
		).rejects.toThrow();
		expect(readFileSync(f.file, "utf8")).toBe(before);
	});
});

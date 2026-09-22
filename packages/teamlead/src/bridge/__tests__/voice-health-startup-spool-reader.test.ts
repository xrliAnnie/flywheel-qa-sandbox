import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireProcessLifetimeFileLock } from "../../process-lock.js";
import {
	createVoiceHealthBridgeGuard,
	createVoiceHealthStartupSpoolReader,
} from "../voice-health-projector.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "voice-startup-reader-"));
	roots.push(home);
	const spool = join(home, ".flywheel", "voice-startup-spool");
	mkdirSync(spool, { recursive: true, mode: 0o700 });
	chmodSync(spool, 0o700);
	return { home, spool };
}

it("reads every private writer document repeatedly without consuming another reader's evidence", async () => {
	const { home, spool } = fixture();
	const attemptIds = [
		"10000000-0000-4000-8000-000000000001",
		"20000000-0000-4000-8000-000000000002",
	];
	for (const [index, startupAttemptId] of attemptIds.entries()) {
		const path = join(spool, `${String(index + 1).padStart(64, "0")}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				schemaVersion: 1,
				startupAttemptId,
				observedAt: `2026-09-18T20:00:0${index}.000Z`,
				reasonClass: "startup_config_invalid",
				operation: "startup",
			}),
			{ mode: 0o600 },
		);
		chmodSync(path, 0o600);
	}
	const read = createVoiceHealthStartupSpoolReader({ homeDir: home });

	const first = await read();
	const second = await read();
	expect(first).toEqual(second);
	expect(first.map((event) => event.startupAttemptId)).toEqual(attemptIds);
	for (let index = 0; index < attemptIds.length; index += 1)
		expect(
			existsSync(join(spool, `${String(index + 1).padStart(64, "0")}.json`)),
		).toBe(true);
});

it("fails closed on a symlink or over-permissive matching document", async () => {
	const { home, spool } = fixture();
	const outside = join(home, "outside.json");
	writeFileSync(outside, "{}", { mode: 0o600 });
	symlinkSync(outside, join(spool, `${"a".repeat(64)}.json`));
	await expect(
		createVoiceHealthStartupSpoolReader({ homeDir: home })(),
	).rejects.toThrow("startup_spool_unavailable");

	rmSync(join(spool, `${"a".repeat(64)}.json`));
	const permissive = join(spool, `${"b".repeat(64)}.json`);
	writeFileSync(permissive, "{}", { mode: 0o644 });
	chmodSync(permissive, 0o644);
	await expect(
		createVoiceHealthStartupSpoolReader({ homeDir: home })(),
	).rejects.toThrow("startup_spool_unavailable");
});

it.each([
	"serial",
	"concurrent",
	"helper_retry",
	"dead_claim",
	"unsafe_archive",
	"unsafe_lock",
])("archives evidence safely: %s", async (mode) => {
	const { home, spool } = fixture();
	const events = [
		{
			startupAttemptId: "10000000-0000-4000-8000-000000000001",
			observedAt: "2026-09-18T19:59:59.000Z",
			reasonClass: "startup_config_invalid",
		},
		{
			startupAttemptId: "20000000-0000-4000-8000-000000000002",
			observedAt: "2026-09-18T20:00:01.000Z",
			reasonClass: "startup_config_invalid",
		},
		{
			startupAttemptId: "30000000-0000-4000-8000-000000000003",
			observedAt: "2026-09-18T20:00:02.000Z",
			reasonClass: "startup_lock_unavailable",
		},
	] as const;
	for (const [index, event] of events.entries()) {
		const path = join(spool, `${String(index + 1).padStart(64, "0")}.json`);
		writeFileSync(
			path,
			JSON.stringify({ schemaVersion: 1, ...event, operation: "startup" }),
			{ mode: 0o600 },
		);
		chmodSync(path, 0o600);
	}
	const invocations: Array<{
		command: string;
		payload: Record<string, unknown>;
	}> = [];
	let failOnce = mode === "helper_retry";
	const execFile = vi.fn(
		(
			_file: string,
			args: string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			const child = new EventEmitter() as ChildProcess;
			child.stdin = new EventEmitter() as ChildProcess["stdin"];
			Object.assign(child.stdin!, {
				once: child.stdin!.once.bind(child.stdin),
				end: (encoded: string) => {
					const command = args.at(-1)!;
					invocations.push({ command, payload: JSON.parse(encoded) });
					if (command === "record-startup" && failOnce) {
						failOnce = false;
						callback(new Error("fixture helper failure"), "", "");
						return;
					}
					setTimeout(() => callback(null, '{"status":"recorded"}', ""), 15);
				},
			});
			return child;
		},
	);
	const createGuard = () =>
		createVoiceHealthBridgeGuard({
			store: {
				listVoiceSessions: () =>
					[
						{
							sessionId: "40000000-0000-4000-8000-000000000004",
							meetingId: "meeting-1",
							createdAt: "2026-09-18T20:00:00.000Z",
						},
					] as never,
			},
			helperPath: "/trusted/voice-health.py",
			stateRoot: join(home, ".flywheel"),
			execFile,
			now: () => new Date("2026-09-18T20:00:03.000Z"),
			readStartupEvents: createVoiceHealthStartupSpoolReader({ homeDir: home }),
		});
	const guard = createGuard();
	const currentProjection = {
		demandState: "required",
		sourceStatus: "available",
		demandIdentities: [
			{
				demandId: "meeting-1",
				attemptId: "40000000-0000-4000-8000-000000000004",
				projectId: "flywheel",
			},
		],
	};

	if (mode === "unsafe_archive" || mode === "unsafe_lock") {
		const outside = join(home, "outside");
		if (mode === "unsafe_archive") mkdirSync(outside, { mode: 0o700 });
		else writeFileSync(outside, "", { mode: 0o600 });
		symlinkSync(
			outside,
			join(spool, mode === "unsafe_archive" ? "consumed" : ".consumer.lock"),
		);
		await expect(guard({ currentProjection } as never)).rejects.toThrow();
		expect(
			invocations.filter(({ command }) => command === "record-startup"),
		).toEqual([]);
		expect(
			readdirSync(spool).filter((name) => name.endsWith(".json")),
		).toHaveLength(3);
		return;
	}
	if (mode === "dead_claim") {
		const claim = await acquireProcessLifetimeFileLock(
			join(spool, ".consumer.lock"),
		);
		expect(claim.status).toBe("acquired");
		if (claim.status !== "acquired") throw new Error("fixture claim failed");
		process.kill(claim.handle.helperPid!, "SIGKILL");
		await claim.handle.close();
	}
	if (mode === "helper_retry") {
		await expect(guard({ currentProjection } as never)).rejects.toThrow(
			"health_store_unavailable",
		);
		expect(existsSync(join(spool, `${"2".padStart(64, "0")}.json`))).toBe(true);
		invocations.length = 0;
	}
	if (mode === "concurrent") {
		await Promise.all([
			guard({ currentProjection } as never),
			createGuard()({ currentProjection } as never),
		]);
	} else {
		await guard({ currentProjection } as never);
	}
	await guard({ currentProjection } as never);
	expect(
		invocations.filter(({ command }) => command === "record-startup"),
	).toEqual([
		{
			command: "record-startup",
			payload: {
				startupAttemptId: "20000000-0000-4000-8000-000000000002",
				observedAt: "2026-09-18T20:00:01.000Z",
				reasonClass: "startup_config_invalid",
				operation: "startup",
				demandId: "meeting-1",
			},
		},
	]);
	expect(existsSync(spool)).toBe(true);
	expect(readdirSync(spool).filter((name) => name.endsWith(".json"))).toEqual(
		[],
	);
	const archived = readdirSync(join(spool, "consumed")).sort();
	expect(archived).toHaveLength(3);
	expect(
		JSON.parse(readFileSync(join(spool, "consumed", archived[1]), "utf8")),
	).toMatchObject(events[1]);
});

it("fails closed on active file-count, document-size, and aggregate-byte bounds", async () => {
	for (const [count, bytes, expected] of [
		[129, 1, "startup_spool_overflow"],
		[1, 32769, "startup_spool_unavailable"],
		[34, 32768, "startup_spool_overflow"],
	] as const) {
		const { home, spool } = fixture();
		for (let index = 0; index < count; index += 1) {
			const encoded = JSON.stringify({
				schemaVersion: 1,
				startupAttemptId: "10000000-0000-4000-8000-000000000001",
				observedAt: "2026-09-18T20:00:00.000Z",
				reasonClass: "startup_config_invalid",
				operation: "startup",
			});
			writeFileSync(
				join(spool, `${index.toString(16).padStart(64, "0")}.json`),
				encoded.padEnd(Math.max(bytes, encoded.length), " "),
				{ mode: 0o600 },
			);
		}
		await expect(
			createVoiceHealthStartupSpoolReader({ homeDir: home })(),
		).rejects.toThrow(expected);
	}
});

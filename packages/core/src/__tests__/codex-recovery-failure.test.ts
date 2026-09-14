import { describe, expect, it } from "vitest";
import {
	CodexRecoveryError,
	createCodexRecoveryFailure,
	isReadinessFailure,
	MAX_CHARGED_ATTEMPTS,
	MAX_READINESS_FAILURES,
	normalizeCodexRecoveryFailure,
	parseCodexRecoveryFailure,
	READINESS_RETRY_DELAY_MS,
	READINESS_WINDOW_MS,
	RECOVERY_PRECOMMIT_OBSERVATION_MS,
	withRecoveryCleanup,
} from "../codex-recovery-failure.js";

describe("recovery diagnostic contract", () => {
	it("grants readiness only from an exact source and confirmed drain", () => {
		const socket = createCodexRecoveryFailure({
			code: "daemon_socket_not_ready",
			stage: "daemon_spawn",
		});
		expect(isReadinessFailure(socket)).toBe(false);
		expect(
			isReadinessFailure(withRecoveryCleanup(socket, "confirmed_absent")),
		).toBe(true);
		for (const systemCode of [
			undefined,
			"ENOENT",
			"ECONNREFUSED",
			"EACCES",
			"EPERM",
		] as const) {
			const f = createCodexRecoveryFailure({
				code: "daemon_connect_not_ready",
				stage: "socket_connect",
				systemCode,
				cleanup: "confirmed_absent",
			});
			expect(isReadinessFailure(f)).toBe(
				systemCode === "ENOENT" || systemCode === "ECONNREFUSED",
			);
		}
		expect(
			isReadinessFailure(
				createCodexRecoveryFailure({
					code: "daemon_start_failed",
					stage: "daemon_spawn",
					systemCode: "ENOENT",
					cleanup: "confirmed_absent",
				}),
			),
		).toBe(false);
		expect(
			isReadinessFailure({
				...socket,
				stage: "unknown",
				cleanup: "confirmed_absent",
			}),
		).toBe(false);
	});
	it("preserves the primary cause through cleanup errors and typed throws", () => {
		const primary = createCodexRecoveryFailure({
			code: "launch_snapshot_mismatch",
			stage: "context",
			mismatchFields: ["cwd", "model"],
		});
		const f = withRecoveryCleanup(primary, "unconfirmed");
		expect(f).toMatchObject({
			code: primary.code,
			stage: primary.stage,
			secondaryCode: "cleanup_unconfirmed",
			cleanup: "unconfirmed",
			mismatchFields: ["cwd", "model"],
		});
		const err = new CodexRecoveryError(f, { cause: new Error("private") });
		expect(normalizeCodexRecoveryFailure(err)).toEqual(f);
		expect(err.message).toBe(f.summary);
	});
	it("strictly rejects malformed persisted contracts", () => {
		const valid = createCodexRecoveryFailure({
			code: "owner_failed_unknown",
			stage: "unknown",
		});
		for (const bad of [
			null,
			[],
			"x",
			{ ...valid, version: 2 },
			{ ...valid, code: "ENOENT" },
			{ ...valid, stage: "spawn" },
			{ ...valid, cleanup: "yes" },
			{ ...valid, summary: "" },
			{ ...valid, summary: "x".repeat(501) },
			{ ...valid, systemCode: "ETIMEDOUT" },
			{ ...valid, mismatchFields: ["secret"] },
			{ ...valid, mismatchFields: Array(9).fill("cwd") },
			{ ...valid, secondaryCode: "unknown" },
			{ ...valid, credential: "secret" },
		]) {
			expect(parseCodexRecoveryFailure(bad)).toBeUndefined();
			expect(isReadinessFailure(bad)).toBe(false);
		}
		expect(
			parseCodexRecoveryFailure({ ...valid, summary: "😀".repeat(500) }),
		).toBeDefined();
	});
	it("uses fixed typed summaries and strips private legacy text", () => {
		const typed = createCodexRecoveryFailure({
			code: "permission_denied",
			stage: "preflight",
		});
		expect(
			normalizeCodexRecoveryFailure({
				...typed,
				summary: "password=secret /Users/private/file",
			}),
		).toEqual(typed);
		const f = normalizeCodexRecoveryFailure(undefined, {
			failureReason:
				"\u001b[31mfailed password=secret Bearer abc.def.ghi /Users/private/file https://user:password@example.com <@123>\u0000",
		});
		expect(f.code).toBe("owner_failed_unknown");
		for (const secret of [
			"secret",
			"abc.def.ghi",
			"/Users/private",
			"user:password",
			"<@123>",
			"\u001b",
			"\u0000",
		])
			expect(f.summary).not.toContain(secret);
		expect(f.summary.length).toBeGreaterThan(0);
		expect(
			normalizeCodexRecoveryFailure({ arbitrary: "private" }).summary,
		).not.toContain("private");
		expect(
			normalizeCodexRecoveryFailure(undefined, {
				failureReason: "  ",
				resultText: "socket not ready",
			}).code,
		).toBe("owner_failed_unknown");
		expect(
			normalizeCodexRecoveryFailure(new Error("private unrecognized text")),
		).toMatchObject({ code: "owner_failed_unknown", cleanup: "not_started" });
	});
	it("preserves sanitized legacy diagnostics through persistence", () => {
		const f = normalizeCodexRecoveryFailure(undefined, {
			failureReason: "owner failed connecting socket",
		});
		expect(f.summary).toBe("owner failed connecting socket");
		expect(parseCodexRecoveryFailure(JSON.parse(JSON.stringify(f)))).toEqual(f);
		expect(
			parseCodexRecoveryFailure({ ...f, code: "toString" }),
		).toBeUndefined();
		expect(
			parseCodexRecoveryFailure({ ...f, summary: "error password=topsecret" })
				?.summary,
		).not.toContain("topsecret");
	});
	it("pins independent policy bounds", () => {
		expect([
			MAX_CHARGED_ATTEMPTS,
			MAX_READINESS_FAILURES,
			READINESS_WINDOW_MS,
			READINESS_RETRY_DELAY_MS,
			RECOVERY_PRECOMMIT_OBSERVATION_MS,
		]).toEqual([2, 3, 900000, 30000, 300000]);
	});
});

describe("recovery failure budget admission", () => {
	it("refunds only a validated readiness source with confirmed cleanup", () => {
		const socket = {
			version: 1,
			code: "daemon_socket_not_ready",
			stage: "daemon_spawn",
			summary: "Socket unavailable",
			cleanup: "confirmed_absent",
		};
		expect(isReadinessFailure(socket)).toBe(true);
		for (const patch of [
			{ cleanup: "unconfirmed" },
			{ stage: "unknown" },
			{ version: 2 },
			{ summary: " " },
			{ summary: "x".repeat(501) },
			{ code: "daemon_start_failed" },
		]) {
			expect(isReadinessFailure({ ...socket, ...patch })).toBe(false);
		}
		const connect = {
			...socket,
			code: "daemon_connect_not_ready",
			stage: "socket_connect",
		};
		expect(isReadinessFailure(connect)).toBe(false);
		for (const systemCode of ["ENOENT", "ECONNREFUSED"])
			expect(isReadinessFailure({ ...connect, systemCode })).toBe(true);
		expect(isReadinessFailure({ ...connect, systemCode: "EACCES" })).toBe(
			false,
		);
	});
	it("keeps missing, malformed and free text diagnostics charged and nonempty", () => {
		for (const value of [
			undefined,
			null,
			"daemon_socket_not_ready",
			{},
			{ version: 1, code: "invented" },
		]) {
			const failure = normalizeCodexRecoveryFailure(value);
			expect(failure.code).toBe("owner_failed_unknown");
			expect(failure.summary.trim()).not.toBe("");
			expect(isReadinessFailure(failure)).toBe(false);
		}
	});
	it("never publishes raw secrets, paths, controls or arbitrary object fields", () => {
		const summary =
			"\u001b[31mBearer secret-token /Users/private/key @everyone https://user:pass@example.com token=abc";
		const failure = normalizeCodexRecoveryFailure({
			version: 1,
			code: "daemon_start_failed",
			stage: "daemon_spawn",
			cleanup: "unconfirmed",
			summary,
			prompt: "private",
		});
		expect(JSON.stringify(failure)).not.toMatch(
			/secret-token|Users|@everyone|user:pass|abc|private|\\u001b/,
		);
		expect(failure.summary.length).toBeGreaterThan(0);
	});
});

it("retains safe untyped operational errors with only a stage fallback", () => {
	for (const input of [
		new Error("codex home lease busy"),
		"codex home lease busy",
	]) {
		const failure = normalizeCodexRecoveryFailure(input, {
			stage: "preflight",
		});
		expect(failure).toMatchObject({
			code: "owner_failed_unknown",
			stage: "preflight",
			summary: "codex home lease busy",
		});
		expect(isReadinessFailure(failure)).toBe(false);
	}
	const safe = normalizeCodexRecoveryFailure(
		new Error("socket error /private/key token=secret-value"),
	);
	expect(safe.summary).toContain("socket error");
	expect(safe.summary).not.toMatch(/private|secret-value/);
	expect(
		normalizeCodexRecoveryFailure(new Error("socket error"), {
			failureReason: "daemon failed",
		}).summary,
	).toBe("daemon failed");
});

it.each([
	[
		"immutable launch snapshot for 3835df15-1b2c-4d5e-8f90-aabbccddeeff lacks rehydration context",
		"immutable launch snapshot for [id] lacks rehydration context",
	],
	["keyed_home_reown_path_mismatch", "keyed_home_reown_path_mismatch"],
	[
		"keyed_home_reown_unresolved: home_missing",
		"keyed_home_reown_unresolved: home_missing",
	],
])(
	"preserves operational diagnosis %s without exposing identifiers",
	(message, summary) => {
		const failure = normalizeCodexRecoveryFailure(new Error(message));
		expect(failure.summary).toBe(summary);
		expect(failure.code).toBe("owner_failed_unknown");
		expect(isReadinessFailure(failure)).toBe(false);
	},
);
it("still rejects opaque blobs after recognizing operational words", () => {
	const failure = normalizeCodexRecoveryFailure(
		new Error("daemon failed " + "x".repeat(64)),
	);
	expect(failure.summary).not.toContain("x".repeat(64));
});

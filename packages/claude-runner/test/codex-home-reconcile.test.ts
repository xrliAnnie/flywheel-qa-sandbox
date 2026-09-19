import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as runner from "../src/index.js";

type ReconcileExports = {
	computeCodexHomeInventoryDigest: (
		homes: Array<Record<string, unknown>>,
	) => string;
	isCodexHomeMigrationOverdue: (
		enrolledAt: string,
		days: number,
		now: Date,
		satisfied: boolean,
	) => boolean;
	evaluateCodexHomeMigrationDeadlines: (
		state: unknown,
		receipts: unknown[],
		now: Date,
	) => Array<{
		homeId: string;
		dueAt: string;
		pendingDays: number;
		overdue: boolean;
		satisfied: boolean;
		lastAttemptAt: string | null;
		lastResult: string | null;
		lastReason: string | null;
	}>;
	validateCodexHomeAttemptReceipt: (
		value: unknown,
		expectedInventoryDigest?: string,
	) => boolean;
	updateCodexHomeMigrationState: (input: {
		stateRoot: string;
		inventoryDigest: string;
		overdueDays: number;
		now: Date;
		homes: Array<{
			id: string;
			home: string;
			ownership: "managed" | "independent";
			pendingAt?: string;
		}>;
	}) => {
		enrolledAt: string;
		homes: Array<{ id: string; enrolledAt: string }>;
	};
	writeCodexHomeAttemptReceipt: (input: {
		stateRoot: string;
		receipt: Record<string, unknown>;
	}) => string;
	reserveCodexHomeAttemptIntent: (input: {
		stateRoot: string;
		intent: Record<string, unknown>;
	}) => string;
};

const api = runner as unknown as ReconcileExports;
const sha = (digit: string) => digit.repeat(64);

function attempt(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		attemptId: "8e237eaa-b23c-432f-a507-ad28052b51bc",
		at: "2026-09-18T00:00:00.000Z",
		homeId: "flywheel/implement",
		home: "/Users/test/.flywheel/codex-homes/agents/flywheel/implement",
		inventoryDigest: sha("a"),
		source: "health",
		buildSha: "b".repeat(40),
		result: "skipped",
		reason: "active_process",
		satisfied: false,
		backupRef: null,
		postcondition: null,
		...overrides,
	};
}

describe("codex home reconciliation state", () => {
	it("exports the T1 state primitives", () => {
		expect(typeof api.computeCodexHomeInventoryDigest).toBe("function");
		expect(typeof api.isCodexHomeMigrationOverdue).toBe("function");
		expect(typeof api.evaluateCodexHomeMigrationDeadlines).toBe("function");
		expect(typeof api.validateCodexHomeAttemptReceipt).toBe("function");
		expect(typeof api.updateCodexHomeMigrationState).toBe("function");
		expect(typeof api.writeCodexHomeAttemptReceipt).toBe("function");
		expect(typeof api.reserveCodexHomeAttemptIntent).toBe("function");
	});

	it("keeps missing receipts overdue and ignores stale-inventory satisfaction", () => {
		const state = {
			schemaVersion: 1,
			inventoryDigest: sha("a"),
			overdueDays: 1,
			enrolledAt: "2026-09-17T00:00:00.000Z",
			homes: [
				{
					id: "flywheel/implement",
					home: "/Users/test/.flywheel/codex-homes/agents/flywheel/implement",
					ownership: "managed",
					enrolledAt: "2026-09-17T00:00:00.000Z",
				},
			],
		};
		const missing = api.evaluateCodexHomeMigrationDeadlines(
			state,
			[],
			new Date("2026-09-18T00:00:00.000Z"),
		);
		expect(missing).toEqual([
			expect.objectContaining({
				homeId: "flywheel/implement",
				dueAt: "2026-09-18T00:00:00.000Z",
				pendingDays: 1,
				overdue: true,
				satisfied: false,
				lastAttemptAt: null,
			}),
		]);

		const stale = api.evaluateCodexHomeMigrationDeadlines(
			state,
			[
				attempt({
					inventoryDigest: sha("b"),
					result: "done",
					reason: "linked",
					satisfied: true,
				}),
			],
			new Date("2026-09-18T00:00:00.000Z"),
		);
		expect(stale[0]).toMatchObject({ overdue: true, satisfied: false });
	});

	it("preserves current-digest satisfaction while reporting the latest attempt", () => {
		const state = {
			schemaVersion: 1,
			inventoryDigest: sha("a"),
			overdueDays: 1,
			enrolledAt: "2026-09-17T00:00:00.000Z",
			homes: [
				{
					id: "flywheel/implement",
					home: "/Users/test/.flywheel/codex-homes/agents/flywheel/implement",
					ownership: "managed",
					enrolledAt: "2026-09-17T00:00:00.000Z",
				},
			],
		};
		const status = api.evaluateCodexHomeMigrationDeadlines(
			state,
			[
				attempt({
					at: "2026-09-17T12:00:00.000Z",
					result: "done",
					reason: "linked",
					satisfied: true,
				}),
				attempt({
					attemptId: "8e237eaa-b23c-432f-a507-ad28052b51bd",
					at: "2026-09-18T01:00:00.000Z",
					result: "skipped",
					reason: "active_process",
					satisfied: false,
				}),
			],
			new Date("2026-09-19T00:00:00.000Z"),
		)[0];

		expect(status).toMatchObject({
			satisfied: true,
			overdue: false,
			pendingDays: 2,
			lastAttemptAt: "2026-09-18T01:00:00.000Z",
			lastResult: "skipped",
			lastReason: "active_process",
		});
	});

	it("computes one deterministic digest from home and ownership only", () => {
		const a = api.computeCodexHomeInventoryDigest([
			{
				id: "two",
				home: "/tmp/é-home",
				ownership: "managed",
				checkedAt: "ignored",
			},
			{
				id: "one",
				home: "/tmp/a-home",
				ownership: "independent",
			},
		]);
		const b = api.computeCodexHomeInventoryDigest([
			{ home: "/tmp/a-home", ownership: "independent", owner: "ignored" },
			{ home: "/tmp/é-home", ownership: "managed" },
		]);

		expect(a).toMatch(/^[a-f0-9]{64}$/);
		expect(a).toBe(b);
	});

	it("treats the exact configured deadline as overdue unless satisfied", () => {
		const start = "2026-09-17T00:00:00.000Z";
		expect(
			api.isCodexHomeMigrationOverdue(
				start,
				1,
				new Date("2026-09-17T23:59:59.999Z"),
				false,
			),
		).toBe(false);
		expect(
			api.isCodexHomeMigrationOverdue(
				start,
				1,
				new Date("2026-09-18T00:00:00.000Z"),
				false,
			),
		).toBe(true);
		expect(
			api.isCodexHomeMigrationOverdue(
				start,
				1,
				new Date("2026-09-19T00:00:00.000Z"),
				true,
			),
		).toBe(false);
	});

	it("validates the closed receipt contract and current inventory digest", () => {
		expect(api.validateCodexHomeAttemptReceipt(attempt(), sha("a"))).toBe(true);
		expect(api.validateCodexHomeAttemptReceipt(attempt(), sha("c"))).toBe(
			false,
		);
		expect(
			api.validateCodexHomeAttemptReceipt(
				attempt({ result: "done", reason: "made_up", satisfied: true }),
			),
		).toBe(false);
	});

	it("persists enrollment and does not reset it on restart or inventory growth", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2523-state-"));
		const first = api.updateCodexHomeMigrationState({
			stateRoot: root,
			inventoryDigest: sha("1"),
			overdueDays: 1,
			now: new Date("2026-09-18T00:00:00.000Z"),
			homes: [
				{
					id: "flywheel/implement",
					home: join(root, "implement"),
					ownership: "managed",
					pendingAt: "2026-09-11T17:58:38.000Z",
				},
			],
		});
		const second = api.updateCodexHomeMigrationState({
			stateRoot: root,
			inventoryDigest: sha("2"),
			overdueDays: 1,
			now: new Date("2026-09-20T00:00:00.000Z"),
			homes: [
				{
					id: "flywheel/implement",
					home: join(root, "implement"),
					ownership: "managed",
				},
				{
					id: "raya/raya",
					home: join(root, "raya"),
					ownership: "managed",
				},
			],
		});

		expect(first.enrolledAt).toBe("2026-09-11T17:58:38.000Z");
		expect(second.enrolledAt).toBe("2026-09-11T17:58:38.000Z");
		expect(second.homes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "flywheel/implement",
					enrolledAt: "2026-09-11T17:58:38.000Z",
				}),
				expect.objectContaining({
					id: "raya/raya",
					enrolledAt: "2026-09-20T00:00:00.000Z",
				}),
			]),
		);
	});

	it("rejects an empty approved inventory", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2523-empty-"));
		expect(() =>
			api.updateCodexHomeMigrationState({
				stateRoot: root,
				inventoryDigest: sha("1"),
				overdueDays: 1,
				now: new Date("2026-09-18T00:00:00.000Z"),
				homes: [],
			}),
		).toThrow(/invalid/);
	});

	it("writes immutable 0600 attempt receipts outside the target home", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2523-attempt-"));
		const path = api.writeCodexHomeAttemptReceipt({
			stateRoot: root,
			receipt: attempt(),
		});
		const stat = lstatSync(path);
		expect(stat.isFile()).toBe(true);
		expect(stat.mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(attempt());
		expect(() =>
			api.writeCodexHomeAttemptReceipt({
				stateRoot: root,
				receipt: attempt(),
			}),
		).toThrow(/already exists/);
	});

	it("durably reserves an external intent before home mutation", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2523-intent-"));
		const intent = {
			schemaVersion: 1,
			attemptId: "8e237eaa-b23c-432f-a507-ad28052b51bd",
			at: "2026-09-18T00:00:00.000Z",
			homeId: "flywheel/implement",
			home: "/Users/test/.flywheel/codex-homes/agents/flywheel/implement",
			inventoryDigest: sha("a"),
			source: "manual",
			buildSha: "b".repeat(40),
			status: "started",
		};
		const path = api.reserveCodexHomeAttemptIntent({
			stateRoot: root,
			intent,
		});
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(intent);
	});

	it("rejects a symlinked attempts directory", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2523-symlink-"));
		const control = join(root, "codex-quota", "home-migration");
		const foreign = join(root, "foreign");
		mkdirSync(control, { recursive: true });
		mkdirSync(foreign);
		symlinkSync(foreign, join(control, "attempts"));

		expect(() =>
			api.writeCodexHomeAttemptReceipt({
				stateRoot: root,
				receipt: attempt(),
			}),
		).toThrow(/unsafe/);
	});
});

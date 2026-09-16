import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { CustomerReleaseAccountingPump } from "../customer-release/accounting-pump.js";
import { customerReleasePolicyDigest } from "../customer-release/activation.js";
import { createCustomerReleaseHost } from "../customer-release/host.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const states: StateStore[] = [];
const roots: string[] = [],
	dbs: Database.Database[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const state of states.splice(0)) state.close();
	for (const db of dbs.splice(0)) db.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	vi.useRealTimers();
});
function fixture(storeProvider?: () => CustomerReleaseStore) {
	const root = mkdtempSync(join(tmpdir(), "release-host-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel"));
	writeFileSync(
		join(root, ".flywheel/config.yaml"),
		"customer_release: {mode: off}\n",
	);
	const db = new Database(":memory:");
	dbs.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const fetcher = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) => {
			throw new Error("unexpected network");
		},
	);
	const env: Record<string, string | undefined> = {};
	let founder = "123456789012345678";
	const host = createCustomerReleaseHost({
		store: storeProvider ?? (() => store),
		projects: () => [
			{ projectName: "flywheel", projectRoot: root, projectRepo: "owner/repo" },
		],
		founderId: () => founder,
		env,
		codeSha: () => "a".repeat(40),
		flag: () => false,
		evaluate: () => ({ verdictId: "unused", state: "unknown" }),
		fetch: fetcher,
		now: () => 2000,
	});
	return {
		root,
		db,
		store,
		host,
		fetcher,
		env,
		founder: (id: string) => {
			founder = id;
		},
	};
}
it("actual host startup and shutdown stay inert with default-off config and no credentials", async () => {
	vi.useFakeTimers();
	const f = fixture();
	f.host.start();
	await vi.advanceTimersByTimeAsync(2000);
	await f.host.stop();
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.store.activation.get()).toBeNull();
});
it("missing or malformed deployment binding cannot construct a live release session", async () => {
	vi.useFakeTimers();
	const f = fixture();
	writeFileSync(
		join(f.root, ".flywheel/config.yaml"),
		"customer_release: {mode: canary}\n",
	);
	f.host.start();
	await vi.advanceTimersByTimeAsync(2000);
	await f.host.stop();
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.store.activation.get()?.enabled ?? false).toBe(false);
});

it("configured host creates the real disabled session and rotates owner identity without any publish request", async () => {
	vi.useFakeTimers();
	const stateRoot = mkdtempSync(join(tmpdir(), "release-host-state-"));
	roots.push(stateRoot);
	const state = await StateStore.create(join(stateRoot, "state.db"));
	states.push(state);
	const f = fixture(() => state.customerReleases);
	const recover = vi.spyOn(
		CustomerReleaseStore.prototype,
		"recoverAfterRestart",
	);
	const config: any = {
		mode: "canary",
		timezone: "America/Los_Angeles",
		weekday: 2,
		notice_local: "08:00",
		deadline_local: "14:00",
		claim_deadline_local: "15:00",
		minimum_veto_minutes: 120,
		policyRevision: "a".repeat(64),
		founderEnableReceiptId: "",
		channelId: "223456789012345678",
		guildId: "323456789012345678",
		applicationId: "423456789012345678",
		botUserId: "523456789012345678",
		bot_token_env: "BOT",
		decision_token_env: "DECISION",
		executor_repository_id: 1,
		executor_workflow_id: 2,
	};
	config.policyRevision = customerReleasePolicyDigest(config);
	writeFileSync(
		join(f.root, ".flywheel/config.yaml"),
		"customer_release: " + JSON.stringify(config) + "\n",
	);
	Object.assign(f.env, {
		BOT: "b".repeat(40),
		DECISION: "d".repeat(40),
		GITHUB: "g".repeat(40),
		PAYLOAD: "p".repeat(40),
		FW_CUSTOMER_RELEASE_RUNTIME_JSON: JSON.stringify({
			endpoint: "https://endpoint.example",
			audience: "payload",
			environment: "test",
			evidenceDirectory: f.root,
			prepareWorkflowId: 3,
			reviewedWorkflowSha: "a".repeat(40),
			githubTokenEnv: "GITHUB",
			payloadReadTokenEnv: "PAYLOAD",
		}),
	});
	f.host.start();
	await vi.advanceTimersByTimeAsync(3000);
	expect(recover).toHaveBeenCalledTimes(1);
	expect(state.customerReleases.activation.get()).toMatchObject({
		enabled: false,
		epoch: 1,
	});
	f.founder("623456789012345678");
	await vi.advanceTimersByTimeAsync(1000);
	expect(state.customerReleases.activation.get()).toMatchObject({
		enabled: false,
		epoch: 2,
	});
	expect(recover).toHaveBeenCalledTimes(2);
	await f.host.stop();
	const oldStore = state.customerReleases;
	expect(
		state.recoverFromCorruption(new Error("database disk image is malformed")),
	).toBe(true);
	expect(state.customerReleases).not.toBe(oldStore);
	expect(state.customerReleases).toBe(state.customerReleases);
	expect(f.fetcher).toHaveBeenCalled();
	expect(
		f.fetcher.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET"),
	).toBe(true);
});

it("keeps pending audit collection alive while release mode is off without network writes", async () => {
	vi.useFakeTimers();
	const f = fixture();
	f.db
		.prepare(
			"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
		)
		.run(
			"slot:flywheel:2026-09-14",
			"flywheel",
			1,
			"cycle_slot_missed",
			JSON.stringify({ weekStart: "2026-09-14", reason: "no_candidate" }),
			100,
		);
	f.host.start();
	await vi.advanceTimersByTimeAsync(2000);
	await f.host.stop();
	expect(f.store.accounting.pending(2000)).toHaveLength(2);
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.store.activation.get()).toBeNull();
});

it("keeps supervisor ticks running while the independent accounting worker is awaiting network", async () => {
	vi.useFakeTimers();
	const f = fixture();
	let resolve!: () => void;
	const waiting = new Promise<void>((done) => {
		resolve = done;
	});
	const tick = vi
		.spyOn(CustomerReleaseAccountingPump.prototype, "tick")
		.mockReturnValue(waiting);
	const capture = vi.spyOn(f.store.accounting, "capture");
	try {
		f.host.start();
		await vi.advanceTimersByTimeAsync(2000);
		expect(tick).toHaveBeenCalledTimes(1);
		expect(capture.mock.calls.length).toBeGreaterThanOrEqual(2);
	} finally {
		resolve();
		await f.host.stop();
		tick.mockRestore();
		capture.mockRestore();
	}
});

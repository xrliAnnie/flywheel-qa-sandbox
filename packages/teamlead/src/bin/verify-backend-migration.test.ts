import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	main,
	parseMigrationVerificationEvidence,
	verifyBackendMigration,
} from "./verify-backend-migration.js";

const evidence = {
	version: 1,
	channelId: "123456789012345678",
	messageId: "223456789012345678",
	issueId: "FLY-2457",
	runId: "12345678-1234-4234-8234-123456789012",
	nodeId: "design",
	executionId: "22345678-1234-4234-8234-123456789012",
	activationId: "activation:fixture",
	eventUid: "issue_delivery:fixture",
};
it("accepts only evidence locators, never passed booleans or caller-supplied identity", () => {
	expect(parseMigrationVerificationEvidence(evidence)).toEqual(evidence);
	for (const patch of [
		{ passed: true },
		{ founderId: "323456789012345678" },
		{ timestamp: "now" },
		{ channelId: "bad" },
		{ runId: "bad" },
		{ version: 2 },
	])
		expect(() =>
			parseMigrationVerificationEvidence({ ...evidence, ...patch }),
		).toThrow();
});
it("rejects invalid CLI arguments before any host reads or verification", async () => {
	expect(await main([])).toBe(64);
	expect(
		await main(["--migration", "other", "--evidence", "/tmp/no-file"]),
	).toBe(64);
	expect(
		await main([
			"--migration",
			"FLY-2459-honey-lemon",
			"--evidence",
			"relative.json",
		]),
	).toBe(64);
});

const state = vi.hoisted(() => ({ events: [] as string[], paused: false }));
vi.mock("flywheel-comm/lead-backend-migration-runtime", async (original) => ({
	...(await original<any>()),
	readMigrationIntentRecord: () => ({
		intentSha: "a".repeat(64),
		plan: {
			deploymentSha: "b".repeat(40),
			createdAt: "2026-09-10T00:00:00Z",
			leadId: "flywheel-product-lead",
			expected: {},
		},
	}),
	loadMigrationReceipt: () => ({
		intentSha: "a".repeat(64),
		sourceCarrier: { pid: 123, start: "old" },
	}),
	readMigrationRegistry: () => [],
	resolveMigrationIdentities: () => ({
		channelIds: ["123456789012345678"],
		botUserId: "323456789012345678",
		botTokenEnv: "TEST_VERIFY_BOT",
		target: { identityDigest: "c".repeat(64) },
	}),
	renderMigrationArtifacts: () => ({ manifest: "manifest", plist: "plist" }),
	observeMigrationRegistry: () => ({ state: "post" }),
	observeMigrationArtifact: () => ({ state: "post" }),
	assertMigrationOutsideWindow: async () => {
		state.events.push("fence");
		if (state.paused) throw Error("paused");
	},
	commitMigrationVerification: async (
		_h: string,
		_i: string,
		_e: string,
		verify: () => Promise<string>,
	) => {
		await verify();
		await verify();
		state.events.push("commit");
		return { status: "committed" };
	},
	retireCommittedMigrationIntent: async () => {
		state.events.push("retire");
	},
}));
vi.mock("flywheel-comm/founder-attribution", () => ({
	resolveFounderId: () => "423456789012345678",
}));
vi.mock("./backend-migration-evidence.js", () => ({
	verifyMigrationSource: async (input: any) => {
		state.events.push("source");
		return {
			channelId: input.channelId,
			messageId: input.messageId,
			at: "2026-09-11T00:00:00Z",
		};
	},
	verifyMigrationRunEvidence: () => {
		state.events.push("run");
		return "d".repeat(64);
	},
}));
vi.mock("./backend-migration-activation.js", () => ({
	observeMigrationActivation: async () => {
		state.events.push("activation");
		return "e".repeat(64);
	},
}));
it("assembles two live checks before commit and retires only after the final fence", async () => {
	const home = mkdtempSync(join(tmpdir(), "fly2459-verify-entry-"));
	try {
		mkdirSync(join(home, ".flywheel"));
		writeFileSync(join(home, ".flywheel/deployed-sha"), "b".repeat(40));
		const file = join(home, "evidence.json");
		writeFileSync(file, JSON.stringify(evidence));
		state.events = [];
		state.paused = false;
		expect(
			(await verifyBackendMigration(file, { home, root: home })).status,
		).toBe("committed");
		expect(state.events).toEqual([
			"fence",
			"source",
			"run",
			"activation",
			"fence",
			"fence",
			"source",
			"run",
			"activation",
			"fence",
			"commit",
			"fence",
			"retire",
		]);
		state.events = [];
		state.paused = true;
		await expect(
			verifyBackendMigration(file, { home, root: home }),
		).rejects.toThrow("paused");
		expect(state.events).toEqual(["fence"]);
	} finally {
		state.paused = false;
		rmSync(home, { recursive: true, force: true });
	}
});

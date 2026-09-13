import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	applyMigrationFields,
	planBackendMigration,
} from "../lead-backend-migration.js";
import { resolveMigrationIdentities } from "../lead-backend-migration-identities.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-identities-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel/summary-config.json"),
		JSON.stringify({
			state: "selected",
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-09-11T00:00:00.000Z",
		}),
	);
	const registry = [
		{
			projectName: "flywheel",
			projectRoot: home,
			leads: [
				{
					agentId: "flywheel-product-lead",
					backend: "claude-code",
					canSpawnRunners: true,
					summaryRole: "producer",
					botUserId: "123456789012345678",
					botTokenEnv: "PRODUCT_BOT_TOKEN",
					chatChannel: "223456789012345678",
					roundtableChannel: "323456789012345678",
					department: "product",
				},
			],
		},
	];
	const plan = planBackendMigration({
		registry,
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		toBackend: "codex-app-server",
		model: "gpt-6-astra",
		effort: "high",
		runnerActions: true,
		deploymentSha: "a".repeat(40),
		manifestSha: "b".repeat(64),
		plistSha: "c".repeat(64),
		createdAt: "2026-09-11T00:00:00.000Z",
	});
	return { home, registry, plan };
}
it("reuses canonical identity and preserves bot, summary and generic subscribed channels", () => {
	const f = fixture();
	const pair = resolveMigrationIdentities(f.home, f.registry, f.plan);
	expect(pair.source.backend).toBe("claude-code");
	expect(pair.target.backend).toBe("codex-app-server");
	expect(pair.target.identityDigest).not.toBe(pair.source.identityDigest);
	expect(pair.target.summaryAssignmentDigest).toBe(
		pair.source.summaryAssignmentDigest,
	);
	expect(pair.botTokenEnv).toBe("PRODUCT_BOT_TOKEN");
	expect(pair.channelIds).toEqual(["223456789012345678", "323456789012345678"]);
});
it("derives the same identity pair from a resumed target registry", () => {
	const f = fixture();
	const first = resolveMigrationIdentities(f.home, f.registry, f.plan),
		replay = resolveMigrationIdentities(
			f.home,
			applyMigrationFields(f.registry, f.plan),
			f.plan,
		);
	expect(replay.source.identityDigest).toBe(first.source.identityDigest);
	expect(replay.target.identityDigest).toBe(first.target.identityDigest);
});
it("rejects changed routing before returning any identity", () => {
	const f = fixture();
	f.registry[0]!.leads[0]!.chatChannel = "423456789012345678";
	expect(() => resolveMigrationIdentities(f.home, f.registry, f.plan)).toThrow(
		"stale target row",
	);
});

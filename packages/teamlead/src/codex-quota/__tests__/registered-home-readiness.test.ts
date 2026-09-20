import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCodexHomeInventoryDigest } from "flywheel-claude-runner";
import { afterEach, expect, it } from "vitest";
import { evaluateRegisteredHomeReadiness } from "../registered-home-readiness.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fly2523-registered-"));
	roots.push(root);
	const canonicalHome = join(root, "canonical");
	mkdirSync(canonicalHome, { recursive: true });
	writeFileSync(join(canonicalHome, "auth.json"), "{}", { mode: 0o600 });
	const roster = [
		[
			"flywheel/eng_design",
			join(root, "homes", "agents", "flywheel", "eng_design"),
		],
		[
			"flywheel/implement",
			join(root, "homes", "agents", "flywheel", "implement"),
		],
		["flywheel/codex-infra-bot-lead", join(root, ".codex-infra-bot")],
		["growth/mufasa-lead", join(root, ".codex-mufasa")],
		["raya/raya", join(root, ".codex-raya")],
	].map(([id, home]) => ({
		id: id!,
		home: home!,
		ownership: "managed" as const,
	}));
	for (const entry of roster) {
		mkdirSync(entry.home, { recursive: true });
		symlinkSync(
			join(canonicalHome, "auth.json"),
			join(entry.home, "auth.json"),
		);
	}
	const home = roster[0]!.home;
	const inventoryDigest = computeCodexHomeInventoryDigest(roster);
	const buildSha = "a".repeat(40);
	const at = "2026-09-18T00:00:00.000Z";
	const migrationState = {
		schemaVersion: 1 as const,
		inventoryDigest,
		overdueDays: 1,
		enrolledAt: at,
		homes: roster.map((entry) => ({ ...entry, enrolledAt: at })),
	};
	const attemptReceipts = roster.map((entry) => ({
		schemaVersion: 1 as const,
		attemptId: randomUUID(),
		at,
		homeId: entry.id,
		home: entry.home,
		inventoryDigest,
		source: "health" as const,
		buildSha,
		result: "done" as const,
		reason: "linked" as const,
		satisfied: true,
		backupRef: "backups/auth.json",
		postcondition: {},
	}));
	const manifest = {
		schemaVersion: 1 as const,
		buildSha,
		inventoryDigest,
		createdAt: at,
		homes: roster.map((entry) => ({
			home: entry.home,
			ownership: "managed" as const,
			credentialShared: true,
			checkedAt: at,
		})),
	};
	const inventory = {
		complete: false,
		registeredComplete: true,
		inventoryDigest,
		buildSha,
		homes: roster.map((entry) => ({
			home: entry.home,
			ownership: "managed" as const,
			activity: "active" as const,
		})),
		activeUnsharedAccountKeys: [],
		canonicalChainActive: true,
		diagnostics: [{ reason: "process_home_unknown", scope: "global" as const }],
		unattributedReaders: [
			{
				pid: 77,
				startIdentity: "desktop-start",
				executable: "/Applications/ChatGPT.app/codex",
				reason: "process_home_unknown",
			},
		],
	};
	return {
		root,
		canonicalHome,
		home,
		roster,
		inventoryDigest,
		buildSha,
		migrationState,
		attemptReceipts,
		manifest,
		inventory,
	};
}

it("keeps registered proof true while preserving a global desktop unknown", async () => {
	const f = fixture();
	const result = await evaluateRegisteredHomeReadiness({
		...f,
		expectedBuildSha: f.buildSha,
		global: { ready: false, failures: [{ reason: "authority_unavailable" }] },
		dependencies: {
			"FLY-2729": { status: "pending" },
			desktopCredentialAuthority: { status: "unknown", issueId: null },
		},
	});
	expect(result.registered).toMatchObject({
		ready: true,
		homeIds: [
			"flywheel/eng_design",
			"flywheel/implement",
			"flywheel/codex-infra-bot-lead",
			"growth/mufasa-lead",
			"raya/raya",
		],
		failures: [],
	});
	expect(result.global.ready).toBe(false);
	expect(result.unattributedReaders).toEqual(f.inventory.unattributedReaders);
	expect(result.activation).toEqual({
		authorized: false,
		ownedBy: "separate_gated_task",
	});
	expect(result.dependencies["FLY-2729"].status).toBe("pending");
});

it.each([
	[
		"missing receipt",
		(f: ReturnType<typeof fixture>) => {
			f.attemptReceipts = [];
		},
	],
	[
		"old digest",
		(f: ReturnType<typeof fixture>) => {
			f.attemptReceipts[0]!.inventoryDigest = "b".repeat(64);
		},
	],
	[
		"pending marker",
		(f: ReturnType<typeof fixture>) => {
			writeFileSync(join(f.home, ".credential-copy-pending"), "pending");
		},
	],
	[
		"wrong build",
		(f: ReturnType<typeof fixture>) => {
			f.manifest.buildSha = "b".repeat(40);
		},
	],
	[
		"census failure",
		(f: ReturnType<typeof fixture>) => {
			f.inventory.registeredComplete = false;
		},
	],
	[
		"CommDB orphan",
		(f: ReturnType<typeof fixture>) => {
			f.inventory.diagnostics.push({
				reason: "comm_orphan",
				scope: "registered",
			});
		},
	],
	[
		"unapproved active home",
		(f: ReturnType<typeof fixture>) => {
			f.inventory.diagnostics.push({
				reason: "unapproved_live_home",
				scope: "registered",
			});
		},
	],
])("does not approve registered homes with %s", async (_label, mutate) => {
	const f = fixture();
	mutate(f);
	const result = await evaluateRegisteredHomeReadiness({
		...f,
		expectedBuildSha: f.buildSha,
		global: { ready: false, failures: [{ reason: "authority_unavailable" }] },
		dependencies: {
			"FLY-2729": { status: "pending" },
			desktopCredentialAuthority: { status: "unknown", issueId: null },
		},
	});
	expect(result.registered.ready).toBe(false);
});

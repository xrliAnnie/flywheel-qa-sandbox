import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { canonicalSubmissionDigest, type PersonaPin } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { FetchDiscordMessageResult } from "../discord-utils.js";
import {
	type ActivationFenceV1,
	PersonaActivationReader,
	type PersonaAuthorizationRef,
	verifyStoppedPersonaConsumer,
} from "../lead-persona-activation.js";

const FOUNDER = "12345678901234567";
const SOURCE_DIGESTS = {
	journal: "1".repeat(64),
	legacyLedger: "2".repeat(64),
	migrationDecisions: "3".repeat(64),
};

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("PersonaActivationReader", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	async function fixture(options: { targetDigest?: string } = {}) {
		const rawRoot = mkdtempSync(join(tmpdir(), "fly2696-activation-"));
		dirs.push(rawRoot);
		const root = realpathSync.native(rawRoot);
		const workspace = join(root, "workspace");
		const stateRoot = join(root, "state", "lead-persona", "raya", "raya");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(stateRoot, { recursive: true });
		const store = await StateStore.create(join(root, "teamlead.db"));
		const database = store.assertOpenedDatabaseIdentityCurrent();
		const messages = new Map<string, FetchDiscordMessageResult>();
		let messageCounter = 0;
		const message = (
			content: string,
			timestampMs = Date.parse("2026-09-17T20:00:00.000Z"),
		) => {
			const messageId = String(22345678901234567n + BigInt(messageCounter++));
			messages.set(messageId, {
				ok: true,
				message: {
					id: messageId,
					channelId: "32345678901234567",
					authorId: FOUNDER,
					timestampMs,
					content,
				},
			});
			return {
				channelId: "32345678901234567",
				messageId,
				contentSha256: hash(content),
			};
		};
		const targetDigest = options.targetDigest ?? "a".repeat(64);
		const targetContent = `authorize raya xrliAnnie/raya .lead/raya/identity.md ${"a".repeat(40)} ${targetDigest}`;
		const lkgDigest = "b".repeat(64);
		const lkgContent = `authorize raya last-known-good ${"b".repeat(40)} ${lkgDigest}`;
		const target: PersonaPin = {
			commit: "a".repeat(40),
			personaBlobDigest: targetDigest,
			approval: message(targetContent),
		};
		const lastKnownGood: PersonaPin = {
			commit: "b".repeat(40),
			personaBlobDigest: lkgDigest,
			approval: message(lkgContent),
		};
		const personaProjection = {
			schemaVersion: 1 as const,
			enabled: true as const,
			leadId: "raya" as const,
			repo: "xrliAnnie/raya" as const,
			path: ".lead/raya/identity.md" as const,
			pin: target,
			lastKnownGood,
		};
		const project: ProjectEntry = {
			projectName: "raya",
			projectRoot: workspace,
			projectRepo: "xrliAnnie/raya",
			personaProjection,
			personaProjectionContractDigest:
				canonicalSubmissionDigest(personaProjection),
			leads: [
				{
					agentId: "raya",
					summaryRole: "recipient",
					chatChannel: "42345678901234567",
					match: { labels: ["raya"] },
					backend: "codex-app-server",
					codexProfile: "full-access",
					canSpawnRunners: false,
				},
			],
		};
		const reader = () =>
			new PersonaActivationReader({
				store,
				projects: [project],
				stateRoot,
				founderUserId: FOUNDER,
				fetchMessage: async (_channelId, messageId) =>
					messages.get(messageId) ?? { ok: false, kind: "not_found" },
				verifyStoppedConsumer: () => true,
				now: () => new Date("2026-09-18T00:00:00.000Z"),
			});
		return {
			root,
			workspace,
			stateRoot,
			store,
			database,
			messages,
			message,
			target,
			lastKnownGood,
			project,
			reader,
		};
	}

	function writeJson(path: string, value: unknown) {
		writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
	}

	function writeWindow(
		f: Awaited<ReturnType<typeof fixture>>,
		input: {
			phase: ActivationFenceV1["phase"];
			target?: PersonaPin;
			fallback?: ActivationFenceV1["fallback"];
			migrationReceipt?: ActivationFenceV1["migrationReceipt"];
		},
	) {
		const target = input.target ?? f.target;
		const fallback = input.fallback ?? null;
		const frozenAt = "2026-09-17T19:00:00.000Z";
		const frozenPayloadDigest = canonicalSubmissionDigest({
			windowId: "window-1",
			projectName: "raya",
			leadId: "raya",
			database: f.database,
			workspaceCanonicalPath: f.workspace,
			a0Digest: f.lastKnownGood.personaBlobDigest,
			target,
			fallback,
			frozenAt,
		});
		const authorizedPayloadDigest = frozenPayloadDigest;
		const activationContent = `activate ${authorizedPayloadDigest} ${frozenPayloadDigest} window-1`;
		const activationApproval = f.message(activationContent);
		const activationAuthorization: PersonaAuthorizationRef = {
			...activationApproval,
			authorId: FOUNDER,
			authorizedPayloadDigest,
		};
		const prepared = input.phase === "prepared";
		const fence: ActivationFenceV1 = {
			schemaVersion: 1,
			kind: "raya-persona-activation",
			windowId: "window-1",
			projectName: "raya",
			leadId: "raya",
			database: f.database,
			workspaceCanonicalPath: f.workspace,
			a0Digest: f.lastKnownGood.personaBlobDigest,
			target,
			fallback,
			frozenPayloadDigest,
			frozenAt,
			activationAuthorization,
			phase: input.phase,
			revision: 1,
			fenceEnteredAt: prepared ? null : "2026-09-17T20:10:00.000Z",
			stoppedConsumer: prepared
				? null
				: {
						pid: 4242,
						lstart: "Thu Sep 17 20:00:00 2026",
						leaseId: "lease-1",
						processAbsentObservedAt: "2026-09-17T20:10:01.000Z",
						leaseReleasedObservedAt: "2026-09-17T20:10:02.000Z",
					},
			migrationReceipt: input.migrationReceipt ?? null,
			issuer: { kind: "activation-owner", executionId: "exec-1" },
			legacyWriterHandoff: {
				disabledAt: "2026-09-17T18:00:00.000Z",
				guardDeployedSha: "d".repeat(40),
				legacyPassDrainedAt: "2026-09-17T18:30:00.000Z",
				baselinePersonaDigest: f.lastKnownGood.personaBlobDigest,
			},
			migrationOrigin: "new-execution",
		};
		writeJson(join(f.stateRoot, "enrollment.json"), {
			schemaVersion: 1,
			kind: "raya-persona-enrollment",
			windowId: fence.windowId,
			projectName: "raya",
			leadId: "raya",
			database: f.database,
			workspaceCanonicalPath: f.workspace,
			frozenPayloadDigest,
			activationAuthorization,
		});
		writeJson(join(f.stateRoot, "activation.json"), fence);
		return fence;
	}

	it("keeps legacy-complete without S4 markers legacy-managed", async () => {
		const f = await fixture();
		try {
			f.store.summaryPresentations.beginMigration({
				projectName: "raya",
				leadId: "raya",
				boundarySeq: 0,
				sourceDigests: SOURCE_DIGESTS,
			});
			f.store.summaryPresentations.completeMigration({
				projectName: "raya",
				leadId: "raya",
				sourceDigests: SOURCE_DIGESTS,
			});
			delete f.project.personaProjection;
			delete f.project.personaProjectionContractDigest;
			expect(await f.reader().read("raya", "raya")).toEqual({
				kind: "legacy-managed",
			});
		} finally {
			f.store.close();
		}
	});

	it("proves pre-M0 only for a prepared window pinned to verified A0", async () => {
		const f = await fixture({ targetDigest: "b".repeat(64) });
		try {
			writeWindow(f, { phase: "prepared", target: f.target });
			expect(await f.reader().read("raya", "raya")).toMatchObject({
				kind: "pre-m0",
				a0Digest: f.lastKnownGood.personaBlobDigest,
				revision: "1",
			});
		} finally {
			f.store.close();
		}
	});

	it("keeps a newly frozen B1 target unavailable while pre-M0 continues on A0", async () => {
		const f = await fixture({ targetDigest: "b".repeat(64) });
		try {
			const futureTarget = {
				...f.target,
				commit: "9".repeat(40),
				personaBlobDigest: "8".repeat(64),
			};
			writeWindow(f, { phase: "prepared", target: futureTarget });
			expect(await f.reader().read("raya", "raya")).toMatchObject({
				kind: "pre-m0",
				a0Digest: f.lastKnownGood.personaBlobDigest,
			});
		} finally {
			f.store.close();
		}
	});

	it("refuses a new contract pin before M0 and never treats enrolled deletion as unmanaged", async () => {
		const f = await fixture();
		try {
			writeWindow(f, { phase: "prepared" });
			expect(await f.reader().read("raya", "raya")).toMatchObject({
				kind: "refused",
				reason: "pre_m0_a0_mismatch",
			});
			delete f.project.personaProjection;
			delete f.project.personaProjectionContractDigest;
			expect(await f.reader().read("raya", "raya")).toEqual({
				kind: "refused",
				reason: "enrolled_contract_missing",
			});
		} finally {
			f.store.close();
		}
	});

	it("refuses edited or non-founder activation evidence", async () => {
		const f = await fixture({ targetDigest: "b".repeat(64) });
		try {
			const fence = writeWindow(f, { phase: "prepared" });
			f.messages.set(fence.activationAuthorization.messageId, {
				ok: true,
				message: {
					id: fence.activationAuthorization.messageId,
					channelId: fence.activationAuthorization.channelId,
					authorId: "99999999999999999",
					timestampMs: Date.parse("2026-09-17T20:00:00.000Z"),
					content: "edited",
				},
			});
			expect(await f.reader().read("raya", "raya")).toMatchObject({
				kind: "refused",
				reason: "authorization_author_invalid",
			});
		} finally {
			f.store.close();
		}
	});

	it("fails closed after M0 when the durable receipt is missing", async () => {
		const f = await fixture();
		try {
			writeWindow(f, {
				phase: "ready",
				migrationReceipt: {
					path: join(f.stateRoot, "m0-receipt.json"),
					receiptId: "e".repeat(64),
				},
			});
			const result = await f.reader().read("raya", "raya");
			expect(result.kind).toBe("refused");
			if (result.kind === "refused") {
				expect(result.reason).toMatch(/m0_receipt|ENOENT/);
			}
		} finally {
			f.store.close();
		}
	});

	it("returns only the B2-frozen migration-compatible post-M0 fallback", async () => {
		const f = await fixture();
		try {
			const completedAtMs = Date.parse("2026-09-17T21:00:00.000Z");
			f.store.summaryPresentations.beginMigration({
				projectName: "raya",
				leadId: "raya",
				boundarySeq: 0,
				sourceDigests: SOURCE_DIGESTS,
				nowMs: completedAtMs - 1,
			});
			f.store.summaryPresentations.completeMigration({
				projectName: "raya",
				leadId: "raya",
				sourceDigests: SOURCE_DIGESTS,
				nowMs: completedAtMs,
			});
			const db = new BetterSqlite3(join(f.root, "teamlead.db"));
			try {
				db.exec(
					"ALTER TABLE summary_presentation_migration ADD COLUMN completed_at_ms INTEGER",
				);
				db.prepare(
					"UPDATE summary_presentation_migration SET completed_at_ms = ? WHERE project_name = ? AND lead_id = ?",
				).run(completedAtMs, "raya", "raya");
			} finally {
				db.close();
			}
			const fallback = {
				...f.target,
				commit: "f".repeat(40),
				personaBlobDigest: "f".repeat(64),
				migrationCompatible: true as const,
			};
			const toolPath = join(f.root, "m0-wrapper.mjs");
			writeFileSync(toolPath, "// verified m0 wrapper\n", { mode: 0o600 });
			const toolBlobSha256 = hash("// verified m0 wrapper\n");
			const executionPayloadDigest = "9".repeat(64);
			const deployedSha = "8".repeat(40);
			const executionContent = `execute ${executionPayloadDigest} ${toolBlobSha256} ${deployedSha} ${SOURCE_DIGESTS.journal} ${SOURCE_DIGESTS.legacyLedger} ${SOURCE_DIGESTS.migrationDecisions} ${canonicalSubmissionDigest(f.database)}`;
			const executionApproval = f.message(
				executionContent,
				Date.parse("2026-09-17T20:30:00.000Z"),
			);
			const receiptBase = {
				schemaVersion: 1,
				kind: "raya-summary-presentation-m0",
				mode: "executed",
				windowId: "window-1",
				projectName: "raya",
				leadId: "raya",
				database: f.database,
				workspaceCanonicalPath: f.workspace,
				workspaceIdentityDigest: f.target.personaBlobDigest,
				summaryContractVersion: 2,
				state: "complete",
				migration_boundary_seq: 0,
				cursor_seq: 0,
				sourceDigests: SOURCE_DIGESTS,
				dispositions: {
					eligible: 0,
					historical_presented: 0,
					historical_silent: 0,
					needs_reconciliation: 0,
					claimed: 0,
				},
				verifiedRowCount: 0,
				dispositionDigest: canonicalSubmissionDigest([]),
				issuer: {
					kind: "flywheel-m0-wrapper",
					toolPath,
					toolBlobSha256,
					deployedSha,
				},
				executionAuthorization: {
					...executionApproval,
					authorId: FOUNDER,
					authorizedPayloadDigest: executionPayloadDigest,
				},
				completedAt: new Date(completedAtMs).toISOString(),
			};
			const generatedAt = "2026-09-17T21:05:00.000Z";
			const receiptId = canonicalSubmissionDigest(receiptBase);
			const receipt = { ...receiptBase, receiptId, generatedAt };
			writeJson(join(f.stateRoot, "m0-receipt.json"), receipt);
			writeFileSync(join(f.stateRoot, "m0-dispositions.jsonl"), "", {
				mode: 0o600,
			});
			writeWindow(f, {
				phase: "ready",
				fallback,
				migrationReceipt: {
					path: join(f.stateRoot, "m0-receipt.json"),
					receiptId,
				},
			});
			const result = await f.reader().read("raya", "raya");
			expect(result).toMatchObject({
				kind: "post-m0",
				fallback: {
					personaBlobDigest: fallback.personaBlobDigest,
					migrationCompatible: true,
				},
			});
		} finally {
			f.store.close();
		}
	});

	it("checks both the historical process tuple and current lease holder without writing the lease DB", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2696-lease-"));
		dirs.push(root);
		const path = join(root, "lead-lease.db");
		const db = new BetterSqlite3(path);
		db.exec(
			"CREATE TABLE lead_lease (lead_key TEXT PRIMARY KEY, holder_pid INTEGER, holder_start TEXT)",
		);
		db.prepare("INSERT INTO lead_lease VALUES (?, ?, ?)").run(
			"raya-raya",
			5252,
			"new-start",
		);
		db.close();
		const proof = {
			pid: 4242,
			lstart: "old-start",
			leaseId: "lease-1",
			processAbsentObservedAt: "2026-09-17T20:10:01.000Z",
			leaseReleasedObservedAt: "2026-09-17T20:10:02.000Z",
		};
		expect(
			verifyStoppedPersonaConsumer("raya-raya", proof, {
				leaseDbPath: path,
				now: () => new Date("2026-09-18T00:00:00.000Z"),
				processTupleState: (pid) => (pid === 4242 ? "dead" : "alive"),
			}),
		).toBe(false);
		expect(
			verifyStoppedPersonaConsumer("raya-raya", proof, {
				leaseDbPath: path,
				now: () => new Date("2026-09-18T00:00:00.000Z"),
				processTupleState: () => "dead",
			}),
		).toBe(true);
		expect(
			verifyStoppedPersonaConsumer("raya-raya", proof, {
				leaseDbPath: join(root, "missing.db"),
				processTupleState: () => "dead",
			}),
		).toBe(false);
	});
});

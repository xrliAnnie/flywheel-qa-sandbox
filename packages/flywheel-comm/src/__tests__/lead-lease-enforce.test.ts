import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { respond } from "../commands/respond.js";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";
import { resolveLeadIdentity } from "../lead-identity.js";
import {
	ensureLeaseEpisodeMaterialized,
	hashCarrierInstanceId,
	LeadLeaseDeniedError,
	LeadLeaseEpisodeStore,
	LeadLeaseStore,
	type LeadWriteAuthorizationDeps,
} from "../lead-lease.js";
import { LeadLeaseModeStore } from "../lead-lease-mode.js";

describe("FLY-1309 Lead write-boundary enforcement", () => {
	let dir: string;
	let dbPath: string;
	let env: NodeJS.ProcessEnv;
	let writerStart: string;
	let authorizationDeps: LeadWriteAuthorizationDeps;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-enforce-"));
		dbPath = join(dir, "comm.db");
		writerStart = "test-writer-start";
		authorizationDeps = {
			processStart: () => writerStart,
			processAliveWithStart: (pid, start) =>
				pid === process.pid && start === writerStart,
		};
		env = {
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "lease.db"),
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "lease-episodes.db"),
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(dir, "mode.json"),
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "carrier-evidence.json"),
			FLYWHEEL_LEAD_RECEIPT_DIR: join(dir, "carrier-receipts"),
			FLYWHEEL_ALERT_QUEUE_DIR: join(dir, "alert-queue"),
			FLYWHEEL_LEAD_LEASE_AUDIT_LOG: join(dir, "lead-lease-audit.log"),
			FLYWHEEL_LEAD_ID: "eng-lead",
		};
		writeProjects("claude-code");
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	function writeProjects(
		backend: "claude-code" | "codex-app-server",
		carrier?: "v1" | "v2",
	): void {
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE!,
			JSON.stringify([
				{
					projectName: "flywheel",
					leads: [
						{ agentId: "eng-lead", backend, ...(carrier ? { carrier } : {}) },
					],
				},
			]),
		);
		const identity = resolveLeadIdentity({
			projectsPath: env.FLYWHEEL_PROJECTS_FILE!,
			projectName: "flywheel",
			leadId: "eng-lead",
		});
		env.FLYWHEEL_PROJECT_NAME = identity.projectName;
		env.FLYWHEEL_LEAD_KEY = identity.leadKey;
		env.FLYWHEEL_LEAD_ROLE = identity.role;
		env.FLYWHEEL_LEAD_BACKEND = identity.backend;
		env.FLYWHEEL_LEAD_IDENTITY_DIGEST = identity.identityDigest;
		env.FLYWHEEL_LEAD_PROJECTS_DIGEST = identity.projectsDigest;
		env.DISCORD_STATE_DIR = identity.discordStateDir;
		env.DISCORD_EXPECTED_BOT_USER_ID = identity.botUserId ?? "";
	}

	it.each(["off", "audit_only", "enforce"] as const)(
		"hard-rejects registry identity drift in %s mode",
		async (mode) => {
			setMode(mode);
			if (mode !== "off") bindLease();
			writeFileSync(
				env.FLYWHEEL_PROJECTS_FILE!,
				JSON.stringify([
					{
						projectName: "flywheel",
						leads: [{ agentId: "eng-lead", companion: true }],
					},
				]),
			);

			await expect(
				send({
					fromAgent: "eng-lead",
					toAgent: "runner-1",
					content: "stale identity",
					dbPath,
					env,
					authorizationDeps,
				}),
			).rejects.toMatchObject({ reason: "identity_digest_mismatch" });
			expect(instructions()).toEqual([]);
			const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!);
			expect(lease.listPendingAudit()).toEqual([
				expect.objectContaining({
					leadKey: "flywheel-eng-lead",
					event: "blocked",
					detail: JSON.stringify({
						reason: "identity_digest_mismatch",
						claimedLeadId: "eng-lead",
					}),
				}),
			]);
			lease.close();
		},
	);

	it("requires a bound lease even for a canonically configured v2 Claude carrier", async () => {
		writeProjects("claude-code", "v2");
		setMode("enforce");
		env.FLYWHEEL_LEAD_CARRIER = "v2";

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "launchd-owned carrier",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "missing_or_mismatched_claim" });
		expect(instructions()).toEqual([]);
	});

	it("does not infer lease authority from an absent Claude carrier config", async () => {
		setMode("enforce");
		env.FLYWHEEL_LEAD_CARRIER = "v2";
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "canonical default carrier",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "missing_or_mismatched_claim" });
		expect(instructions()).toEqual([]);
	});

	it("does not revive an explicitly retired v1 config", async () => {
		writeProjects("claude-code", "v1");
		setMode("enforce");
		env.FLYWHEEL_LEAD_CARRIER = "v2";
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-intruder",
				content: "retired carrier",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
	});

	function setMode(mode: "off" | "audit_only" | "enforce"): void {
		new LeadLeaseModeStore(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, env).set(
			mode,
			"test",
		);
	}

	function bindLease(generation = 1): void {
		const store = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!, {
			processAliveWithStart: () => false,
		});
		const acquired = store.acquire({
			leadKey: "flywheel-eng-lead",
			project: "flywheel",
			leadId: "eng-lead",
			identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
			supervisorPid: 111,
			supervisorStart: "supervisor-start",
			acquiredBy: "test",
		});
		expect(acquired.generation).toBe(generation);
		store.bind({
			leadKey: "flywheel-eng-lead",
			generation,
			expectedSupervisorPid: 111,
			expectedSupervisorStart: "supervisor-start",
			identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
			panePid: 222,
			paneStart: "pane-start",
		});
		store.close();
		env.FLYWHEEL_LEAD_LEASE_KEY = "flywheel-eng-lead";
		env.FLYWHEEL_LEAD_GENERATION = String(generation);
	}

	function instructions(): ReturnType<CommDB["getUnreadInstructions"]> {
		const db = new CommDB(dbPath);
		try {
			return db.getUnreadInstructions("runner-1");
		} finally {
			db.close();
		}
	}

	it("allows the current bound Claude generation and persists holder + writer provenance", async () => {
		setMode("enforce");
		bindLease();

		await send({
			fromAgent: "eng-lead",
			toAgent: "runner-1",
			content: "current",
			dbPath,
			env,
			authorizationDeps,
		});

		expect(instructions()[0]).toMatchObject({
			sender_lease_key: "flywheel-eng-lead",
			sender_generation: 1,
			sender_holder_pid: 222,
			sender_holder_start: "pane-start",
			writer_pid: process.pid,
			writer_start: writerStart,
		});
	});

	it("rejects a legacy NULL identity digest row until the Lead restarts and reacquires", async () => {
		setMode("enforce");
		const store = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!, {
			processAliveWithStart: () => false,
		});
		store.acquire({
			leadKey: "flywheel-eng-lead",
			project: "flywheel",
			leadId: "eng-lead",
			supervisorPid: 111,
			supervisorStart: "legacy-supervisor",
			acquiredBy: "legacy",
		});
		store.bind({
			leadKey: "flywheel-eng-lead",
			generation: 1,
			expectedSupervisorPid: 111,
			expectedSupervisorStart: "legacy-supervisor",
			panePid: 222,
			paneStart: "legacy-pane",
		});
		store.close();
		env.FLYWHEEL_LEAD_LEASE_KEY = "flywheel-eng-lead";
		env.FLYWHEEL_LEAD_GENERATION = "1";

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "legacy row",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "missing_identity_digest" });
	});

	it("rejects a claim-free v2 carrier for ordinary writes", async () => {
		writeProjects("claude-code", "v2");
		setMode("enforce");
		env.FLYWHEEL_LEAD_CARRIER = "v2";

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "old v2 body",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "missing_or_mismatched_claim" });
		expect(instructions()).toEqual([]);
	});

	it("routes a degraded v2 marker through audit_only but fails closed in enforce", async () => {
		writeProjects("claude-code", "v2");
		env.FLYWHEEL_LEAD_CARRIER = "v2";
		env.FLYWHEEL_LEAD_LEASE_DEGRADED = "store_error";
		setMode("audit_only");

		await send({
			fromAgent: "eng-lead",
			toAgent: "runner-1",
			content: "degraded audit window",
			dbPath,
			env,
			authorizationDeps,
		});
		expect(instructions()).toHaveLength(1);
		const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!);
		expect(lease.listPendingAudit()).toEqual([
			expect.objectContaining({
				event: "would_block",
				detail: expect.stringContaining("missing_or_mismatched_claim"),
			}),
		]);
		lease.close();

		setMode("enforce");
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-2",
				content: "must not pass",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "missing_or_mismatched_claim" });
	});

	it("rejects a partial v2 lease claim instead of treating it as carrier passthrough", async () => {
		writeProjects("claude-code", "v2");
		env.FLYWHEEL_LEAD_CARRIER = "v2";
		env.FLYWHEEL_LEAD_LEASE_KEY = "flywheel-eng-lead";
		setMode("enforce");

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "partial claim",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "missing_or_mismatched_claim" });
		expect(instructions()).toEqual([]);
	});

	it("rejects a stale Claude generation before send writes anything", async () => {
		setMode("enforce");
		bindLease();
		env.FLYWHEEL_LEAD_GENERATION = "99";

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "stale",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		expect(instructions()).toEqual([]);
	});

	it("audit_only allows a stale write but records would_block without raw secrets", async () => {
		setMode("audit_only");
		bindLease();
		env.FLYWHEEL_LEAD_GENERATION = "99";

		await send({
			fromAgent: "eng-lead",
			toAgent: "runner-1",
			content: "migration window",
			dbPath,
			env,
			authorizationDeps,
		});
		expect(instructions()).toHaveLength(1);
		const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!);
		expect(lease.listPendingAudit()).toEqual([
			expect.objectContaining({
				leadKey: "flywheel-eng-lead",
				event: "would_block",
			}),
		]);
		lease.close();
	});

	it("attributes an audit-only stale write to its immutable historical holder", async () => {
		setMode("audit_only");
		bindLease();
		const store = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!, {
			processAliveWithStart: () => false,
		});
		const successor = store.acquire({
			leadKey: "flywheel-eng-lead",
			project: "flywheel",
			leadId: "eng-lead",
			identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
			supervisorPid: 333,
			supervisorStart: "next-supervisor-start",
			acquiredBy: "test",
		});
		expect(successor.generation).toBe(2);
		store.bind({
			leadKey: "flywheel-eng-lead",
			generation: 2,
			expectedSupervisorPid: 333,
			expectedSupervisorStart: "next-supervisor-start",
			identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
			panePid: 444,
			paneStart: "next-pane-start",
		});
		store.close();
		env.FLYWHEEL_LEAD_GENERATION = "1";

		await send({
			fromAgent: "eng-lead",
			toAgent: "runner-1",
			content: "old pane during migration",
			dbPath,
			env,
			authorizationDeps,
		});

		expect(instructions()[0]).toMatchObject({
			sender_lease_key: "flywheel-eng-lead",
			sender_generation: 1,
			sender_holder_pid: 222,
			sender_holder_start: "pane-start",
		});
	});

	it("off mode preserves the old path without touching the lease store", async () => {
		setMode("off");
		env.FLYWHEEL_LEAD_GENERATION = "stale";
		await send({
			fromAgent: "eng-lead",
			toAgent: "runner-1",
			content: "off",
			dbPath,
			env,
			authorizationDeps,
		});
		expect(instructions()).toHaveLength(1);
		expect(existsSync(env.FLYWHEEL_LEAD_LEASE_DB!)).toBe(false);
		expect(existsSync(env.FLYWHEEL_LEAD_EPISODE_DB!)).toBe(false);
		expect(existsSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toBe(false);
	});

	it("off mode still forwards the canonical identity digest to the Bridge", async () => {
		setMode("off");
		env.TEAMLEAD_API_TOKEN = "token";
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion("runner-1", "eng-lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.close();
		let body = "";
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				body = String(init?.body);
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		);

		await respond({
			questionId,
			fromAgent: "eng-lead",
			answer: '{"approved":false}',
			dbPath,
			env,
			bridgeUrl: "http://127.0.0.1:9876",
			fetchImpl: fetchImpl as typeof fetch,
		});

		expect(body).toBe(
			JSON.stringify({
				questionId,
				leadId: "eng-lead",
				answer: '{"approved":false}',
				executionId: "runner-1",
				identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
			}),
		);
		expect(existsSync(env.FLYWHEEL_LEAD_LEASE_DB!)).toBe(false);
		expect(existsSync(env.FLYWHEEL_LEAD_EPISODE_DB!)).toBe(false);
	});

	it("the retired bypass env cannot authorize a write", async () => {
		setMode("enforce");
		env.FLYWHEEL_LEAD_LEASE_BYPASS = "1";
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "must not bypass",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		expect(instructions()).toEqual([]);
		expect(existsSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toBe(false);
	});

	it("source_error with a Lead marker fails closed and leaves CommDB empty", async () => {
		setMode("enforce");
		writeFileSync(env.FLYWHEEL_PROJECTS_FILE!, "{broken");
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "must not land",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		expect(instructions()).toEqual([]);
	});

	it("records a claimed Lead identity mismatch against the canonical lease", async () => {
		setMode("enforce");
		bindLease();
		env.FLYWHEEL_LEAD_ID = "other-lead";

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "identity mismatch",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "claimed_lead_mismatch" });
		expect(instructions()).toEqual([]);
		const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!);
		expect(lease.listPendingAudit()).toEqual([
			expect.objectContaining({
				leadKey: "flywheel-eng-lead",
				event: "blocked",
				detail: JSON.stringify({
					reason: "claimed_lead_mismatch",
					claimedLeadId: "eng-lead",
				}),
			}),
		]);
		lease.close();
	});

	it("fails closed with independent evidence when the lease store is broken", async () => {
		setMode("enforce");
		mkdirSync(env.FLYWHEEL_LEAD_LEASE_DB!, { recursive: true });

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "broken store",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "lease_store_error" });
		expect(instructions()).toEqual([]);
		const queued = readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!);
		expect(queued).toHaveLength(1);
		expect(
			JSON.parse(
				readFileSync(join(env.FLYWHEEL_ALERT_QUEUE_DIR!, queued[0]!), "utf8"),
			),
		).toMatchObject({ eventType: "lead_lease_store_broken" });
		expect(readFileSync(env.FLYWHEEL_LEAD_LEASE_AUDIT_LOG!, "utf8")).toContain(
			"lease_store_error",
		);
	});

	it("keeps the write boundary fail-closed and falls back loudly when the episode store is broken", async () => {
		setMode("enforce");
		mkdirSync(env.FLYWHEEL_LEAD_EPISODE_DB!, { recursive: true });
		writeFileSync(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, "{broken");
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "broken episode store",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		expect(instructions()).toEqual([]);
		const queued = readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!).map((file) =>
			JSON.parse(
				readFileSync(join(env.FLYWHEEL_ALERT_QUEUE_DIR!, file), "utf8"),
			),
		);
		expect(queued).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "lead_lease_control_broken",
					episodeStoreDegraded: true,
				}),
			]),
		);
	});

	it("treats a corrupt mode control as enforce and emits an independent alert", async () => {
		writeFileSync(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, "{broken");

		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: "corrupt control",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		expect(instructions()).toEqual([]);
		const events = readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!).map((name) =>
			JSON.parse(
				readFileSync(join(env.FLYWHEEL_ALERT_QUEUE_DIR!, name), "utf8"),
			),
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "lead_lease_control_broken" }),
			]),
		);
	});

	it("coalesces a persistent corrupt control across validations, then creates one new episode after recovery", async () => {
		writeFileSync(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, "{broken");
		for (const runner of ["runner-1", "runner-2", "runner-3"]) {
			await expect(
				send({
					fromAgent: "eng-lead",
					toAgent: runner,
					content: "corrupt control",
					dbPath,
					env,
					authorizationDeps,
				}),
			).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		}
		expect(readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toHaveLength(1);

		setMode("enforce");
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-4",
				content: "healthy control",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		writeFileSync(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, "{broken-again");
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-5",
				content: "corrupt control recurrence",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		expect(readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toHaveLength(2);
	});

	it("does not downgrade an unconfigured caller to an unprotected Lead write", async () => {
		setMode("enforce");
		delete env.FLYWHEEL_LEAD_ID;
		delete env.FLYWHEEL_LEAD_IDENTITY_DIGEST;
		await expect(
			send({
				fromAgent: "bridge",
				toAgent: "runner-1",
				content: "internal",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toMatchObject({ reason: "identity_row_missing" });
		expect(instructions()).toEqual([]);
	});

	it("allows a matching healthy Codex carrier but denies a same-identity intruder", async () => {
		writeProjects("codex-app-server");
		setMode("enforce");
		const rawClaim = "secret-carrier-instance";
		env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = rawClaim;
		writeFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
			JSON.stringify({
				schemaVersion: 1,
				collectedAt: new Date().toISOString(),
				leads: {
					"flywheel-eng-lead": {
						leadKey: "flywheel-eng-lead",
						backend: "codex-app-server",
						identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST!,
						pid: process.pid,
						lstart: writerStart,
						instanceDigest: hashCarrierInstanceId(rawClaim),
					},
				},
			}),
		);
		mkdirSync(env.FLYWHEEL_LEAD_RECEIPT_DIR!, { recursive: true });
		writeFileSync(
			join(env.FLYWHEEL_LEAD_RECEIPT_DIR!, "flywheel-eng-lead.json"),
			JSON.stringify({
				schemaVersion: 1,
				contractVersion: 1,
				leadKey: "flywheel-eng-lead",
				identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST!,
				instanceDigest: hashCarrierInstanceId(rawClaim),
				pid: process.pid,
				lstart: writerStart,
				checkedAt: "2000-01-01T00:00:00.000Z",
				cliDisposition: "carrier_passthrough",
				bridgeDisposition: "carrier_passthrough",
			}),
		);

		await send({
			fromAgent: "eng-lead",
			toAgent: "runner-1",
			content: "carrier",
			dbPath,
			env,
			authorizationDeps,
		});
		expect(instructions()).toHaveLength(1);

		delete env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID;
		await expect(
			send({
				fromAgent: "eng-lead",
				toAgent: "runner-2",
				content: "intruder",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		const verify = new CommDB(dbPath);
		expect(verify.getUnreadInstructions("runner-2")).toEqual([]);
		verify.close();
		expect(
			readFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!, "utf8"),
		).not.toContain(rawClaim);
	});

	it.each(["missing", "wrong", "stale"] as const)(
		"audit_only records backend_drift for a %s Codex carrier claim",
		async (fault) => {
			writeProjects("codex-app-server");
			setMode("audit_only");
			const rawClaim = "carrier-capability";
			if (fault !== "missing") {
				env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = rawClaim;
				writeFileSync(
					env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
					JSON.stringify({
						schemaVersion: 1,
						collectedAt:
							fault === "stale"
								? new Date(Date.now() - 91_000).toISOString()
								: new Date().toISOString(),
						leads: {
							"flywheel-eng-lead": {
								leadKey: "flywheel-eng-lead",
								backend: "codex-app-server",
								identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST!,
								pid: process.pid,
								lstart: writerStart,
								instanceDigest: hashCarrierInstanceId(
									fault === "wrong" ? "another-capability" : rawClaim,
								),
							},
						},
					}),
				);
			}

			await send({
				fromAgent: "eng-lead",
				toAgent: "runner-1",
				content: `${fault} carrier migration`,
				dbPath,
				env,
				authorizationDeps,
			});
			expect(instructions()).toHaveLength(1);
			const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!);
			expect(lease.listPendingAudit()).toEqual([
				expect.objectContaining({
					leadKey: "flywheel-eng-lead",
					event: "would_block",
					detail: expect.stringContaining("backend_drift"),
				}),
			]);
			lease.close();
		},
	);

	it("keeps repeated carrier drift validations on one specialized episode", async () => {
		writeProjects("codex-app-server");
		setMode("audit_only");
		for (const runner of ["runner-1", "runner-2", "runner-3"]) {
			await send({
				fromAgent: "eng-lead",
				toAgent: runner,
				content: "missing carrier",
				dbPath,
				env,
				authorizationDeps,
			});
		}
		expect(readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toHaveLength(1);
		const episodes = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		expect(
			episodes.getActive("lead_backend_drift:carrier:flywheel-eng-lead"),
		).toMatchObject({ kind: "lead_backend_drift", faultState: "active" });
		episodes.close();
	});

	it("healthy carrier validations never recover the ps-scanner-owned Claude intruder episode", async () => {
		writeProjects("codex-app-server");
		setMode("enforce");
		const rawClaim = "healthy-carrier";
		env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = rawClaim;
		writeFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
			JSON.stringify({
				schemaVersion: 1,
				collectedAt: new Date().toISOString(),
				leads: {
					"flywheel-eng-lead": {
						leadKey: "flywheel-eng-lead",
						backend: "codex-app-server",
						identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST!,
						pid: process.pid,
						lstart: writerStart,
						instanceDigest: hashCarrierInstanceId(rawClaim),
					},
				},
			}),
		);
		const intruder = ensureLeaseEpisodeMaterialized({
			env,
			sourceFingerprint: "lead_backend_drift:claude_intruder:flywheel-eng-lead",
			kind: "lead_backend_drift",
			payload: {
				leadId: "eng-lead",
				projectName: "flywheel",
				title: "intruder",
				body: "intruder",
				severity: "severe",
			},
		});
		for (const runner of ["runner-1", "runner-2", "runner-3"]) {
			await send({
				fromAgent: "eng-lead",
				toAgent: runner,
				content: "healthy carrier validation",
				dbPath,
				env,
				authorizationDeps,
			});
		}
		const episodes = new LeadLeaseEpisodeStore(env.FLYWHEEL_LEAD_EPISODE_DB!);
		expect(
			episodes.getActive("lead_backend_drift:claude_intruder:flywheel-eng-lead")
				?.episodeId,
		).toBe(intruder.episodeId);
		expect(
			episodes.getActive("lead_backend_drift:carrier:flywheel-eng-lead"),
		).toBeUndefined();
		episodes.close();
		expect(readdirSync(env.FLYWHEEL_ALERT_QUEUE_DIR!)).toHaveLength(1);
	});

	it("rejects stale non-gated respond before inserting a response", async () => {
		setMode("enforce");
		bindLease();
		env.FLYWHEEL_LEAD_GENERATION = "99";
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion("runner-1", "eng-lead", "question");
		db.close();

		await expect(
			respond({
				questionId,
				fromAgent: "eng-lead",
				answer: "stale answer",
				dbPath,
				env,
				authorizationDeps,
			}),
		).rejects.toBeInstanceOf(LeadLeaseDeniedError);
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(questionId)).toBeUndefined();
		verify.close();
	});

	it("sends lease claim and provenance to the Bridge for a gated response", async () => {
		setMode("enforce");
		bindLease();
		env.TEAMLEAD_API_TOKEN = "token";
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion("runner-1", "eng-lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.close();
		let posted: Record<string, unknown> | undefined;
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);

		await respond({
			questionId,
			fromAgent: "eng-lead",
			answer: '{"approved":false}',
			dbPath,
			env,
			authorizationDeps,
			bridgeUrl: "http://127.0.0.1:9876",
			fetchImpl: fetchImpl as typeof fetch,
		});
		expect(posted).toMatchObject({
			leadId: "eng-lead",
			leaseClaim: {
				leaseKey: "flywheel-eng-lead",
				generation: 1,
			},
			provenance: {
				senderLeaseKey: "flywheel-eng-lead",
				senderGeneration: 1,
				senderHolderPid: 222,
			},
		});
	});

	it("routes a raw Codex carrier claim only through the shared loopback guard", async () => {
		writeProjects("codex-app-server");
		setMode("enforce");
		const rawClaim = "raw-carrier-capability";
		env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = rawClaim;
		env.TEAMLEAD_API_TOKEN = "token";
		writeFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
			JSON.stringify({
				schemaVersion: 1,
				collectedAt: new Date().toISOString(),
				leads: {
					"flywheel-eng-lead": {
						leadKey: "flywheel-eng-lead",
						backend: "codex-app-server",
						identityDigest: env.FLYWHEEL_LEAD_IDENTITY_DIGEST!,
						pid: process.pid,
						lstart: writerStart,
						instanceDigest: hashCarrierInstanceId(rawClaim),
					},
				},
			}),
		);
		const db = new CommDB(dbPath);
		const safeQuestion = db.insertQuestion("runner-1", "eng-lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		const unsafeQuestion = db.insertQuestion("runner-1", "eng-lead", "ship?", {
			checkpoint: "approve_to_ship",
		});
		db.close();
		let posted: Record<string, unknown> | undefined;
		let redirect: RequestInit["redirect"];
		const safeFetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
				redirect = init?.redirect;
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		);

		await respond({
			questionId: safeQuestion,
			fromAgent: "eng-lead",
			answer: '{"approved":false}',
			dbPath,
			env,
			authorizationDeps,
			bridgeUrl: "http://[::1]:9876",
			fetchImpl: safeFetch as typeof fetch,
		});
		expect(posted).toMatchObject({ carrierClaim: rawClaim });
		expect(redirect).toBe("error");

		const unsafeFetch = vi.fn();
		await expect(
			respond({
				questionId: unsafeQuestion,
				fromAgent: "eng-lead",
				answer: '{"approved":false}',
				dbPath,
				env,
				authorizationDeps,
				bridgeUrl: "https://localhost.evil",
				fetchImpl: unsafeFetch as typeof fetch,
			}),
		).rejects.toThrow(/loopback/i);
		expect(unsafeFetch).not.toHaveBeenCalled();
		const verify = new CommDB(dbPath);
		expect(verify.getResponse(unsafeQuestion)).toBeUndefined();
		expect(
			JSON.stringify(verify.getUnreadInstructions("runner-1")),
		).not.toContain(rawClaim);
		verify.close();
	});
});

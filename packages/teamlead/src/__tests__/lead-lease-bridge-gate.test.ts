import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { resolveLeadIdentity } from "flywheel-comm/lead-identity";
import {
	hashCarrierInstanceId,
	LeadLeaseModeStore,
	LeadLeaseStore,
} from "flywheel-comm/lead-lease";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFounderRoutingResponseRouter } from "../bridge/founder-routing-response-route.js";

const PROJECT = "TestProj";
const LEAD_ID = "eng-lead";
const LEAD_KEY = `${PROJECT}-${LEAD_ID}`;

describe("FLY-1309 Bridge Lead lease write boundary", () => {
	let dir: string;
	let commRoot: string;
	let commDbPath: string;
	let env: NodeJS.ProcessEnv;
	let server: Server;
	let currentIdentityDigest: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-bridge-"));
		const stateRoot = join(dir, ".flywheel");
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(
			join(stateRoot, "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "test",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		commRoot = join(dir, "comm");
		const projectDir = join(commRoot, PROJECT);
		mkdirSync(projectDir, { recursive: true });
		commDbPath = join(projectDir, "comm.db");
		env = {
			HOME: dir,
			FLYWHEEL_STATE_DIR: stateRoot,
			FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
			FLYWHEEL_LEAD_LEASE_DB: join(dir, "lead-lease.db"),
			FLYWHEEL_LEAD_EPISODE_DB: join(dir, "lease-episodes.db"),
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(dir, "lead-lease-mode.json"),
			FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: join(dir, "carrier-evidence.json"),
			FLYWHEEL_ALERT_QUEUE_DIR: join(dir, "alert-queue"),
			FLYWHEEL_LEAD_LEASE_AUDIT_LOG: join(dir, "lease-audit.log"),
		};
		writeProjects("claude-code");
		new LeadLeaseModeStore(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, env).set(
			"enforce",
			"test",
		);
	});

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function writeProjects(backend: "claude-code" | "codex-app-server"): void {
		writeFileSync(
			env.FLYWHEEL_PROJECTS_FILE!,
			JSON.stringify([
				{
					projectName: PROJECT,
					leads: [{ agentId: LEAD_ID, backend, summaryRole: "producer" }],
				},
			]),
		);
		currentIdentityDigest = resolveLeadIdentity({
			projectsPath: env.FLYWHEEL_PROJECTS_FILE!,
			projectName: PROJECT,
			leadId: LEAD_ID,
			homeDir: dir,
		}).identityDigest;
	}

	function bindLease(): void {
		const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!, {
			processAliveWithStart: () => false,
		});
		const acquired = lease.acquire({
			leadKey: LEAD_KEY,
			project: PROJECT,
			leadId: LEAD_ID,
			identityDigest: currentIdentityDigest,
			supervisorPid: 111,
			supervisorStart: "supervisor-start",
			acquiredBy: "test",
		});
		lease.bind({
			leadKey: LEAD_KEY,
			generation: acquired.generation,
			identityDigest: currentIdentityDigest,
			expectedSupervisorPid: 111,
			expectedSupervisorStart: "supervisor-start",
			panePid: 222,
			paneStart: "pane-start",
		});
		lease.close();
	}

	function seedQuestion(): string {
		const db = new CommDB(commDbPath, true);
		db.registerSession("exec-1", "runner", PROJECT, "issue-1", LEAD_ID);
		const id = db.insertQuestion("exec-1", LEAD_ID, "review?");
		db.close();
		return id;
	}

	function start(): void {
		const app = express();
		app.use(express.json());
		app.use(
			"/api/founder-routing/runner-response",
			createFounderRoutingResponseRouter({
				getThreadById: (threadId) =>
					threadId === "discord-thread"
						? {
								thread_id: threadId,
								issue_id: "issue-1",
								lead_id: LEAD_ID,
								session_role: "main",
							}
						: undefined,
				getSessionsByIssue: () => [{ project_name: PROJECT }],
				commDbPathForProject: () => commDbPath,
				leadLeaseEnv: env,
				leadWriteAuthorizationDeps: {
					processStart: () => "bridge-writer-start",
					processAliveWithStart: (pid: number, start: string) =>
						pid === 777 && start === "carrier-start",
				},
			}),
		);
		server = createServer(app);
		server.listen(0);
	}

	async function post(body: Record<string, unknown>) {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("not bound");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/founder-routing/runner-response`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	}

	function baseRequest(questionId: string): Record<string, unknown> {
		return {
			questionId,
			leadId: LEAD_ID,
			answer: "lease test",
			sourceThread: "discord-thread",
			expectedOwner: "exec-1",
			expectedCheckpoint: null,
			leaseClaim: { leaseKey: LEAD_KEY, generation: 1 },
			identityDigest: currentIdentityDigest,
			provenance: {
				writerPid: 999,
				writerStart: "cli-writer-start",
			},
		};
	}

	it("rejects a stale Lead generation before response or founder source-event writes", async () => {
		bindLease();
		const questionId = seedQuestion();
		start();

		const result = await post({
			...baseRequest(questionId),
			leaseClaim: { leaseKey: LEAD_KEY, generation: 99 },
		});
		expect(result.status).toBe(403);
		expect(result.body).toMatchObject({ error: "lead_write_unauthorized" });
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(questionId)).toBeUndefined();
		expect(db.listWorkflowSourceEvents()).toEqual([]);
		db.close();
	});

	it("validates and preserves the requester while storing authoritative provenance", async () => {
		bindLease();
		const questionId = seedQuestion();
		start();

		const result = await post(baseRequest(questionId));
		expect(result.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: LEAD_ID,
			sender_lease_key: LEAD_KEY,
			sender_generation: 1,
			sender_holder_pid: 222,
			sender_holder_start: "pane-start",
			writer_pid: 999,
			writer_start: "cli-writer-start",
		});
		// Feedback is not a founder approval source event; this test proves the
		// preserved Lead requester was authorized without minting founder authority.
		expect(db.listWorkflowSourceEvents()).toEqual([]);
		db.close();
	});

	it("allows the healthy Codex carrier and rejects a same-identity caller without its raw claim", async () => {
		writeProjects("codex-app-server");
		const rawClaim = "raw-carrier-capability";
		writeFileSync(
			env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
			JSON.stringify({
				schemaVersion: 1,
				collectedAt: new Date().toISOString(),
				leads: {
					[LEAD_KEY]: {
						leadKey: LEAD_KEY,
						backend: "codex-app-server",
						identityDigest: currentIdentityDigest,
						pid: 777,
						lstart: "carrier-start",
						instanceDigest: hashCarrierInstanceId(rawClaim),
					},
				},
			}),
		);
		const carrierQuestion = seedQuestion();
		start();
		const carrier = await post({
			...baseRequest(carrierQuestion),
			leaseClaim: undefined,
			carrierClaim: rawClaim,
		});
		expect(carrier.status).toBe(200);

		const intruderQuestion = seedQuestion();
		const intruder = await post({
			...baseRequest(intruderQuestion),
			leaseClaim: undefined,
			carrierClaim: undefined,
		});
		expect(intruder.status).toBe(403);
		expect(intruder.body).toMatchObject({ error: "lead_write_unauthorized" });
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(intruderQuestion)).toBeUndefined();
		const persisted = JSON.stringify({
			response: db.getResponse(carrierQuestion),
			events: db.listWorkflowSourceEvents(),
			evidence: readFileSync(env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!, "utf8"),
		});
		expect(persisted).not.toContain(rawClaim);
		db.close();
	});

	it.each(["wrong", "stale"] as const)(
		"rejects a %s Codex carrier claim before either durable write",
		async (fault) => {
			writeProjects("codex-app-server");
			const rawClaim = "raw-carrier-capability";
			writeFileSync(
				env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE!,
				JSON.stringify({
					schemaVersion: 1,
					collectedAt:
						fault === "stale"
							? new Date(Date.now() - 91_000).toISOString()
							: new Date().toISOString(),
					leads: {
						[LEAD_KEY]: {
							leadKey: LEAD_KEY,
							backend: "codex-app-server",
							identityDigest: currentIdentityDigest,
							pid: 777,
							lstart: "carrier-start",
							instanceDigest: hashCarrierInstanceId(
								fault === "wrong" ? "different-capability" : rawClaim,
							),
						},
					},
				}),
			);
			const questionId = seedQuestion();
			start();
			const result = await post({
				...baseRequest(questionId),
				leaseClaim: undefined,
				carrierClaim: rawClaim,
			});
			expect(result.status).toBe(403);
			expect(result.body).toMatchObject({ error: "lead_write_unauthorized" });
			const db = new CommDB(commDbPath, false);
			expect(db.getResponse(questionId)).toBeUndefined();
			expect(db.listWorkflowSourceEvents()).toEqual([]);
			db.close();
		},
	);

	it("audit_only keeps an old CLI compatible but records its missing Codex claim", async () => {
		writeProjects("codex-app-server");
		new LeadLeaseModeStore(env.FLYWHEEL_LEAD_LEASE_MODE_FILE!, env).set(
			"audit_only",
			"test",
		);
		const questionId = seedQuestion();
		start();

		const result = await post({
			...baseRequest(questionId),
			leaseClaim: undefined,
			carrierClaim: undefined,
		});
		expect(result.status).toBe(200);
		const db = new CommDB(commDbPath, false);
		expect(db.getResponse(questionId)).toMatchObject({
			from_agent: LEAD_ID,
			writer_pid: 999,
			writer_start: "cli-writer-start",
		});
		db.close();
		const lease = new LeadLeaseStore(env.FLYWHEEL_LEAD_LEASE_DB!);
		expect(lease.listPendingAudit()).toEqual([
			expect.objectContaining({
				event: "would_block",
				detail: expect.stringContaining("backend_drift"),
			}),
		]);
		lease.close();
	});
});

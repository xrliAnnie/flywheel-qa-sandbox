/**
 * GEO-151 A2 — handleProofShotAutoTrigger tests.
 *
 * Covers AC2 (mailbox writeVerified + commdb fallback shape),
 * AC4 (stage filter), AC14 (dedup + stale TTL recovery + cross-restart),
 * AC15 (single deliver + write-failure → markRunFailed), AC16 (kill switch
 * + no-vision label keeps capture).
 *
 * Uses StateStore in-memory + mocked MailboxTransport so we never touch the
 * real transport (which requires Agent Team env vars). The handler dynamically
 * imports `MailboxTransport`, so we use vi.doMock to intercept.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import { getProofShotParams } from "../bridge/proofshot-session.js";
import {
	buildProofShotDedupKey,
	handleProofShotAutoTrigger,
	PROOFSHOT_TTL_MS,
	type ProofShotTriggerEvent,
	renderProofShotInstruction,
} from "../bridge/proofshot-trigger.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "GeoForge3D",
		projectRoot: "/tmp/proofshot-geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "forum-ch-1",
				chatChannel: "chat-ch-1",
				match: { labels: ["Product"] },
			},
		],
	},
	{
		projectName: "flywheel",
		projectRoot: "/tmp/proofshot-flywheel",
		projectRepo: "xrliAnnie/Flywheel",
		leads: [
			{
				agentId: "lead-lead",
				chatChannel: "chat-ch-2",
				match: { labels: [] },
			},
		],
	},
];

function makeEvent(
	overrides: Partial<ProofShotTriggerEvent> = {},
): ProofShotTriggerEvent {
	return {
		execution_id: "exec-ps-1",
		issue_id: "issue-ps-1",
		project_name: "GeoForge3D",
		...overrides,
	};
}

async function seedSession(
	store: StateStore,
	execId: string,
	projectName: string,
	sessionParams?: Record<string, unknown>,
	labels?: string[],
): Promise<void> {
	store.upsertSession({
		execution_id: execId,
		issue_id: "issue-ps-1",
		project_name: projectName,
		status: "running",
		started_at: "2026-05-21T00:00:00",
		last_activity_at: "2026-05-21T00:00:00",
		heartbeat_at: "2026-05-21T00:00:00",
		issue_labels: labels ? JSON.stringify(labels) : undefined,
		session_role: "main",
	});
	if (sessionParams) {
		store.setSessionParams(execId, sessionParams);
	}
}

// Mock MailboxTransport — captures writeVerified args.
const mailboxWrites: Array<{
	leadName: string;
	recipient: string;
	payload: unknown;
}> = [];
let mailboxShouldThrow = false;

vi.mock("../mailbox/MailboxTransport.js", () => ({
	MailboxTransport: vi.fn().mockImplementation(() => ({
		writeVerified: vi.fn(async (args) => {
			if (mailboxShouldThrow) {
				throw new Error("simulated mailbox write failure");
			}
			mailboxWrites.push(args);
			return { flywheelId: "fake-id", idempotent: false, wroteAt: Date.now() };
		}),
	})),
}));

vi.mock("flywheel-agent-team-transport", () => ({
	AgentTeamTransportFactory: {
		fromEnv: vi.fn(() => ({})), // dummy transport
	},
}));

describe("handleProofShotAutoTrigger (GEO-151 A2)", () => {
	let store: StateStore;
	let tmpHome: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		mailboxWrites.length = 0;
		mailboxShouldThrow = false;
		store = await StateStore.create(":memory:");
		// Redirect HOME so commdb fallback writes to tmp.
		tmpHome = join(tmpdir(), `proofshot-trig-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpHome, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = tmpHome;
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
	});

	afterEach(() => {
		store.close();
		process.env.HOME = originalHome;
		delete process.env.FLYWHEEL_COMM_BACKEND;
		try {
			rmSync(tmpHome, { recursive: true, force: true });
		} catch {}
	});

	describe("AC16 — kill switch", () => {
		it("no-ops when proofshot config is missing (DEFAULT_PROOFSHOT_CONFIG enabled=false)", async () => {
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: { config: { enabled: false } },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(0);
			const params = store.getSessionParams("exec-ps-1");
			const proofs = getProofShotParams(params);
			expect(proofs.runs).toBeUndefined();
		});

		it("no-ops when session does not exist", async () => {
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(0);
		});

		it("with label 'no-vision' the instruction still triggers but Read step is omitted", async () => {
			await seedSession(
				store,
				"exec-ps-1",
				"GeoForge3D",
				{
					proofshot: {
						config: {
							enabled: true,
							dev_command: "pnpm dev",
							capture_stages: ["test"],
						},
					},
				},
				["no-vision"],
			);
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const payload = (mailboxWrites[0] as { payload: { content: string } })
				.payload;
			expect(payload.content).toContain("V1 vision 已被 label no-vision 关闭");
			expect(payload.content).not.toContain("Read tool (multimodal 自动解析)");
		});
	});

	describe("AC4 — stage filter", () => {
		it("skips when stage not in capture_stages", async () => {
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: { enabled: true, capture_stages: ["test", "pr_created"] },
				},
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"brainstorm", // not in capture_stages
			);
			expect(mailboxWrites).toHaveLength(0);
		});

		it("fires when stage matches capture_stages", async () => {
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: { enabled: true, capture_stages: ["test"] },
				},
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
		});

		it("uses DEFAULT_PROOFSHOT_CAPTURE_STAGES when config.capture_stages omitted", async () => {
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: { enabled: true /* capture_stages omitted */ },
				},
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"pr_created", // default includes pr_created
			);
			expect(mailboxWrites).toHaveLength(1);
		});
	});

	describe("AC2 — mailbox writeVerified shape", () => {
		it("calls writeVerified with real MailboxPayload shape {from,to,content,metadata}", async () => {
			await seedSession(store, "exec-ps-12345678", "GeoForge3D", {
				proofshot: { config: { enabled: true, capture_stages: ["test"] } },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent({ execution_id: "exec-ps-12345678" }),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const args = mailboxWrites[0] as {
				leadName: string;
				recipient: string;
				payload: {
					from: string;
					to: string;
					content: string;
					metadata: Record<string, unknown>;
				};
			};
			expect(args.leadName).toBe("product-lead");
			expect(args.recipient).toBe("runner-exec-ps-"); // first 8 of execId
			expect(args.payload.from).toBe("bridge");
			expect(args.payload.to).toBe("runner-exec-ps-");
			expect(args.payload.content).toContain("flywheel-comm visual-capture");
			expect(args.payload.metadata.flywheelId).toBe(
				"proofshot-exec-ps-12345678|test|ui-1",
			);
			expect(args.payload.metadata.dedupKey).toBe("exec-ps-12345678|test|ui");
			expect(args.payload.metadata.attempt).toBe(1);
			expect(args.payload.metadata.captureKind).toBe("ui");
			expect(args.payload.metadata.eventType).toBe("proofshot_auto_trigger");
		});

		it("commdb fallback writes via insertInstruction('bridge', execId, content)", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "commdb";
			await seedSession(store, "exec-ps-cdb", "GeoForge3D", {
				proofshot: { config: { enabled: true, capture_stages: ["test"] } },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent({ execution_id: "exec-ps-cdb" }),
				"test",
			);
			// No mailbox write
			expect(mailboxWrites).toHaveLength(0);
			// CommDB row written under the FLYWHEEL_COMM_DIR-isolated root (FLY-493:
			// resolve via the shared helper so it matches the Bridge write path).
			const dbPath = commDbPathForProject("GeoForge3D");
			const { CommDB } = await import("flywheel-comm/db");
			const db = new CommDB(dbPath);
			try {
				// Verify via the public getUnreadInstructions surface (uses to_agent=execId
				// per insertInstruction(fromAgent='bridge', toAgent=execId, content)).
				const rows = db.getUnreadInstructions("exec-ps-cdb");
				expect(rows).toHaveLength(1);
				expect(rows[0]?.from_agent).toBe("bridge");
				expect(rows[0]?.type).toBe("instruction");
				expect(rows[0]?.content).toContain("flywheel-comm visual-capture");
			} finally {
				db.close();
			}
		});
	});

	describe("AC14 — dedup + TTL stale recovery", () => {
		it("second call with same dedupKey is short-circuited (active pending)", async () => {
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: { config: { enabled: true, capture_stages: ["test"] } },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1); // second call no-op (pending within TTL)
		});

		it("completed run is permanently dedup'd", async () => {
			const dedupKey = buildProofShotDedupKey("exec-ps-1", "test", "ui");
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: { enabled: true, capture_stages: ["test"] },
					runs: {
						[dedupKey]: {
							state: "completed",
							dedupKey,
							attempt: 1,
							updatedAt: Date.now(),
							lastError: null,
						},
					},
				},
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(0);
		});

		it("stale pending (older than TTL) is retried with attempt+1", async () => {
			const dedupKey = buildProofShotDedupKey("exec-ps-1", "test", "ui");
			const staleUpdatedAt = Date.now() - (PROOFSHOT_TTL_MS + 10_000);
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: { enabled: true, capture_stages: ["test"] },
					runs: {
						[dedupKey]: {
							state: "pending",
							dedupKey,
							attempt: 1,
							updatedAt: staleUpdatedAt,
							lastError: null,
						},
					},
				},
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const args = mailboxWrites[0] as {
				payload: { metadata: { attempt: number } };
			};
			expect(args.payload.metadata.attempt).toBe(2);
		});

		it("failed run is allowed to retry immediately", async () => {
			const dedupKey = buildProofShotDedupKey("exec-ps-1", "test", "ui");
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: { enabled: true, capture_stages: ["test"] },
					runs: {
						[dedupKey]: {
							state: "failed",
							dedupKey,
							attempt: 1,
							updatedAt: Date.now(),
							lastError: "earlier write failed",
						},
					},
				},
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const args = mailboxWrites[0] as {
				payload: { metadata: { attempt: number } };
			};
			expect(args.payload.metadata.attempt).toBe(2);
		});
	});

	describe("AC15 — mailbox write failure → markRunFailed", () => {
		it("writeVerified throw → run state transitions to 'failed' with lastError", async () => {
			mailboxShouldThrow = true;
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: { config: { enabled: true, capture_stages: ["test"] } },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			const params = store.getSessionParams("exec-ps-1");
			const proofs = getProofShotParams(params);
			const dedupKey = buildProofShotDedupKey("exec-ps-1", "test", "ui");
			const run = proofs.runs?.[dedupKey];
			expect(run?.state).toBe("failed");
			expect(run?.lastError).toContain("simulated mailbox write failure");
			expect(run?.attempt).toBe(1);
		});

		it("after failed run, next handler call retries with attempt+1", async () => {
			mailboxShouldThrow = true;
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: { config: { enabled: true, capture_stages: ["test"] } },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			mailboxShouldThrow = false;
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const args = mailboxWrites[0] as {
				payload: { metadata: { attempt: number } };
			};
			expect(args.payload.metadata.attempt).toBe(2);
		});
	});

	describe("3D captureKind branch (Stage B preview)", () => {
		it("with GeoForge3D + last_artifact.model_path → captureKind='3d'", async () => {
			await seedSession(store, "exec-ps-1", "GeoForge3D", {
				proofshot: {
					config: {
						enabled: true,
						capture_stages: ["test"],
						model_viewer_url: "https://3dviewer.net",
						model_capture_angles: ["front", "side", "iso", "top"],
					},
				},
				last_artifact: { model_path: "/abs/path/model.glb" },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent(),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const args = mailboxWrites[0] as {
				payload: { metadata: { captureKind: string }; content: string };
			};
			expect(args.payload.metadata.captureKind).toBe("3d");
			expect(args.payload.content).toContain("--model-path");
			expect(args.payload.content).toContain("/abs/path/model.glb");
			expect(args.payload.content).toContain("https://3dviewer.net");
		});

		it("with non-GeoForge3D + model_path present → still captureKind='ui'", async () => {
			await seedSession(store, "exec-ps-2", "flywheel", {
				proofshot: {
					config: { enabled: true, capture_stages: ["test"] },
				},
				last_artifact: { model_path: "/abs/path/model.glb" },
			});
			await handleProofShotAutoTrigger(
				store,
				testProjects,
				makeEvent({
					execution_id: "exec-ps-2",
					project_name: "flywheel",
				}),
				"test",
			);
			expect(mailboxWrites).toHaveLength(1);
			const args = mailboxWrites[0] as {
				payload: { metadata: { captureKind: string } };
			};
			expect(args.payload.metadata.captureKind).toBe("ui");
		});
	});
});

describe("renderProofShotInstruction (GEO-151 A2)", () => {
	it("UI mode renders dedup-key/attempt/stage/dev-command CLI args (Codex R1 HIGH#1)", () => {
		const md = renderProofShotInstruction({
			stage: "test",
			cfg: { enabled: true, dev_command: "pnpm dev" },
			captureKind: "ui",
			attempt: 1,
			dedupKey: "exec-1|test|ui",
			execId: "exec-1",
			issueId: "issue-1",
			projectName: "GeoForge3D",
			visionEnabled: true,
			outputDir: "/abs/output",
		});
		expect(md).toContain('--dedup-key "exec-1|test|ui"');
		expect(md).toContain("--attempt 1");
		expect(md).toContain("--kind ui");
		expect(md).toContain("--stage test"); // R1 HIGH#1: required by visual-capture
		expect(md).toContain('--dev-command "pnpm dev"'); // R1 HIGH#1: required for UI
		expect(md).toContain('--output "/abs/output"');
		expect(md).toContain("flywheel-comm notify --paths-from");
		expect(md).toContain("Read tool"); // visionEnabled
	});

	it("UI mode falls back to 'pnpm dev' when cfg.dev_command unset", () => {
		const md = renderProofShotInstruction({
			stage: "test",
			cfg: { enabled: true }, // no dev_command
			captureKind: "ui",
			attempt: 1,
			dedupKey: "exec-1|test|ui",
			execId: "exec-1",
			issueId: "issue-1",
			projectName: "GeoForge3D",
			visionEnabled: true,
			outputDir: "/abs/output",
		});
		expect(md).toContain('--dev-command "pnpm dev"');
	});

	it("3D mode appends --model-path / --model-viewer-url / --angles (no --dev-command)", () => {
		const md = renderProofShotInstruction({
			stage: "test",
			cfg: { enabled: true },
			captureKind: "3d",
			attempt: 2,
			dedupKey: "exec-1|test|3d",
			execId: "exec-1",
			issueId: "issue-1",
			projectName: "GeoForge3D",
			visionEnabled: true,
			outputDir: "/abs/output",
			modelPath: "/abs/model.glb",
			modelViewerUrl: "https://3dviewer.net",
			angles: ["front", "side", "iso", "top"],
		});
		expect(md).toContain('--model-path "/abs/model.glb"');
		expect(md).toContain('--model-viewer-url "https://3dviewer.net"');
		expect(md).toContain('--angles "front,side,iso,top"');
		expect(md).toContain("--stage test"); // R1 HIGH#1: required for both UI + 3D
		expect(md).not.toContain("--dev-command"); // 3D doesn't need it
		expect(md).toContain("attempt=2");
	});

	it("visionEnabled=false swaps Read step for skipped note", () => {
		const md = renderProofShotInstruction({
			stage: "test",
			cfg: { enabled: true },
			captureKind: "ui",
			attempt: 1,
			dedupKey: "exec-1|test|ui",
			execId: "exec-1",
			issueId: "issue-1",
			projectName: "GeoForge3D",
			visionEnabled: false,
			outputDir: "/abs/output",
		});
		expect(md).not.toContain("Read tool (multimodal");
		expect(md).toContain("V1 vision 已被 label no-vision 关闭");
	});
});

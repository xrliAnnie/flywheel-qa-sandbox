/**
 * GEO-151 B8 / AC10 — 3D capture branch in handleProofShotAutoTrigger.
 *
 * The plan contract for AC10:
 *   GeoForge3D project + stage=test + Runner-provided
 *   session_params.last_artifact.model_path → Bridge handler injects 3D
 *   capture instruction (mailbox writeVerified with captureKind='3d',
 *   instruction template containing --model-path / --model-viewer-url /
 *   --angles).
 *
 * Stale-artifact protection is covered by artifact-event.test.ts (attempt
 * mismatch case). This file focuses on the 3D dispatch decision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleProofShotAutoTrigger } from "../bridge/proofshot-trigger.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const geoProjects: ProjectEntry[] = [
	{
		projectName: "GeoForge3D",
		projectRoot: "/tmp/geo-3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				chatChannel: "chat-ch-1",
				match: { labels: ["Product"] },
			},
		],
	},
	{
		projectName: "flywheel",
		projectRoot: "/tmp/fw",
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

const mailboxWrites: Array<{
	leadName: string;
	recipient: string;
	payload: {
		from: string;
		to: string;
		content: string;
		metadata?: Record<string, unknown>;
	};
}> = [];

vi.mock("../mailbox/MailboxTransport.js", () => ({
	MailboxTransport: vi.fn().mockImplementation(() => ({
		writeVerified: vi.fn(async (args) => {
			mailboxWrites.push(args);
			return {
				flywheelId: args.payload?.metadata?.flywheelId,
				idempotent: false,
				wroteAt: Date.now(),
			};
		}),
	})),
}));

vi.mock("flywheel-agent-team-transport", () => ({
	AgentTeamTransportFactory: { fromEnv: vi.fn(() => ({})) },
}));

describe("handleProofShotAutoTrigger — 3D branch (GEO-151 B8 / AC10)", () => {
	let store: StateStore;

	beforeEach(async () => {
		mailboxWrites.length = 0;
		store = await StateStore.create(":memory:");
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
	});

	afterEach(() => {
		store.close();
		delete process.env.FLYWHEEL_COMM_BACKEND;
	});

	function seed(
		execId: string,
		projectName: string,
		params: Record<string, unknown>,
	): void {
		store.upsertSession({
			execution_id: execId,
			issue_id: "issue-3d",
			project_name: projectName,
			status: "running",
			started_at: "2026-05-21T00:00:00",
			last_activity_at: "2026-05-21T00:00:00",
			heartbeat_at: "2026-05-21T00:00:00",
			session_role: "main",
		});
		store.setSessionParams(execId, params);
	}

	it("AC10 happy path: GeoForge3D + stage=test + last_artifact.model_path → 3D capture instruction", async () => {
		seed("exec-3d-1", "GeoForge3D", {
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
			geoProjects,
			{
				execution_id: "exec-3d-1",
				issue_id: "issue-3d",
				project_name: "GeoForge3D",
			},
			"test",
		);
		expect(mailboxWrites).toHaveLength(1);
		const args = mailboxWrites[0]!;
		const meta = args.payload.metadata!;
		expect(meta.captureKind).toBe("3d");
		expect(meta.dedupKey).toBe("exec-3d-1|test|3d");
		// Instruction template contains 3D-specific CLI args
		expect(args.payload.content).toContain("--kind 3d");
		expect(args.payload.content).toContain(
			'--model-path "/abs/path/model.glb"',
		);
		expect(args.payload.content).toContain(
			'--model-viewer-url "https://3dviewer.net"',
		);
		expect(args.payload.content).toContain('--angles "front,side,iso,top"');
	});

	it("non-GeoForge3D project + last_artifact present → captureKind stays 'ui' (not 3d)", async () => {
		seed("exec-fw-1", "flywheel", {
			proofshot: {
				config: { enabled: true, capture_stages: ["test"] },
			},
			last_artifact: { model_path: "/abs/path/model.glb" },
		});
		await handleProofShotAutoTrigger(
			store,
			geoProjects,
			{
				execution_id: "exec-fw-1",
				issue_id: "issue-3d",
				project_name: "flywheel",
			},
			"test",
		);
		expect(mailboxWrites).toHaveLength(1);
		const meta = mailboxWrites[0]!.payload.metadata!;
		expect(meta.captureKind).toBe("ui");
		expect(meta.dedupKey).toBe("exec-fw-1|test|ui");
		expect(mailboxWrites[0]!.payload.content).not.toContain("--model-path");
	});

	it("GeoForge3D + capture_stages=[test] but no last_artifact → captureKind='ui' (no 3D fallback)", async () => {
		seed("exec-3d-2", "GeoForge3D", {
			proofshot: {
				config: { enabled: true, capture_stages: ["test"] },
			},
			// no last_artifact
		});
		await handleProofShotAutoTrigger(
			store,
			geoProjects,
			{
				execution_id: "exec-3d-2",
				issue_id: "issue-3d",
				project_name: "GeoForge3D",
			},
			"test",
		);
		expect(mailboxWrites).toHaveLength(1);
		const meta = mailboxWrites[0]!.payload.metadata!;
		expect(meta.captureKind).toBe("ui");
	});

	it("3D and UI dedup keys are independent — both can fire in same session", async () => {
		// First fire: no last_artifact → ui capture.
		seed("exec-3d-3", "GeoForge3D", {
			proofshot: { config: { enabled: true, capture_stages: ["test"] } },
		});
		await handleProofShotAutoTrigger(
			store,
			geoProjects,
			{
				execution_id: "exec-3d-3",
				issue_id: "issue-3d",
				project_name: "GeoForge3D",
			},
			"test",
		);
		expect(mailboxWrites).toHaveLength(1);
		expect(mailboxWrites[0]!.payload.metadata!.captureKind).toBe("ui");

		// Now Runner registers an artifact. Update session_params + re-trigger.
		const cur = store.getSessionParams("exec-3d-3") ?? {};
		store.setSessionParams("exec-3d-3", {
			...cur,
			last_artifact: { model_path: "/abs/m.glb" },
		});
		await handleProofShotAutoTrigger(
			store,
			geoProjects,
			{
				execution_id: "exec-3d-3",
				issue_id: "issue-3d",
				project_name: "GeoForge3D",
			},
			"test",
		);
		// Second write happens because dedupKey is different (ui vs 3d).
		expect(mailboxWrites).toHaveLength(2);
		expect(mailboxWrites[1]!.payload.metadata!.captureKind).toBe("3d");
	});
});

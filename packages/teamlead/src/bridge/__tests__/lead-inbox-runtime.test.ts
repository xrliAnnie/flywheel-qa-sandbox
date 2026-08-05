import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	LeadInboxRuntime,
	resolveCodexLeadStateDir,
} from "../lead-inbox-runtime.js";
import type { LeadRuntime } from "../lead-runtime.js";
import { RuntimeRegistry } from "../runtime-registry.js";

const runtimes: LeadInboxRuntime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
});

const projects: ProjectEntry[] = [
	{
		projectName: "project-a",
		projectRoot: "/tmp/project-a",
		leads: [
			{
				agentId: "lead-a",
				chatChannel: "chat-a",
				match: { labels: ["Engineering"] },
			},
		],
	},
];

describe("LeadInboxRuntime", () => {
	it("connects the registry producer seam to a live per-Lead loop", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1373-runtime-"));
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "rendered",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const delivered = vi.fn(async (batch) => ({
			batchId: batch.batchId,
			memberIds: batch.members.map(
				(member: { deliveryId: string }) => member.deliveryId,
			),
			status: "accepted_new" as const,
		}));
		const store = {
			getActiveSessions: () => [],
			markLeadEventDelivered: vi.fn(),
		};
		const runtime = new LeadInboxRuntime({
			projects,
			store: store as never,
			registry,
			commDbPathForProject: (project) => join(root, `${project}.db`),
			ownerEpoch: "owner-1",
			adapterForLead: () => ({ deliverBatch: delivered }),
			runLegacyCutover: vi.fn(),
		});
		runtimes.push(runtime);
		registry.setLeadEventEnqueuer((envelope, content) =>
			runtime.enqueueLeadEvent(envelope, content),
		);
		registry.setLeadInboxNudge((leadId, projectName) =>
			runtime.nudge(leadId, projectName),
		);
		runtime.start();
		registry.enqueueLeadEvent({
			seq: 9,
			eventId: "event-9",
			event: { event_type: "session_completed" },
			sessionKey: "exec-9",
			leadId: "lead-a",
			timestamp: new Date().toISOString(),
		});
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
		expect(store.markLeadEventDelivered).toHaveBeenCalledWith(9);
		expect(registry.nudgeLeadInbox("lead-a", "project-a")).toBe(true);
	});

	it("prefers an existing legacy Codex state dir, otherwise uses injective identity", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1373-state-dir-"));
		mkdirSync(join(root, "lead-a"));
		expect(resolveCodexLeadStateDir("project-a", "lead-a", root)).toBe(
			join(root, "lead-a"),
		);
		const generated = resolveCodexLeadStateDir("project/x", "lead y", root);
		expect(generated).toContain("project_x__lead_y-");
		expect(generated).toContain(
			Buffer.from("project/x\u001flead y").toString("hex"),
		);
	});

	it("runs one project-level Runner lane on the existing Lead cadence", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1572-runner-runtime-"));
		const dbPath = join(root, "project-a.db");
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"session:window",
			"project-a",
			"FLY-1572",
			"lead-a",
			"claude-code",
		);
		db.insertInstruction("lead-a", "exec-1", "continue");
		db.close();
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "rendered",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const deliver = vi.fn(async () => ({ status: "delivered" as const }));
		const runtime = new LeadInboxRuntime({
			projects,
			store: { getActiveSessions: () => [] } as never,
			registry,
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				deliverBatch: vi.fn(async (batch) => ({
					batchId: batch.batchId,
					memberIds: batch.members.map((member) => member.deliveryId),
					status: "accepted_new" as const,
				})),
			}),
			runnerAdapterForProject: () => ({
				deliver,
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
		expect(deliver.mock.calls[0]?.[0]).toMatchObject({
			executionId: "exec-1",
			fromAgent: "lead-a",
			content: expect.stringContaining("continue"),
		});
	});

	it("clears a rejected cutover promise so a later doorbell retries it", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1373-runtime-retry-"));
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "rendered",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const cutover = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("transient cutover failure"))
			.mockResolvedValue(undefined);
		const runtime = new LeadInboxRuntime({
			projects,
			store: { getActiveSessions: () => [] } as never,
			registry,
			commDbPathForProject: (project) => join(root, `${project}.db`),
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				deliverBatch: vi.fn(async () => {
					throw new Error("unexpected delivery");
				}),
			}),
			runLegacyCutover: cutover,
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(cutover).toHaveBeenCalledTimes(1));
		runtime.nudge("lead-a", "project-a");
		await vi.waitFor(() => expect(cutover).toHaveBeenCalledTimes(2));
	});
});

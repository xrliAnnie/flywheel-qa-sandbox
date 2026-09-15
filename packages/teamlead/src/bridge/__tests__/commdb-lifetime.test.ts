import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { CommDBLeadRuntime } from "../commdb-lead-runtime.js";
import {
	LeadInboxRuntime,
	type LeadInboxRuntimeOptions,
} from "../lead-inbox-runtime.js";
import type { LeadEventEnvelope } from "../lead-runtime.js";
import { RuntimeRegistry } from "../runtime-registry.js";

function fdCount() {
	const path = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
	return readdirSync(path).filter((name) => /^\d+$/.test(name)).length;
}

const projects: ProjectEntry[] = [0, 1].map((index) => ({
	projectName: `project-${index}`,
	projectRoot: `/tmp/project-${index}`,
	leads: [
		{
			agentId: `lead-${index}`,
			summaryRole: "producer",
			chatChannel: `chat-${index}`,
			match: { labels: [] },
		},
	],
}));

describe("CommDB runtime ownership", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2563-lifetime-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	function options(): LeadInboxRuntimeOptions {
		return {
			projects,
			store: {} as LeadInboxRuntimeOptions["store"],
			registry: new RuntimeRegistry(),
			commDbPathForProject: (name) => join(root, name, "comm.db"),
			adapterForLead: () => ({
				deliverBatch: async () => {
					throw new Error("unused transport");
				},
			}),
		};
	}
	it("closes initialized project owners when a later transport constructor throws", () => {
		const baseline = fdCount();
		expect(
			() =>
				new LeadInboxRuntime({
					...options(),
					adapterForLead: (project) => {
						if (project.projectName === "project-1")
							throw new Error("adapter construction failed");
						return {
							deliverBatch: async () => {
								throw new Error("unused transport");
							},
						};
					},
				}),
		).toThrow("adapter construction failed");
		expect(fdCount()).toBeLessThanOrEqual(baseline);
	});
	it("keeps idle production mailbox owners within six fds per project and closes twice", () => {
		const baseline = fdCount();
		const runtime = new LeadInboxRuntime(options());
		try {
			expect(fdCount() - baseline).toBeLessThanOrEqual(6 * projects.length);
		} finally {
			runtime.close();
			runtime.close();
		}
		expect(fdCount()).toBeLessThanOrEqual(baseline);
	});
	it("keeps default mailbox owners within six fds per project after question validation", async () => {
		const baseline = fdCount();
		const runtime = new LeadInboxRuntime(options());
		try {
			const admissions = (
				runtime as unknown as {
					admissions: Array<{ revalidate(row: unknown): Promise<unknown> }>;
				}
			).admissions;
			for (const [index, admission] of admissions.entries()) {
				await admission.revalidate({
					type: "question",
					recipient_kind: "lead",
					delivery_id: `question:lead-${index}:missing`,
					to_agent: `lead-${index}`,
					id: "missing",
					expires_at: new Date(Date.now() + 86400000).toISOString(),
				});
			}
			expect(fdCount() - baseline).toBeLessThanOrEqual(6 * projects.length);
		} finally {
			runtime.close();
		}
		expect(fdCount()).toBeLessThanOrEqual(baseline);
	});

	it("keeps legacy delivery handles constant across repeated sends and closes twice", async () => {
		const baseline = fdCount();
		const runtimes = projects.map(
			(p) =>
				new CommDBLeadRuntime(
					join(root, p.projectName, "comm.db"),
					p.leads[0]!.agentId,
				),
		);
		const steady = fdCount();
		try {
			for (let i = 0; i < 100; i++) {
				for (const [index, runtime] of runtimes.entries()) {
					const envelope = {
						seq: i + 1,
						leadId: projects[index]!.leads[0]!.agentId,
						sessionKey: `project-${index}:FLY-2563`,
						timestamp: new Date().toISOString(),
						event: {
							event_type: "session_started",
							execution_id: "execution",
							issue_id: "FLY-2563",
							issue_identifier: "FLY-2563",
							issue_title: "lifetime",
							status: "running",
						},
					} as LeadEventEnvelope;
					expect((await runtime.deliver(envelope)).delivered).toBe(true);
				}
				expect(fdCount()).toBe(steady);
			}
		} finally {
			for (const runtime of runtimes) {
				await runtime.shutdown();
				await runtime.shutdown();
			}
		}
		expect(fdCount()).toBeLessThanOrEqual(baseline);
	});
});

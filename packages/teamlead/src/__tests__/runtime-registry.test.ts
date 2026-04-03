import { describe, expect, it, vi } from "vitest";
import type { LeadRuntime } from "../bridge/lead-runtime.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";

function makeLead(overrides?: Partial<LeadConfig>): LeadConfig {
	return {
		agentId: "product-lead",
		forumChannel: "forum-1",
		chatChannel: "chat-1",
		match: { labels: ["Product"] },
		...overrides,
	};
}

function makeRuntime(
	type: "openclaw" | "claude-discord" = "openclaw",
): LeadRuntime {
	return {
		type,
		deliver: vi.fn().mockResolvedValue({ delivered: true }),
		sendBootstrap: vi.fn().mockResolvedValue(undefined),
		health: vi.fn().mockResolvedValue({
			status: "healthy",
			lastDeliveryAt: null,
			lastDeliveredSeq: 0,
		}),
		shutdown: vi.fn().mockResolvedValue(undefined),
	};
}

const projects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		leads: [
			makeLead({ agentId: "product-lead", match: { labels: ["Product"] } }),
			makeLead({ agentId: "ops-lead", match: { labels: ["Operations"] } }),
		],
	},
];

describe("RuntimeRegistry", () => {
	it("register + getForLead", () => {
		const reg = new RuntimeRegistry();
		const lead = makeLead();
		const rt = makeRuntime();
		reg.register(lead, rt);

		expect(reg.getForLead("product-lead")).toBe(rt);
		expect(reg.getForLead("unknown")).toBeUndefined();
		expect(reg.size).toBe(1);
	});

	it("resolve() finds runtime by project + labels", () => {
		const reg = new RuntimeRegistry();
		const productRt = makeRuntime("openclaw");
		const opsRt = makeRuntime("claude-discord");
		reg.register(
			makeLead({ agentId: "product-lead", match: { labels: ["Product"] } }),
			productRt,
		);
		reg.register(
			makeLead({ agentId: "ops-lead", match: { labels: ["Operations"] } }),
			opsRt,
		);

		expect(reg.resolve(projects, "geoforge3d", ["Product"])).toBe(productRt);
		expect(reg.resolve(projects, "geoforge3d", ["Operations"])).toBe(opsRt);
	});

	it("resolve() throws for unregistered lead", () => {
		const reg = new RuntimeRegistry();
		// product-lead exists in projects but not registered
		expect(() => reg.resolve(projects, "geoforge3d", ["Product"])).toThrow(
			/No runtime registered/,
		);
	});

	it("resolveWithLead() returns runtime + lead config", () => {
		const reg = new RuntimeRegistry();
		const rt = makeRuntime();
		reg.register(
			makeLead({ agentId: "product-lead", match: { labels: ["Product"] } }),
			rt,
		);

		const result = reg.resolveWithLead(projects, "geoforge3d", ["Product"]);
		expect(result.runtime).toBe(rt);
		expect(result.lead.agentId).toBe("product-lead");
	});

	it("shutdownAll() calls shutdown on all runtimes", async () => {
		const reg = new RuntimeRegistry();
		const rt1 = makeRuntime();
		const rt2 = makeRuntime();
		reg.register(makeLead({ agentId: "product-lead" }), rt1);
		reg.register(makeLead({ agentId: "ops-lead" }), rt2);

		await reg.shutdownAll();
		expect(rt1.shutdown).toHaveBeenCalledOnce();
		expect(rt2.shutdown).toHaveBeenCalledOnce();
	});
});

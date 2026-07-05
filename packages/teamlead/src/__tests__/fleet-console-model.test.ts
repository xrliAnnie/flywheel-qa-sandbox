import { describe, expect, it } from "vitest";
import {
	buildConsoleLeadView,
	buildConsoleSnapshot,
	FORBIDDEN_DTO_KEYS,
} from "../bridge/fleet-console-model.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";

function lead(overrides: Partial<LeadConfig> = {}): LeadConfig {
	return {
		agentId: "product-lead",
		chatChannel: "222",
		match: { labels: ["Product"] },
		canSpawnRunners: true,
		...overrides,
	};
}

/** Production-shaped fixture: 7 Leads, only Mufasa carries an explicit backend
 *  (the deploy-time migration); the rest have NO explicit model/backend. */
function prodProjects(): ProjectEntry[] {
	const L = (agentId: string, o: Partial<LeadConfig> = {}): LeadConfig => ({
		agentId,
		chatChannel: "1",
		match: { labels: ["X"] },
		canSpawnRunners: true,
		...o,
	});
	return [
		{
			projectName: "geoforge3d",
			projectRoot: "/tmp/g",
			leads: [L("peter"), L("oliver"), L("simba")],
		},
		{ projectName: "sub", projectRoot: "/tmp/s", leads: [L("asha")] },
		{ projectName: "joycon", projectRoot: "/tmp/j", leads: [L("hiro")] },
		{
			projectName: "personal-assistant",
			projectRoot: "/tmp/p",
			leads: [
				L("belle", { companion: true, canSpawnRunners: false }),
				// Mufasa after the deploy-time backend migration (companion codex).
				L("mufasa", {
					companion: true,
					canSpawnRunners: false,
					backend: "codex-app-server",
				}),
			],
		},
	];
}

describe("fleet-console-model — buildConsoleSnapshot (R5 #1: default-off gate)", () => {
	it("returns ALL leads even when none has explicit model/backend (no empty console)", () => {
		const snap = buildConsoleSnapshot([
			{ projectName: "geo", projectRoot: "/tmp", leads: [lead()] },
		]);
		expect(snap.leads).toHaveLength(1);
		expect(snap.leads[0]!.leadId).toBe("product-lead");
	});

	it("production-shaped 7-Lead fixture → all 7 cards render", () => {
		const snap = buildConsoleSnapshot(prodProjects());
		expect(snap.leads).toHaveLength(7);
		expect(snap.leads.map((l) => l.leadId).sort()).toEqual(
			["asha", "belle", "hiro", "mufasa", "oliver", "peter", "simba"].sort(),
		);
	});

	it("Lead with no model → account-default tier shown (Opus 4.8), id null", () => {
		const snap = buildConsoleSnapshot([
			{ projectName: "geo", projectRoot: "/tmp", leads: [lead()] },
		]);
		expect(snap.leads[0]!.currentModelId).toBeNull();
		expect(snap.leads[0]!.currentModelLabel).toBe("Opus 4.8");
	});

	it("Lead with model=claude-fable-5 → 'Fable 5' label", () => {
		const view = buildConsoleLeadView("geo", lead({ model: "claude-fable-5" }));
		expect(view.currentModelId).toBe("claude-fable-5");
		expect(view.currentModelLabel).toBe("Fable 5");
	});

	it("FLY-360: Lead with model=claude-opus-4-8[1m] → 'Opus 4.8 (1M)' label, id preserved", () => {
		const view = buildConsoleLeadView(
			"geo",
			lead({ model: "claude-opus-4-8[1m]" }),
		);
		expect(view.currentModelId).toBe("claude-opus-4-8[1m]");
		expect(view.currentModelLabel).toBe("Opus 4.8 (1M)");
	});

	it("migrated Mufasa → Codex backend, GPT-5 read-only, only-null model target", () => {
		const snap = buildConsoleSnapshot(prodProjects());
		const mufasa = snap.leads.find((l) => l.leadId === "mufasa")!;
		expect(mufasa.currentBackend).toBe("codex-app-server");
		expect(mufasa.currentModelLabel).toBe("GPT-5");
		expect(mufasa.allowedModelTargets).toEqual([null]);
		expect(mufasa.tierOptions[0]!.readonly).toBe(true);
	});
});

describe("fleet-console-model — secret-free DTO (R6 #3)", () => {
	it("never exposes botToken / botTokenEnv / match (no LeadConfig leak)", () => {
		const view = buildConsoleLeadView(
			"geo",
			lead({ botTokenEnv: "PETER_BOT_TOKEN", botToken: "leaked-secret" }),
		);
		for (const forbidden of FORBIDDEN_DTO_KEYS) {
			expect(Object.keys(view)).not.toContain(forbidden);
		}
		// canary: the secret string must not appear anywhere in the serialized DTO
		expect(JSON.stringify(view)).not.toContain("leaked-secret");
		expect(JSON.stringify(view)).not.toContain("PETER_BOT_TOKEN");
	});
});

describe("fleet-console-model — legacy backend resolution", () => {
	it("uses legacyBackendOf only when lead.backend is unset", () => {
		const projects: ProjectEntry[] = [
			{ projectName: "geo", projectRoot: "/tmp", leads: [lead()] },
		];
		const snap = buildConsoleSnapshot(projects, () => "codex-app-server");
		expect(snap.leads[0]!.currentBackend).toBe("codex-app-server");
		expect(snap.leads[0]!.backendSource).toBe("legacy");
	});
});

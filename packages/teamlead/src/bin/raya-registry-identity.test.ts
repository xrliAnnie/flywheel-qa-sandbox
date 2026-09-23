import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	rayaRegistryIdentity,
	rayaRegistryIdentityDrift,
	rayaRegistryIdentityEqual,
} from "./raya-registry-identity.js";

const JQ_FILTER = resolve(
	import.meta.dirname,
	"../../../../scripts/lib/raya-registry-identity.jq",
);

const rayaLead = {
	agentId: "raya",
	botUserId: "223456789012345678",
	botTokenEnv: "RAYA_BOT_TOKEN",
	chatChannel: "123456789012345678",
	alertChannel: "123456789012345678",
	backend: "codex-app-server",
	model: "gpt-5.4",
	effort: "high",
	modelContextWindow: 400000,
	summaryRole: "producer",
	match: { labels: ["Raya"] },
};
const registry = [
	{
		projectName: "flywheel",
		projectRoot: "/Users/test/Dev/flywheel",
		leads: [
			{ agentId: "flywheel-cos-lead", backend: "claude-code", effort: "high" },
			{ agentId: "flywheel-eng-lead", backend: "codex-app-server" },
		],
	},
	{
		projectName: "raya",
		projectRoot: "/Users/test/Dev/raya-lead-workspace",
		projectRepo: "xrliAnnie/raya",
		generalChannel: "923456789012345678",
		leads: [{ agentId: "raya-helper", backend: "claude-code" }, rayaLead],
	},
];

function jq(value: unknown): unknown {
	return JSON.parse(
		execFileSync("jq", ["-c", "-f", JQ_FILTER], {
			input: JSON.stringify(value),
			encoding: "utf8",
		}),
	);
}

describe("raya registry identity projection", () => {
	it("keeps only Raya's project and lead rows without runtime tuning", () => {
		const projection = rayaRegistryIdentity(registry);
		expect(projection).toEqual([
			{
				projectName: "raya",
				projectRoot: "/Users/test/Dev/raya-lead-workspace",
				projectRepo: "xrliAnnie/raya",
				generalChannel: "923456789012345678",
				leads: [
					{
						agentId: "raya",
						botUserId: "223456789012345678",
						botTokenEnv: "RAYA_BOT_TOKEN",
						chatChannel: "123456789012345678",
						alertChannel: "123456789012345678",
						backend: "codex-app-server",
						summaryRole: "producer",
						match: { labels: ["Raya"] },
					},
				],
			},
		]);
		expect(rayaRegistryIdentity({})).toEqual([]);
		expect(rayaRegistryIdentity([{ projectName: "flywheel" }])).toEqual([]);
		expect(rayaRegistryIdentity([{ projectName: "raya" }])).toEqual([
			{ projectName: "raya", leads: [] },
		]);
	});

	it("ignores unrelated Lead edits, new Leads, key order, and Raya tuning", () => {
		const base = rayaRegistryIdentity(registry);
		const unrelatedEffort = structuredClone(registry);
		(unrelatedEffort[0]!.leads[0] as { effort: string }).effort = "medium";
		const newLead = structuredClone(registry);
		newLead[0]!.leads.push({
			agentId: "flywheel-new-lead",
			backend: "claude-code",
		});
		const reordered = JSON.parse(
			JSON.stringify(registry, (_, value) =>
				value && typeof value === "object" && !Array.isArray(value)
					? Object.fromEntries(Object.entries(value).reverse())
					: value,
			),
		);
		const rayaTuning = structuredClone(registry);
		(rayaTuning[1]!.leads[1] as { effort: string }).effort = "medium";
		(rayaTuning[1]!.leads[1] as { model: string }).model = "gpt-5.5";
		for (const variant of [unrelatedEffort, newLead, reordered, rayaTuning]) {
			expect(
				rayaRegistryIdentityEqual(base, rayaRegistryIdentity(variant)),
			).toBe(true);
			expect(
				rayaRegistryIdentityDrift(base, rayaRegistryIdentity(variant)),
			).toEqual([]);
		}
	});

	it("names every changed Raya identity field", () => {
		const base = rayaRegistryIdentity(registry);
		const botChanged = structuredClone(registry);
		(botChanged[1]!.leads[1] as { botUserId: string }).botUserId =
			"323456789012345678";
		expect(
			rayaRegistryIdentityEqual(base, rayaRegistryIdentity(botChanged)),
		).toBe(false);
		expect(
			rayaRegistryIdentityDrift(base, rayaRegistryIdentity(botChanged)),
		).toEqual(["0.leads.0.botUserId"]);
		const carrierChanged = structuredClone(registry);
		(carrierChanged[1]!.leads[1] as { backend: string }).backend =
			"claude-code";
		carrierChanged[1]!.projectRoot = "/Users/test/elsewhere";
		expect(
			rayaRegistryIdentityDrift(base, rayaRegistryIdentity(carrierChanged)),
		).toEqual(["0.leads.0.backend", "0.projectRoot"]);
		const removed = structuredClone(registry);
		removed[1]!.leads.pop();
		expect(
			rayaRegistryIdentityDrift(base, rayaRegistryIdentity(removed)),
		).toEqual([
			"0.leads.0.agentId",
			"0.leads.0.alertChannel",
			"0.leads.0.backend",
			"0.leads.0.botTokenEnv",
			"0.leads.0.botUserId",
			"0.leads.0.chatChannel",
			"0.leads.0.match.labels.0",
			"0.leads.0.summaryRole",
		]);
	});

	it("matches the jq projection the shuttle uses byte-for-byte in meaning", () => {
		const fixtures: unknown[] = [
			registry,
			[],
			{},
			"not-a-registry",
			[{ projectName: "raya" }],
			[{ projectName: "raya", leads: "broken" }],
			[{ projectName: "raya", leads: [{ agentId: "raya", model: "x" }, 7] }],
			[{ projectName: "raya", leads: [], 中文: "值\n\t\u001f" }],
		];
		for (const fixture of fixtures) {
			expect(jq(fixture), JSON.stringify(fixture)).toEqual(
				rayaRegistryIdentity(fixture),
			);
			expect(
				rayaRegistryIdentityEqual(jq(fixture), rayaRegistryIdentity(fixture)),
			).toBe(true);
		}
	});
});

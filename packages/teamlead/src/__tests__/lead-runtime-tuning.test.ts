import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { compileSummaryAssignments } from "flywheel-comm/summary-assignment";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { getModelConfigSnapshot } from "flywheel-config";
import { afterEach, expect, it } from "vitest";
import { planLeadConfigChange } from "../lead-config-plan.js";
import {
	readLeadRuntimeSource,
	readLeadRuntimeTuning,
} from "../lead-runtime-tuning.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "lead-config-write-"));
	roots.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-09-16T00:00:00Z",
		}),
	);
	const projectsPath = join(home, "projects.json"),
		receiptPath = join(home, "receipt.json");
	const raw = [
		{
			projectName: "raya",
			projectRoot: home,
			leads: [
				{
					agentId: "raya",
					summaryRole: "producer",
					backend: "codex-app-server",
					botTokenEnv: "RAYA_BOT_TOKEN",
					botUserId: "12345678901234567",
					chatChannel: "12345678901234568",
					match: { labels: ["Engineering"] },
					codexProfile: "full-access",
					canSpawnRunners: true,
					codexRunnerActions: true,
					model: "gpt-6-astra",
					effort: "low",
				},
			],
		},
	];
	const source = JSON.stringify(raw);
	writeFileSync(projectsPath, source);
	const summaryAssignmentDigest = compileSummaryAssignments(
		raw,
		readSummaryGranularity({ homeDir: home }),
	).digest;
	writeFileSync(
		receiptPath,
		JSON.stringify({
			schemaVersion: 1,
			postImageSha256: createHash("sha256").update(source).digest("hex"),
			summaryAssignmentDigest,
			granularity: "per-lead",
			migratedAt: "2026-09-16T00:00:00Z",
			assignments: [
				{ projectName: "raya", leadId: "raya", summaryRole: "producer" },
			],
			projectAggregators: [],
		}),
	);

	const identity = resolveLeadIdentityRow({
		projectsPath,
		projectName: "raya",
		leadId: "raya",
		homeDir: home,
	}).identity;
	const config = {
		projectsFile: projectsPath,
		projectName: "raya",
		leadId: "raya",
		leadKey: identity.leadKey,
		identityDigest: identity.identityDigest,
		botUserId: identity.botUserId!,
		modelContextWindow: identity.modelContextWindow,
	};
	return {
		config,
		options: { home, receiptPath },
		raw,
		save: () => writeFileSync(projectsPath, JSON.stringify(raw)),
	};
}
it("reads new registry tuning with the unchanged FLY-2602 receipt, never launch values", () => {
	const f = fixture();
	expect(readLeadRuntimeTuning(f.config, f.options)).toMatchObject({
		model: "gpt-6-astra",
		reasoningEffort: "low",
	});
	f.raw[0]!.leads[0]!.effort = "high";
	f.save();
	expect(readLeadRuntimeTuning(f.config, f.options)).toMatchObject({
		model: "gpt-6-astra",
		reasoningEffort: "high",
	});
});
it("clears removed model and effort instead of resurrecting launch environment", () => {
	const f = fixture();
	const lead = f.raw[0]!.leads[0]! as Record<string, unknown>;
	delete lead.model;
	delete lead.effort;
	f.save();
	const result = readLeadRuntimeTuning(f.config, f.options);
	expect(result).toHaveProperty("model", undefined);
	expect(result).toHaveProperty("reasoningEffort", undefined);
});
it("keeps an explicit effort when the registry leaves the runtime model implicit", () => {
	const f = fixture();
	const lead = f.raw[0]!.leads[0]! as Record<string, unknown>;
	delete lead.model;
	lead.effort = "high";
	f.save();
	const result = readLeadRuntimeTuning(f.config, f.options);
	expect(result).toHaveProperty("model", undefined);
	expect(result).toHaveProperty("reasoningEffort", "high");
});
it("fails closed for identity drift and context-window drift", () => {
	const f = fixture();
	f.raw[0]!.leads[0]!.botUserId = "22345678901234567";
	f.save();
	expect(() => readLeadRuntimeTuning(f.config, f.options)).toThrow();
	f.raw[0]!.leads[0]!.botUserId = f.config.botUserId;
	(f.raw[0]!.leads[0]! as Record<string, unknown>).modelContextWindow = 12345;
	f.save();
	expect(() => readLeadRuntimeTuning(f.config, f.options)).toThrow(
		"lead_runtime_identity_changed",
	);
});
it("rejects an unauthenticated source or an in-progress registry transaction", () => {
	const f = fixture();
	writeFileSync(`${f.options.receiptPath}.lead-registry-intent.json`, "{}");
	expect(() => readLeadRuntimeTuning(f.config, f.options)).toThrow(
		"lead_registry_recovery_required",
	);
	rmSync(`${f.options.receiptPath}.lead-registry-intent.json`);
	const receipt = JSON.parse(readFileSync(f.options.receiptPath, "utf8"));
	receipt.summaryAssignmentDigest = "0".repeat(64);
	writeFileSync(f.options.receiptPath, JSON.stringify(receipt));
	expect(() => readLeadRuntimeTuning(f.config, f.options)).toThrow();
});

it("binds native admission to the same config digest as the managed writer", () => {
	const f = fixture();
	const planned = planLeadConfigChange({
		source: JSON.stringify(f.raw),
		projectName: "raya",
		leadId: "raya",
		patch: { effort: "high" },
		modelSnapshot: getModelConfigSnapshot(),
		identityOptions: {
			homeDir: f.options.home,
			summarySelection: readSummaryGranularity({ homeDir: f.options.home }),
		},
	});
	f.raw[0]!.leads[0]!.effort = "high";
	f.save();
	expect(readLeadRuntimeSource(f.config, f.options)).toMatchObject({
		configDigest: planned.configDigest,
		modelRegistryRevision: planned.modelRegistryRevision,
	});
});

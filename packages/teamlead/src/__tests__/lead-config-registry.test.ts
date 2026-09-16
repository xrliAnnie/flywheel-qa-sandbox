import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSummaryAssignments } from "flywheel-comm/summary-assignment";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { getModelConfigSnapshot } from "flywheel-config";
import { afterEach, expect, it } from "vitest";
import { LeadConfigRegistryWriter } from "../lead-config-registry.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
async function fixture(hooks: { afterRename?: () => void } = {}) {
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
	const store = await StateStore.create(join(home, "teamlead.db"));
	stores.push(store);
	let modelSnapshot = getModelConfigSnapshot();
	const deps = {
		store,
		home,
		root: new URL("../../../../", import.meta.url).pathname,
		projectsPath,
		receiptPath,
		modelSnapshot: () => modelSnapshot,
		env: {},
		...hooks,
	};
	const writer = new LeadConfigRegistryWriter(deps);
	const input = {
		operationId: randomUUID(),
		projectName: "raya",
		leadId: "raya",
		patch: { effort: "high" },
		reason: "isolated hot config",
	};
	return {
		writer,
		deps,
		store,
		projectsPath,
		receiptPath,
		input,
		setModelRegistryRevision: (revision: string) => {
			modelSnapshot = { ...modelSnapshot, revision };
		},
	};
}
it(
	"commits under the shared lock without touching summary receipt and replays once",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		const receipt = readFileSync(f.receiptPath, "utf8");
		const intent = f.writer.plan(f.input);
		const result = await f.writer.commit(intent);
		expect(result.status).toBe("registry_committed");
		expect(
			JSON.parse(readFileSync(f.projectsPath, "utf8"))[0].leads[0].effort,
		).toBe("high");
		expect(readFileSync(f.receiptPath, "utf8")).toBe(receipt);
		expect((await f.writer.commit(intent)).configGeneration).toBe(
			result.configGeneration,
		);
		expect(f.store.listLeadConfigAudit(f.input.operationId)).toHaveLength(2);
	},
);
it(
	"rejects file CAS drift without overwriting a third-party edit",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		const intent = f.writer.plan(f.input);
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].note = "third party";
		const bytes = JSON.stringify(raw);
		writeFileSync(f.projectsPath, bytes);
		await expect(f.writer.commit(intent)).rejects.toThrow(
			"projects_source_changed",
		);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(bytes);
		expect(f.store.getLeadConfigOperation(f.input.operationId)?.status).toBe(
			"conflict",
		);
	},
);
it(
	"recovers a post-rename crash and preserves unrelated subsequent bytes",
	{ timeout: 20000 },
	async () => {
		const f = await fixture({
			afterRename: () => {
				throw new Error("simulated_crash");
			},
		});
		const intent = f.writer.plan(f.input);
		await expect(f.writer.commit(intent)).rejects.toThrow("simulated_crash");
		expect(f.store.getLeadConfigOperation(f.input.operationId)?.status).toBe(
			"prepared",
		);
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].note = "after crash";
		const bytes = JSON.stringify(raw);
		writeFileSync(f.projectsPath, bytes);
		const recovery = new LeadConfigRegistryWriter({
			...f.deps,
			afterRename: undefined,
		});
		expect((await recovery.recover(f.input.operationId)).status).toBe(
			"registry_committed",
		);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(bytes);
		expect(
			JSON.parse(
				f.store.listLeadConfigAudit(f.input.operationId).at(-1)!.detail,
			).rebased,
		).toBe(true);
	},
);
it(
	"classifies a conflicting target after rename without rewriting it",
	{ timeout: 20000 },
	async () => {
		const f = await fixture({
			afterRename: () => {
				throw new Error("simulated_crash");
			},
		});
		await expect(f.writer.commit(f.writer.plan(f.input))).rejects.toThrow(
			"simulated_crash",
		);
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].leads[0].effort = "medium";
		const bytes = JSON.stringify(raw);
		writeFileSync(f.projectsPath, bytes);
		expect((await f.writer.recover(f.input.operationId)).status).toBe(
			"conflict",
		);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(bytes);
	},
);
it(
	"rejects mismatched lock overrides before recording or writing",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		const writer = new LeadConfigRegistryWriter({
			...f.deps,
			env: { FLYWHEEL_CONFIG_LOCK_FILE: "/tmp/wrong-lock" },
		});
		expect(() => writer.plan(f.input)).toThrow("config_lock_path_conflict");
		expect(f.store.getLeadConfigOperation(f.input.operationId)).toBeNull();
	},
);

it(
	"recovers the same intent when an apply response is lost after rename",
	{ timeout: 20000 },
	async () => {
		const f = await fixture({
			afterRename: () => {
				throw new Error("simulated_crash");
			},
		});
		const intent = f.writer.plan(f.input);
		await expect(f.writer.commit(intent)).rejects.toThrow("simulated_crash");
		const retry = new LeadConfigRegistryWriter({
			...f.deps,
			afterRename: undefined,
		});
		expect((await retry.commit(intent)).status).toBe("registry_committed");
		expect(f.store.listLeadConfigAudit(f.input.operationId)).toHaveLength(2);
	},
);
it(
	"cancels a prepared but unwritten operation without mutating registry bytes",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		const intent = f.writer.plan(f.input);
		const before = readFileSync(f.projectsPath, "utf8");
		f.store.prepareLeadConfigOperation(intent);
		expect((await f.writer.recover(f.input.operationId)).status).toBe(
			"conflict",
		);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(before);
	},
);
it(
	"serializes concurrent identical applies into one committed generation",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		const intent = f.writer.plan(f.input);
		const results = await Promise.all([
			f.writer.commit(intent),
			f.writer.commit(intent),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"registry_committed",
			"registry_committed",
		]);
		expect(f.store.listLeadConfigAudit(f.input.operationId)).toHaveLength(2);
	},
);

it(
	"recovers an explicit same-value generation when preimage and postimage hashes coincide",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		await f.writer.commit(f.writer.plan(f.input));
		const intent = f.writer.plan({ ...f.input, operationId: randomUUID() });
		expect(intent.preProjectsSha).toBe(intent.postProjectsSha);
		const crashing = new LeadConfigRegistryWriter({
			...f.deps,
			afterRename: () => {
				throw new Error("simulated_crash");
			},
		});
		await expect(crashing.commit(intent)).rejects.toThrow("simulated_crash");
		const result = await f.writer.recover(intent.operationId);
		expect(result.status).toBe("registry_committed");
		expect(result.configGeneration).toBe(2);
	},
);
it(
	"replays durable commit evidence even when current source is unavailable",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		const intent = f.writer.plan(f.input);
		await f.writer.commit(intent);
		writeFileSync(f.receiptPath, "unavailable");
		expect((await f.writer.commit(intent)).status).toBe("registry_committed");
	},
);

it(
	"adopts a validated external tuning edit under lock without rewriting registry or summary bytes",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		expect(f.writer.externalCandidates()).toEqual([]);
		const receipt = readFileSync(f.receiptPath, "utf8");
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].leads[0].effort = "high";
		const external = `${JSON.stringify(raw)}\n\n`;
		writeFileSync(f.projectsPath, external);
		const [intent] = f.writer.externalCandidates();
		expect(intent).toMatchObject({
			actor: "external_registry_change",
			preimage: { effort: "low" },
			postimage: { effort: "high" },
		});
		const result = await f.writer.adoptExternal(intent!);
		expect(result.status).toBe("registry_committed");
		expect(readFileSync(f.projectsPath, "utf8")).toBe(external);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(receipt);
		f.writer.assertCurrent(intent!);
		expect(f.writer.externalCandidates()).toEqual([]);
		await expect(f.writer.commit(intent!)).rejects.toThrow(
			"external_intent_requires_adoption",
		);
		expect(
			f.store
				.listLeadConfigAudit(intent!.operationId)
				.map((row) => JSON.parse(row.detail)),
		).toContainEqual(
			expect.objectContaining({ external: true, editorVerified: false }),
		);
	},
);

it(
	"does not invent an external projects edit when only the model registry revision changes",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		expect(f.writer.externalCandidates()).toEqual([]);
		f.setModelRegistryRevision("models-replaced");
		expect(f.writer.externalCandidates()).toEqual([]);
		expect(f.store.listLeadConfigOperations("raya-raya")).toEqual([]);
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].leads[0].effort = "high";
		writeFileSync(f.projectsPath, JSON.stringify(raw));
		expect(f.writer.externalCandidates()).toHaveLength(1);
	},
);

it(
	"rejects a stale external observation and never overwrites the next editor",
	{ timeout: 20000 },
	async () => {
		const f = await fixture();
		f.writer.externalCandidates();
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].leads[0].effort = "high";
		writeFileSync(f.projectsPath, JSON.stringify(raw));
		const [intent] = f.writer.externalCandidates();
		raw[0].leads[0].effort = "medium";
		const next = JSON.stringify(raw);
		writeFileSync(f.projectsPath, next);
		await expect(f.writer.adoptExternal(intent!)).rejects.toThrow(
			"external_registry_changed",
		);
		expect(readFileSync(f.projectsPath, "utf8")).toBe(next);
		expect(f.store.getLeadConfigOperation(intent!.operationId)).toBeNull();
	},
);

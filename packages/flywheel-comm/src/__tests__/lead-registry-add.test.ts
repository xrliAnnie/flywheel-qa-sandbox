import { createHash } from "node:crypto";
import {
	type LeadRegistryAddError,
	planLeadRegistryAdd,
} from "../lead-registry-add.js";
import { compileSummaryAssignments } from "../summary-assignment.js";
import type { SummaryMigrationReceipt } from "../summary-registry-migration.js";

const PER_LEAD = {
	state: "selected" as const,
	granularity: "per-lead" as const,
	setBy: "test",
	setAt: "2026-09-08T00:00:00.000Z",
};

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function receiptFor(registry: unknown): SummaryMigrationReceipt {
	const projection = compileSummaryAssignments(registry, PER_LEAD);
	const assignments = projection.leads.map((row) => ({
		projectName: row.projectName,
		leadId: row.leadId,
		summaryRole: row.summaryRole,
	}));
	return {
		schemaVersion: 1,
		postImageSha256: sha256(`${JSON.stringify(registry, null, 2)}\n`),
		assignments,
		projectAggregators: projection.projectAggregators,
		granularity: "per-lead",
		summaryAssignmentDigest: projection.digest,
		migratedAt: "2026-09-08T00:00:00.000Z",
	};
}

const registry = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "existing-lead",
				summaryRole: "producer",
				chatChannel: "10000000000000001",
				match: { labels: ["existing-lead"] },
				botTokenEnv: "EXISTING_BOT_TOKEN",
				botUserId: "20000000000000001",
			},
		],
	},
];

describe("planLeadRegistryAdd", () => {
	it("adds a new Codex Lead project with the frozen defaults", () => {
		const plan = planLeadRegistryAdd(registry, receiptFor(registry), PER_LEAD, {
			projectName: "raya",
			projectRoot: "/tmp/raya",
			projectRepo: "xrliAnnie/raya",
			memoryAllowedUsers: ["30000000000000001"],
			leadId: "raya-product-lead",
			chatChannel: "40000000000000001",
			botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
			botUserId: "50000000000000001",
			harness: "codex",
		});

		expect(plan.kind).toBe("add");
		expect(plan.leadKey).toBe("raya-raya-product-lead");
		expect(plan.candidateRegistry).toEqual([
			...registry,
			{
				projectName: "raya",
				projectRoot: "/tmp/raya",
				projectRepo: "xrliAnnie/raya",
				memoryAllowedUsers: ["30000000000000001"],
				leads: [
					{
						agentId: "raya-product-lead",
						summaryRole: "recipient",
						chatChannel: "40000000000000001",
						match: { labels: ["raya-product-lead"] },
						botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
						botUserId: "50000000000000001",
						canSpawnRunners: false,
						backend: "codex-app-server",
						codexProfile: "full-access",
					},
				],
			},
		]);
		expect(plan.candidateText).toBe(
			`${JSON.stringify(plan.candidateRegistry, null, 2)}\n`,
		);
		expect(plan.planned.projectsSha).toBe(sha256(plan.candidateText));
		expect(plan.manifest.leadBackend.backendId).toBe("codex-app-server");
	});

	it("rejects an existing Lead whose row differs and names the fields", () => {
		const existingRegistry = [
			{
				projectName: "raya",
				projectRoot: "/tmp/raya",
				leads: [
					{
						agentId: "raya-product-lead",
						summaryRole: "recipient",
						chatChannel: "40000000000000001",
						match: { labels: ["raya-product-lead"] },
						botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
						botUserId: "50000000000000001",
						canSpawnRunners: false,
						backend: "codex-app-server",
						codexProfile: "full-access",
					},
				],
			},
		];

		expect(() =>
			planLeadRegistryAdd(
				existingRegistry,
				receiptFor(existingRegistry),
				PER_LEAD,
				{
					projectName: "raya",
					projectRoot: "/tmp/raya",
					leadId: "raya-product-lead",
					chatChannel: "49999999999999999",
					botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
					botUserId: "50000000000000001",
					harness: "codex",
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<LeadRegistryAddError>>({
				code: "lead_registry_lead_exists",
				message: expect.stringContaining("chatChannel"),
			}),
		);
	});

	it("appends a Claude Lead to an existing project", () => {
		const plan = planLeadRegistryAdd(registry, receiptFor(registry), PER_LEAD, {
			projectName: "flywheel",
			projectRoot: "/tmp/flywheel",
			leadId: "new-claude-lead",
			chatChannel: "60000000000000001",
			botTokenEnv: "NEW_CLAUDE_BOT_TOKEN",
			botUserId: "70000000000000001",
			harness: "claude",
			model: "claude-opus-4-1",
		});

		const projects = plan.candidateRegistry as Array<{
			leads: Array<Record<string, unknown>>;
		}>;
		expect(projects).toHaveLength(1);
		expect(projects[0]?.leads[1]).toMatchObject({
			agentId: "new-claude-lead",
			backend: "claude-code",
			carrier: "v2",
			canSpawnRunners: false,
		});
		expect(plan.manifest).toMatchObject({
			model: "claude-opus-4-1",
			leadBackend: { backendId: "claude-code" },
		});
	});

	it("rejects conflicting project-level options instead of dropping them on append", () => {
		const existingRegistry = [
			{
				...registry[0],
				projectRepo: "xrliAnnie/flywheel",
				generalChannel: "30000000000000001",
				memoryAllowedUsers: ["40000000000000001"],
			},
		];
		const conflicts = [
			["projectRepo", { projectRepo: "xrliAnnie/not-flywheel" }],
			["generalChannel", { generalChannel: "39999999999999999" }],
			["memoryAllowedUsers", { memoryAllowedUsers: ["49999999999999999"] }],
		] as const;

		for (const [field, conflictingOption] of conflicts) {
			expect(() =>
				planLeadRegistryAdd(
					existingRegistry,
					receiptFor(existingRegistry),
					PER_LEAD,
					{
						projectName: "flywheel",
						projectRoot: "/tmp/flywheel",
						leadId: "new-claude-lead",
						chatChannel: "60000000000000001",
						botTokenEnv: "NEW_CLAUDE_BOT_TOKEN",
						botUserId: "70000000000000001",
						harness: "claude",
						...conflictingOption,
					},
				),
			).toThrowError(
				expect.objectContaining({
					code: "lead_registry_project_options_conflict",
					message: expect.stringContaining(field),
				}),
			);
		}
	});

	it("returns continuation without changing an exact existing row", () => {
		const first = planLeadRegistryAdd(
			registry,
			receiptFor(registry),
			PER_LEAD,
			{
				projectName: "raya",
				projectRoot: "/tmp/raya",
				leadId: "raya-product-lead",
				chatChannel: "40000000000000001",
				botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
				botUserId: "50000000000000001",
				harness: "codex",
			},
		);
		const second = planLeadRegistryAdd(
			first.candidateRegistry,
			receiptFor(first.candidateRegistry),
			PER_LEAD,
			{
				projectName: "raya",
				projectRoot: "/tmp/raya",
				leadId: "raya-product-lead",
				chatChannel: "40000000000000001",
				botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
				botUserId: "50000000000000001",
				harness: "codex",
			},
		);

		expect(second.kind).toBe("continuation");
		expect(second.candidateRegistry).toEqual(first.candidateRegistry);
		expect(second.planned.projectsSha).toBe(first.planned.projectsSha);
	});

	it("inherits existing project-level options when a continuation omits them", () => {
		const first = planLeadRegistryAdd(
			registry,
			receiptFor(registry),
			PER_LEAD,
			{
				projectName: "raya",
				projectRoot: "/tmp/raya",
				projectRepo: "xrliAnnie/raya",
				generalChannel: "30000000000000001",
				memoryAllowedUsers: ["40000000000000001"],
				leadId: "raya-product-lead",
				chatChannel: "50000000000000001",
				botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
				botUserId: "60000000000000001",
				harness: "codex",
			},
		);
		const continuation = planLeadRegistryAdd(
			first.candidateRegistry,
			receiptFor(first.candidateRegistry),
			PER_LEAD,
			{
				projectName: "raya",
				projectRoot: "/tmp/raya",
				leadId: "raya-product-lead",
				chatChannel: "50000000000000001",
				botTokenEnv: "RAYA_PRODUCT_BOT_TOKEN",
				botUserId: "60000000000000001",
				harness: "codex",
			},
		);

		expect(continuation.kind).toBe("continuation");
		expect(continuation.candidateRegistry).toEqual(first.candidateRegistry);
	});

	it("rejects a conflicting project root before appending", () => {
		expect(() =>
			planLeadRegistryAdd(registry, receiptFor(registry), PER_LEAD, {
				projectName: "flywheel",
				projectRoot: "/tmp/not-flywheel",
				leadId: "new-lead",
				chatChannel: "60000000000000001",
				botTokenEnv: "NEW_BOT_TOKEN",
				botUserId: "70000000000000001",
				harness: "claude",
			}),
		).toThrowError(
			expect.objectContaining<Partial<LeadRegistryAddError>>({
				code: "lead_registry_project_root_conflict",
			}),
		);
	});

	it("rejects a bare Lead id already registered in another project", () => {
		expect(() =>
			planLeadRegistryAdd(registry, receiptFor(registry), PER_LEAD, {
				projectName: "raya",
				projectRoot: "/tmp/raya",
				leadId: "existing-lead",
				chatChannel: "60000000000000001",
				botTokenEnv: "NEW_BOT_TOKEN",
				botUserId: "70000000000000001",
				harness: "claude",
			}),
		).toThrowError(
			expect.objectContaining<Partial<LeadRegistryAddError>>({
				code: "lead_registry_lead_exists",
			}),
		);
	});

	it("fails closed outside per-lead summary mode", () => {
		expect(() =>
			planLeadRegistryAdd(
				registry,
				receiptFor(registry),
				{ ...PER_LEAD, granularity: "per-project" },
				{
					projectName: "raya",
					projectRoot: "/tmp/raya",
					leadId: "raya-lead",
					chatChannel: "60000000000000001",
					botTokenEnv: "RAYA_BOT_TOKEN",
					botUserId: "70000000000000001",
					harness: "codex",
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<LeadRegistryAddError>>({
				code: "lead_registry_granularity_unsupported",
			}),
		);
	});

	it("rejects a stale pre-image receipt", () => {
		const stale = {
			...receiptFor(registry),
			summaryAssignmentDigest: "0".repeat(64),
		};
		expect(() =>
			planLeadRegistryAdd(registry, stale, PER_LEAD, {
				projectName: "raya",
				projectRoot: "/tmp/raya",
				leadId: "raya-lead",
				chatChannel: "60000000000000001",
				botTokenEnv: "RAYA_BOT_TOKEN",
				botUserId: "70000000000000001",
				harness: "codex",
			}),
		).toThrowError(
			expect.objectContaining<Partial<LeadRegistryAddError>>({
				code: "lead_registry_preimage_stale",
			}),
		);
	});

	it("preserves an object-wrapped registry and computes deterministic hashes", () => {
		const wrapped = { projects: registry, schemaVersion: 7 };
		const input = {
			projectName: "raya",
			projectRoot: "/tmp/raya",
			leadId: "raya-lead",
			chatChannel: "60000000000000001",
			botTokenEnv: "RAYA_BOT_TOKEN",
			botUserId: "70000000000000001",
			harness: "codex" as const,
		};
		const first = planLeadRegistryAdd(
			wrapped,
			receiptFor(wrapped),
			PER_LEAD,
			input,
		);
		const second = planLeadRegistryAdd(
			wrapped,
			receiptFor(wrapped),
			PER_LEAD,
			input,
		);

		expect(first.candidateRegistry).toMatchObject({ schemaVersion: 7 });
		expect(first.candidateText).toBe(second.candidateText);
		expect(first.planned).toEqual(second.planned);
	});
});

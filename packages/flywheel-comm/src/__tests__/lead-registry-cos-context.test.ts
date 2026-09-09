import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	digestLeadRegistryRow,
	planLeadRegistryCoSContextImport,
} from "../lead-registry-cos-context.js";
import { compileSummaryAssignments } from "../summary-assignment.js";

const PER_LEAD = {
	state: "selected" as const,
	granularity: "per-lead" as const,
	setBy: "founder",
	setAt: "2026-09-08T00:00:00.000Z",
};

describe("planLeadRegistryCoSContextImport", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function fixture() {
		const root = mkdtempSync(join(tmpdir(), "fly2445-cos-context-"));
		roots.push(root);
		const registry = Array.from({ length: 14 }, (_, index) => {
			const projectRoot = join(root, `project-${index}`);
			mkdirSync(join(projectRoot, "team"), { recursive: true });
			const identityPath = join(root, `identity-${index}.md`);
			const memoryPath = join(root, `memory-${index}.md`);
			writeFileSync(identityPath, `identity ${index}`);
			writeFileSync(memoryPath, `memory ${index}`);
			return {
				projectName: `project-${index}`,
				projectRoot,
				leads: [
					{
						agentId: `lead-${index}`,
						summaryRole: "producer",
						chatChannel: `${10000000000000001n + BigInt(index)}`,
						match: { labels: [`lead-${index}`] },
						botTokenEnv: `LEAD_${index}_BOT_TOKEN`,
						botUserId: `${20000000000000001n + BigInt(index)}`,
					},
				],
			};
		});
		const projection = compileSummaryAssignments(registry, PER_LEAD);
		const receipt = {
			schemaVersion: 1 as const,
			postImageSha256: "a".repeat(64),
			assignments: projection.leads.map((row) => ({
				projectName: row.projectName,
				leadId: row.leadId,
				summaryRole: row.summaryRole,
			})),
			projectAggregators: projection.projectAggregators,
			granularity: "per-lead" as const,
			summaryAssignmentDigest: projection.digest,
			migratedAt: "2026-09-08T00:00:00.000Z",
		};
		const rows = registry.map((project, index) => ({
			projectName: project.projectName,
			leadId: project.leads[0]!.agentId,
			botUserId: project.leads[0]!.botUserId,
			expectedLeadSha256: digestLeadRegistryRow(project.leads[0]),
			cosContext: {
				displayName: `Lead ${index}`,
				aliases: [`alias-${index}`],
				workingSubdirectory: "team",
				identityPath: join(root, `identity-${index}.md`),
				memoryPaths: [join(root, `memory-${index}.md`)],
				writableRoots: [join(project.projectRoot, "team")],
			},
		}));
		return { registry, receipt, rows };
	}

	it("updates exactly the existing 14 rows and is byte-stable on continuation", () => {
		const f = fixture();
		const first = planLeadRegistryCoSContextImport(
			f.registry,
			f.receipt,
			PER_LEAD,
			{ schemaVersion: 1, rows: f.rows },
		);
		expect(first.kind).toBe("update");
		expect(first.updatedLeadKeys).toHaveLength(14);
		expect(
			(first.candidateRegistry as typeof f.registry)[4]!.leads[0]!.cosContext,
		).toMatchObject({
			displayName: "Lead 4",
			aliases: ["alias-4"],
			workingSubdirectory: "team",
		});

		const updated = first.candidateRegistry as typeof f.registry;
		const continuationRows = f.rows.map((row, index) => ({
			...row,
			expectedLeadSha256: digestLeadRegistryRow(updated[index]!.leads[0]),
		}));
		const projection = compileSummaryAssignments(updated, PER_LEAD);
		const second = planLeadRegistryCoSContextImport(
			updated,
			{ ...f.receipt, summaryAssignmentDigest: projection.digest },
			PER_LEAD,
			{ schemaVersion: 1, rows: continuationRows },
		);
		expect(second.kind).toBe("continuation");
		expect(second.candidateText).toBe(first.candidateText);
	});

	it("rejects identity drift instead of overwriting a central bot identity", () => {
		const f = fixture();
		f.rows[3] = { ...f.rows[3]!, botUserId: "29999999999999999" };
		expect(() =>
			planLeadRegistryCoSContextImport(f.registry, f.receipt, PER_LEAD, {
				schemaVersion: 1,
				rows: f.rows,
			}),
		).toThrow(/botUserId.*does not match/i);
	});

	it("rejects aliases that normalize to more than one Lead", () => {
		const f = fixture();
		f.rows[0]!.cosContext.aliases = ["Ｃｈｉｅｆ"];
		f.rows[1]!.cosContext.aliases = [" c h i e f "];
		expect(() =>
			planLeadRegistryCoSContextImport(f.registry, f.receipt, PER_LEAD, {
				schemaVersion: 1,
				rows: f.rows,
			}),
		).toThrow(/alias.*ambiguous/i);
	});
});

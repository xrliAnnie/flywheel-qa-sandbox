import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	effectiveLeadBackend,
	resolveCanonicalLead,
} from "../canonical-lead.js";

describe("FLY-1309 canonical Lead resolver", () => {
	let dir: string;
	let projectsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1309-projects-"));
		projectsPath = join(dir, "projects.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function write(value: unknown): void {
		writeFileSync(projectsPath, JSON.stringify(value));
	}

	it("returns the canonical project and lease key for one unique match", () => {
		write([
			{
				projectName: "flywheel",
				leads: [
					{
						agentId: "eng-lead",
						summaryRole: "producer",
						backend: "claude-code",
					},
				],
			},
			{
				projectName: "sub",
				leads: [{ agentId: "sub-lead", summaryRole: "producer" }],
			},
		]);

		expect(
			resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		).toMatchObject({
			status: "ok",
			canonicalProject: "flywheel",
			leadKey: "flywheel-eng-lead",
			lead: { agentId: "eng-lead", backend: "claude-code" },
			projectsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("accepts the legacy wrapped {projects: []} document shape", () => {
		write({
			projects: [
				{
					projectName: "flywheel",
					leads: [{ agentId: "eng-lead", summaryRole: "producer" }],
				},
			],
		});
		expect(
			resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		).toMatchObject({
			status: "ok",
			canonicalProject: "flywheel",
		});
	});

	it("returns valid_but_lead_absent for a readable valid source", () => {
		write([
			{
				projectName: "flywheel",
				leads: [{ agentId: "other-lead", summaryRole: "producer" }],
			},
		]);
		expect(
			resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		).toMatchObject({
			status: "valid_but_lead_absent",
			projectsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	it("treats a cross-project bare leadId collision as a broken source", () => {
		write([
			{
				projectName: "flywheel",
				leads: [{ agentId: "eng-lead", summaryRole: "producer" }],
			},
			{
				projectName: "sub",
				leads: [{ agentId: "eng-lead", summaryRole: "producer" }],
			},
		]);
		expect(
			resolveCanonicalLead({
				leadId: "eng-lead",
				projectHint: "flywheel",
				projectsPath,
			}),
		).toMatchObject({
			status: "source_error",
			error: expect.stringContaining("identity_bare_id_collision"),
		});
	});

	it.each([
		[
			"ENOENT",
			() => resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		],
		[
			"EACCES",
			() =>
				resolveCanonicalLead(
					{ leadId: "eng-lead", projectsPath },
					{
						readFile: () => {
							const error = new Error(
								"permission denied",
							) as NodeJS.ErrnoException;
							error.code = "EACCES";
							throw error;
						},
					},
				),
		],
	])(
		"returns source_error for %s instead of an empty configuration",
		(_name, run) => {
			expect(run()).toMatchObject({
				status: "source_error",
				error: expect.any(String),
			});
		},
	);

	it("returns source_error for malformed JSON and recovers on the next call", () => {
		writeFileSync(projectsPath, "{broken");
		expect(
			resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		).toMatchObject({
			status: "source_error",
		});

		write([
			{
				projectName: "flywheel",
				leads: [{ agentId: "eng-lead", summaryRole: "producer" }],
			},
		]);
		expect(
			resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		).toMatchObject({
			status: "ok",
			leadKey: "flywheel-eng-lead",
		});
	});

	it("returns source_error for structurally invalid projects rather than lead_absent", () => {
		write([{ projectName: "flywheel", leads: "not-an-array" }]);
		expect(
			resolveCanonicalLead({ leadId: "eng-lead", projectsPath }),
		).toMatchObject({
			status: "source_error",
		});
	});
});

describe("shared effective Lead backend precedence", () => {
	it("uses explicit, then legacy, then the Claude default", () => {
		expect(effectiveLeadBackend("codex-app-server", "claude-code")).toEqual({
			backend: "codex-app-server",
			source: "explicit",
		});
		expect(effectiveLeadBackend(undefined, "codex-app-server")).toEqual({
			backend: "codex-app-server",
			source: "legacy",
		});
		expect(effectiveLeadBackend(undefined, undefined)).toEqual({
			backend: "claude-code",
			source: "default",
		});
	});
});

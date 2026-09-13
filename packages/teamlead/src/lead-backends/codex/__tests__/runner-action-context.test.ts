import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	identityEnvProjection,
	resolveLeadIdentity,
} from "flywheel-comm/lead-identity";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerActionContext } from "../runner-action-context.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-context-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-10T00:00:00Z",
		}),
	);
	const projectsPath = join(home, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "demo",
				projectRoot: home,
				leads: [
					{
						agentId: "product-lead",
						summaryRole: "producer",
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: true,
						codexRunnerActions: true,
					},
				],
			},
		]),
	);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: "demo",
		leadId: "product-lead",
		homeDir: home,
	});
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
		FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "1",
		...Object.fromEntries(
			identityEnvProjection(identity).map((line) => {
				const pos = line.indexOf("=");
				return [line.slice(0, pos), line.slice(pos + 1)];
			}),
		),
	};
	const mutate = (changes: Record<string, unknown>) => {
		const raw = JSON.parse(readFileSync(projectsPath, "utf8"));
		Object.assign(raw[0].leads[0], changes);
		writeFileSync(projectsPath, JSON.stringify(raw));
	};
	return { env, mutate, projectsPath };
}
describe("Codex runner action capability lease", () => {
	it("binds the exact registry identity and rejects revocation before any tool side effect", () => {
		const f = fixture();
		const ctx = createRunnerActionContext(f.env);
		expect(ctx.assertCurrent().identity.leadId).toBe("product-lead");
		f.mutate({ codexRunnerActions: false });
		expect(() => ctx.assertCurrent()).toThrow(/capability/);
	});
	it.each([
		{ backend: "claude-code" },
		{ codexProfile: "write-capable" },
		{ summaryRole: "recipient" },
	])("rejects runtime identity/profile drift %j", (change) => {
		const f = fixture();
		const ctx = createRunnerActionContext(f.env);
		f.mutate(change);
		expect(() => ctx.assertCurrent()).toThrow();
	});
	it.each([undefined, "0", "true"])(
		"requires the explicit validated env marker %j",
		(marker) => {
			const f = fixture();
			f.env.FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS = marker;
			expect(() => createRunnerActionContext(f.env)).toThrow(/capability/);
		},
	);
	it("rejects partial or forged canonical context", () => {
		const f = fixture();
		delete f.env.FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST;
		expect(() => createRunnerActionContext(f.env)).toThrow(/identity/);
	});
	it("does not retain mutable caller environment", () => {
		const f = fixture();
		const ctx = createRunnerActionContext(f.env);
		f.env.FLYWHEEL_LEAD_ID = "foreign-lead";
		expect(ctx.assertCurrent().identity.leadId).toBe("product-lead");
	});
});

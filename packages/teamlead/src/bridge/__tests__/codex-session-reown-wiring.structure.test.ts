import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginPath = fileURLToPath(new URL("../plugin.ts", import.meta.url));
const source = readFileSync(pluginPath, "utf8");
const runInfraSource = readFileSync(
	fileURLToPath(new URL("../run-infra.ts", import.meta.url)),
	"utf8",
);

describe("FLY-2211 Bridge recovery wiring", () => {
	it("shares one owner registry with run-infra and the recovery coordinator", () => {
		expect(source).toContain(
			"const codexExecutionOwners = new CodexExecutionOwnershipRegistry()",
		);
		expect(source).toMatch(/codexExecutionOwners,\s+codexRecoveryRuntimes,/);
		expect(source).toContain("owners: codexExecutionOwners");
	});

	it("runs the boot recovery barrier before heartbeat and its orphan lane", () => {
		const boot = source.lastIndexOf(
			"await codexSessionReowner.runPass(store.getReadoptCandidateSessions())",
		);
		const seed = source.indexOf("heartbeatService.seedReconnecting()", boot);
		const start = source.indexOf("heartbeatService.start()", boot);
		expect(boot).toBeGreaterThan(0);
		expect(seed).toBeGreaterThan(boot);
		expect(start).toBeGreaterThan(seed);
	});

	it("uses one periodic candidate snapshot and recovers before orphan mutation", () => {
		const maintenance = source.indexOf(
			"const codexCandidateSnapshot = store.getReadoptCandidateSessions()",
		);
		const recover = source.indexOf(
			"await codexSessionReowner.runPass(codexCandidateSnapshot)",
			maintenance,
		);
		const orphan = source.indexOf("await sweepCodexRunnerOrphans(", recover);
		expect(maintenance).toBeGreaterThan(0);
		expect(recover).toBeGreaterThan(maintenance);
		expect(orphan).toBeGreaterThan(recover);
		const lane = source.slice(maintenance, orphan + 2000);
		expect(lane).toContain(
			"codexCandidateSnapshot.map((session) => session.execution_id)",
		);
		expect(lane).not.toContain(
			"store\n\t\t\t\t\t\t.getReadoptCandidateSessions()",
		);
	});

	it("is default-on with no runtime feature flag", () => {
		expect(source).not.toMatch(/codex_reown_enabled/i);
	});

	it("reads the late-materialized generalized room marker on each exclusion decision", () => {
		expect(source).toContain("const readCodexReownRoomInfo = (): unknown =>");
		expect(source).toContain(
			"isCodexReownExcluded(session, readCodexReownRoomInfo())",
		);
	});

	it("serializes every production TURN writer with the recovery mutation lease", () => {
		expect(source.match(/withExecutionMutationLease\(\{/g)).toHaveLength(3);
		expect(runInfraSource).toContain("withExecutionMutationLease({");
		expect(runInfraSource).toContain(
			"mutate: () => grantPrelaunchWorkflowTurn(turnInput)",
		);
	});
});

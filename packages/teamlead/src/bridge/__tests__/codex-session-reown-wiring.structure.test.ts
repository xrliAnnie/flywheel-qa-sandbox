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
		const boot = source.lastIndexOf("await codexSessionReowner.runPass(");
		const marker = source.indexOf(
			'withSyncOpMarker("boot:readopt-candidates"',
			boot,
		);
		const candidates = source.indexOf(
			"store.getReadoptCandidateSessions()",
			marker,
		);
		const seed = source.indexOf(
			"heartbeatService.seedReconnecting()",
			candidates,
		);
		const start = source.indexOf("heartbeatService.start()", seed);
		expect(boot).toBeGreaterThan(0);
		expect(marker).toBeGreaterThan(boot);
		expect(candidates).toBeGreaterThan(marker);
		expect(seed).toBeGreaterThan(candidates);
		expect(start).toBeGreaterThan(seed);
	});

	it("uses one periodic candidate snapshot and recovers before orphan mutation", () => {
		const maintenance = source.indexOf(
			"const codexCandidateSnapshot = withSyncOpMarker(",
		);
		const marker = source.indexOf(
			'"maintenance:readopt-candidates"',
			maintenance,
		);
		const candidates = source.indexOf(
			"store.getReadoptCandidateSessions()",
			marker,
		);
		const recover = source.indexOf(
			"await codexSessionReowner.runPass(codexCandidateSnapshot)",
			candidates,
		);
		const orphan = source.indexOf("await sweepCodexRunnerOrphans(", recover);
		expect(maintenance).toBeGreaterThan(0);
		expect(marker).toBeGreaterThan(maintenance);
		expect(candidates).toBeGreaterThan(marker);
		expect(recover).toBeGreaterThan(candidates);
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

	it("FLY-2170 resolves one founder-window decision before recovery resume", () => {
		expect(source).toContain("resolveCodexRecoveryWindow({");
		expect(source).toContain("listWindows: listTmuxWindowsByExecutionId");
		expect(source).toContain("lookupTarget: lookupTmuxTarget");
		expect(source).toContain('founderWindow: "open"');
		expect(source).toContain("windowName: windowDecision.windowName");
		expect(source).toContain('founderWindow: "suppressed"');
		expect(source).toContain(
			["label unavailable for $", "{session.execution_id}"].join(""),
		);
	});
});

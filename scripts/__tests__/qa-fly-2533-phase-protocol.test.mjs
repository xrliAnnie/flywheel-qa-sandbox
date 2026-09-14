import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyClaim,
	compareArms,
	validateDeployment,
} from "../qa-fly-2533-phase-protocol.mjs";

const slot = {
	bridgePort: 19529,
	botName: "test-lead",
	channelId: "529",
	tokenEnvVar: "TEST_TOKEN",
};
const room = {
	slot: 1,
	mode: "slot",
	projectName: "test-slot-1",
	agentId: "test-lead",
	chatChannelId: "529",
	botTokenEnv: "TEST_TOKEN",
	port: 19529,
	bridgeUrl: "http://localhost:19529",
	hostRepo: "/tmp/flywheel-test-slot-1/repo",
	dbPath: "/tmp/flywheel-test-slot-1/teamlead.db",
	slotDir: "/tmp/flywheel-test-slot-1",
	leadCarrier: "launchd-v2",
	leadSocket: "/tmp/flywheel-test-slot-1/socket",
	leadLaunchdLabel: "com.flywheel.test",
	flywheelProjectsFile: "/tmp/flywheel-test-slot-1/projects.json",
	bridgeLaunchSpec: "/tmp/flywheel-test-slot-1/launch.json",
	launchdRegistry: "/tmp/flywheel-test-slot-1/registry.json",
};
test("accept only exact slot registry coordinates", () =>
	assert.equal(validateDeployment(room, slot).projectName, "test-slot-1"));
for (const [key, value] of Object.entries({
	bridgeUrl: "http://localhost:3000",
	projectName: "flywheel",
	hostRepo: "/Users/me/Dev/flywheel",
	chatChannelId: "production",
	dbPath: "/tmp/flywheel-test-slot-10/teamlead.db",
	runnerMode: "stub",
	generalized: true,
	leadSocket: "/tmp/shared/socket",
})) {
	test(`reject ${key} outside ordinary real slot`, () =>
		assert.throws(() => validateDeployment({ ...room, [key]: value }, slot)));
}
const activation = {
	run_id: "r",
	node_id: "qa",
	attempt: 1,
	activation_id: "a",
	execution_id: "e",
};
const claim = {
	family: "qa_verdict",
	claim_id: 1,
	server_seq: 9,
	consumed_at: "now",
	activation_id: "a",
	run_id: "r",
	node_id: "qa",
	attempt: 1,
	execution_id: "e",
	issuer_execution_id: "e",
	issuer_vendor: "claude",
	predicate: "qa_passed",
	subject_digest: "abc",
};
test("accepted consumed claim targets exact activation", () => {
	assert.equal(classifyClaim(claim, activation), "PASS");
	assert.equal(
		classifyClaim({ ...claim, activation_id: "old" }, activation),
		null,
	);
	assert.equal(
		classifyClaim({ ...claim, consumed_at: null }, activation),
		null,
	);
});
test("baseline success leaves causal comparison unproven", () => {
	const common = {
		fixtureDigest: "f",
		model: "m",
		effort: "high",
		initialHead: "h",
		issueId: "FLY-2533",
		windowMs: 600000,
	};
	assert.equal(
		compareArms(
			{ ...common, outcome: "PASS", arm: "baseline", runId: "b" },
			{ ...common, outcome: "PASS", arm: "candidate", runId: "c" },
		).criterionB,
		"UNPROVEN_BASELINE_ALSO_CLAIMED",
	);
});

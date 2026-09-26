import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(
	readFileSync(join(root, "scripts/test-slots.example.json"), "utf8"),
);

test("repository template describes six isolated text and voice slots", () => {
	const { slots } = config;
	assert.deepEqual(
		slots.map((slot) => slot.id),
		[1, 2, 3, 4, 5, 6],
	);
	assert.deepEqual(
		slots.map((slot) => slot.bridgePort),
		[19871, 19872, 19873, 19874, 19875, 19876],
	);

	for (const slot of slots) {
		assert.equal(slot.botName, `flywheel-test-${slot.id}`);
		assert.equal(slot.tokenEnvVar, `TEST_BOT_TOKEN_${slot.id}`);
		assert.equal(slot.voiceChannelName, `voice-test-${slot.id}`);
		assert.equal(slot.voiceChannelId, `<voice-channel-id-${slot.id}>`);
	}

	for (const field of [
		"botAppId",
		"tokenEnvVar",
		"channelId",
		"voiceChannelId",
		"bridgePort",
	]) {
		assert.equal(
			new Set(slots.map((slot) => slot[field])).size,
			slots.length,
			`${field} must be unique per slot`,
		);
	}
});

test("slot 5 clones the product Codex carrier and slot 6 stays on Claude", () => {
	const slot5 = config.slots[4];
	const slot6 = config.slots[5];

	assert.deepEqual(
		{
			role: slot5.role,
			identitySource: slot5.identitySource,
			department: slot5.department,
			deptLabel: slot5.deptLabel,
			channelName: slot5.channelName,
			backend: slot5.backend,
			codexProfile: slot5.codexProfile,
		},
		{
			role: "lead",
			identitySource: "product-lead",
			department: "product-test-2",
			deptLabel: "Product-Test-2",
			channelName: "product-lead-test-2",
			backend: "codex-app-server",
			codexProfile: "full-access",
		},
	);

	assert.deepEqual(
		{
			role: slot6.role,
			identitySource: slot6.identitySource,
			department: slot6.department,
			deptLabel: slot6.deptLabel,
			channelName: slot6.channelName,
			backend: slot6.backend,
			codexProfile: slot6.codexProfile,
		},
		{
			role: "lead",
			identitySource: "ops-lead",
			department: "ops-test-2",
			deptLabel: "Ops-Test-2",
			channelName: "ops-lead-test-2",
			backend: undefined,
			codexProfile: undefined,
		},
	);
});

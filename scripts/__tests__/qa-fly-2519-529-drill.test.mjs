import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("isolated 529 drill exchanges two identities, rejects foreign sends, and cleans up", () => {
	const run = () =>
		JSON.parse(
			execFileSync(process.execPath, ["scripts/qa-fly-2519-529-drill.mjs"], {
				encoding: "utf8",
				timeout: 30000,
				maxBuffer: 65536,
				env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", LANG: "en_US.UTF-8" },
			}),
		);
	const first = run(),
		second = run();
	for (const result of [first, second]) {
		assert.equal(result.status, "passed");
		assert.equal(result.scope, "isolated_fixture");
		assert.equal(result.realDiscordVerified, false);
		assert.equal(result.productionActivation, false);
		assert.equal(result.providerWrites, 2);
		assert.deepEqual(result.participants, ["lead-a", "lead-b"]);
		assert.equal(result.replayDeduped, true);
		assert.equal(result.foreignRejected, true);
		assert.equal(result.bridgeClosed, true);
		assert.equal(result.rootRemoved, true);
		assert.ok(result.messages[1].replyTo === result.messages[0].id);
	}
	assert.notEqual(first.runId, second.runId);
});

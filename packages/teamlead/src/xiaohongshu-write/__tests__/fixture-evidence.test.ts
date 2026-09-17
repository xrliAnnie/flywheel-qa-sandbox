import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { collectFixtureEvidence } from "../fixture-evidence.js";

const expected = {
	nonce: "a".repeat(64),
	serviceUid: 450,
	serviceGid: 450,
	modelUid: 501,
	helperSha256: "b".repeat(64),
	fixture: { markerSha256: "c".repeat(64), state: { dev: 1, ino: 1 } },
};
function fixture() {
	const metadata = {
		dev: 1,
		ino: 2,
		uid: 450,
		gid: 450,
		mode: 0o100600,
		nlink: 1,
		size: 110,
		mtimeMs: 1,
		ctimeMs: 1,
	};
	const binding = { markerSha256: "c".repeat(64), state: { dev: 1, ino: 1 } };
	const before = {
		schemaVersion: 1,
		probeKind: "fixture_harness",
		probe: "file-control",
		nonce: expected.nonce,
		uid: 450,
		fixture: binding,
		artifacts: { ...metadata, mode: 0o40700 },
		files: [
			"permit.synthetic",
			"cookie.synthetic",
			"ledger.synthetic",
			"policy.synthetic",
			"binary.synthetic",
		].map((name) => ({
			name,
			...metadata,
			uid: name === "policy.synthetic" || name === "binary.synthetic" ? 0 : 450,
			gid: name === "policy.synthetic" || name === "binary.synthetic" ? 0 : 450,
			mode:
				name === "policy.synthetic" || name === "binary.synthetic"
					? 0o100644
					: 0o100600,
			size: Buffer.byteLength(
				`flywheel:xhs:synthetic:${name}:${expected.nonce}\n`,
			),
			sha256: createHash("sha256")
				.update(`flywheel:xhs:synthetic:${name}:${expected.nonce}\n`)
				.digest("hex"),
		})),
	};
	const denied = {
		schemaVersion: 1,
		probeKind: "fixture_harness",
		probe: "file-authority",
		nonce: expected.nonce,
		uid: 501,
		fixture: binding,
		observations: [
			"key_read",
			"cookie_read",
			"ledger_read",
			"ledger_write",
			"store_rename",
			"store_symlink",
			"policy_write",
			"binary_write",
		].map((operation) => ({ operation, denied: true, errno: "EACCES" })),
	};
	const flow = {
		schemaVersion: 1,
		probeKind: "fixture_harness",
		probe: "authority-flow",
		nonce: expected.nonce,
		uid: 450,
		helperSha256: expected.helperSha256,
		controlBefore: structuredClone(before),
		controlAfter: structuredClone(before),
		scenarios: [
			"xiaohongshu.like_feed",
			"xiaohongshu.like_feed",
			"xiaohongshu.favorite_feed",
			"xiaohongshu.favorite_feed",
			"xiaohongshu.post_comment_to_feed",
			"xiaohongshu.reply_comment_in_feed",
			"xiaohongshu.publish_content",
			"xiaohongshu.publish_with_video",
		].map((operation, caseIndex) => ({
			probeKind: "fixture_harness",
			caseIndex,
			operation,
			commits: 1,
			replayedCommits: 1,
			negativeCommits: {
				missingReceipt: 0,
				forgedIngress: 0,
				wrongFounder: 0,
				digestMismatch: 0,
			},
			uid: 450,
		})),
	};
	return { before, denied, after: structuredClone(before), flow };
}
async function run(values: ReturnType<typeof fixture>) {
	const calls: string[] = [];
	const output = [values.before, values.denied, values.after, values.flow];
	const result = await collectFixtureEvidence(expected, async (role, probe) => {
		calls.push(`${role}/${probe}`);
		return JSON.stringify(output[calls.length - 1]);
	});
	return { result, calls };
}
it("collects direct child results in fixed order and classifies only fixture evidence", async () => {
	const { result, calls } = await run(fixture());
	expect(calls).toEqual([
		"service/file-control",
		"model/file-authority",
		"service/file-control",
		"service/authority-flow",
	]);
	expect(result.probeKind).toBe("fixture_harness");
	expect(result.hostAcceptance).toBe(false);
	expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(result).not.toHaveProperty("signature");
	expect(result).not.toHaveProperty("passed");
});
it.each([
	"missing-op",
	"wrong-errno",
	"false-denial",
	"wrong-uid",
	"wrong-nonce",
	"wrong-state",
	"changed-control",
	"missing-scenario",
	"replay",
	"negative-mutation",
	"missing-negative-evidence",
	"wrong-helper",
	"extra-field",
])("rejects %s", async (mode) => {
	const f = fixture();
	if (mode === "missing-op") f.denied.observations.pop();
	if (mode === "wrong-errno") f.denied.observations[0]!.errno = "ENOENT";
	if (mode === "false-denial") f.denied.observations[0]!.denied = false;
	if (mode === "wrong-uid") f.denied.uid = 450;
	if (mode === "wrong-nonce") f.flow.nonce = "f".repeat(64);
	if (mode === "wrong-state") f.denied.fixture.state.ino++;
	if (mode === "changed-control") f.after.files[0]!.ino++;
	if (mode === "missing-scenario") f.flow.scenarios.pop();
	if (mode === "replay") f.flow.scenarios[0]!.replayedCommits = 2;
	if (mode === "negative-mutation")
		f.flow.scenarios[0]!.negativeCommits.missingReceipt = 1;
	if (mode === "missing-negative-evidence")
		delete (f.flow.scenarios[0] as Partial<(typeof f.flow.scenarios)[0]>)!
			.negativeCommits;
	if (mode === "wrong-helper") f.flow.helperSha256 = "f".repeat(64);
	if (mode === "extra-field") Object.assign(f.before, { passed: true });
	await expect(run(f)).rejects.toThrow("fixture_evidence_unavailable");
});
it("stops before later probes when a child fails or emits malformed output", async () => {
	let calls = 0;
	await expect(
		collectFixtureEvidence(expected, async () => {
			calls++;
			throw Error("exit1");
		}),
	).rejects.toThrow("fixture_evidence_unavailable");
	expect(calls).toBe(1);
	await expect(
		collectFixtureEvidence(expected, async () => "{}"),
	).rejects.toThrow("fixture_evidence_unavailable");
});

it("rejects internally consistent results for a fixture other than the installer reservation", async () => {
	const values = fixture();
	const replacement = {
		markerSha256: "d".repeat(64),
		state: { dev: 9, ino: 9 },
	};
	for (const control of [
		values.before,
		values.after,
		values.flow.controlBefore,
		values.flow.controlAfter,
	])
		control.fixture = replacement;
	values.denied.fixture = replacement;
	await expect(run(values)).rejects.toThrow("fixture_evidence_unavailable");
});

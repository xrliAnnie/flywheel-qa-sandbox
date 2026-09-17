import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { runSyntheticAuthorityCase } from "../boundary-fixture-flow.js";

const parent = mkdtempSync("/tmp/xhs-fixture-flow-");
const helper = join(parent, "peer");
execFileSync("cc", [
	"-O2",
	fileURLToPath(
		new URL(
			"../../../../../scripts/xhs/xhs-peer-credentials.c",
			import.meta.url,
		),
	),
	"-o",
	helper,
]);
const pin = {
	path: helper,
	sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
};
afterAll(() => rmSync(parent, { recursive: true, force: true }));
it.each([0, 1, 2, 3, 4, 5, 6, 7])(
	"runs independent fixture case %s using production request modules",
	async (index) => {
		const root = mkdtempSync(join(parent, "case-"));
		const result = await runSyntheticAuthorityCase(root, pin, index);
		expect(result).toMatchObject({
			probeKind: "fixture_harness",
			caseIndex: index,
			commits: 1,
			replayedCommits: 1,
			negativeCommits: {
				missingReceipt: 0,
				forgedIngress: 0,
				wrongFounder: 0,
				digestMismatch: 0,
			},
			uid: process.getuid!(),
		});
	},
	20000,
);
it("rejects unknown case indexes and a changed helper pin", async () => {
	const root = mkdtempSync(join(parent, "invalid-"));
	await expect(runSyntheticAuthorityCase(root, pin, 8)).rejects.toThrow();
	await expect(
		runSyntheticAuthorityCase(root, { ...pin, sha256: "0".repeat(64) }, 0),
	).rejects.toThrow();
});

it("uses a short socket path when the evidence directory exceeds the Unix socket limit", async () => {
	const root = join(parent, "a".repeat(95));
	mkdirSync(root, { mode: 0o700 });
	const result = await runSyntheticAuthorityCase(
		root,
		pin,
		0,
		join(parent, "i"),
	);
	expect(result.commits).toBe(1);
});

import { createHash } from "node:crypto";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	activationEvidenceChecks,
	readReleaseActivationEvidence,
} from "../customer-release/evidence.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "release-evidence-")));
	dirs.push(root);
	const identity = {
		environment: "staging-real",
		endpoint: "https://endpoint.example",
		codeSha: "a".repeat(40),
		policyRevision: "b".repeat(64),
		identityDigest: "c".repeat(64),
	};
	const artifact = Buffer.from("captured command output\n");
	writeFileSync(join(root, "output.txt"), artifact);
	const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
	const binding = {
		manifestSha256: "d".repeat(64),
		subjectCommit: "a".repeat(40),
		releaseId: "release-1",
		payloadSha256: "e".repeat(64),
	};
	const records = Object.entries(activationEvidenceChecks).map(
		([stage, checks]) => ({
			stage,
			mode: stage === "A4" ? "observe" : "live",
			...identity,
			...binding,
			actor: "operator-1",
			observedAt: 1000,
			checks: checks.map((check) => ({
				check,
				result: "passed",
				outputFile: "output.txt",
				outputSha256: artifactSha256,
				evidenceUrl: "https://evidence.example/receipt",
			})),
		}),
	);
	const bundle = {
		schemaVersion: 1,
		projectId: "flywheel",
		...identity,
		createdAt: 1500,
		expiresAt: 5000,
		records,
	};
	const save = () =>
		writeFileSync(join(root, "bundle.json"), JSON.stringify(bundle));
	save();
	return {
		root,
		identity,
		bundle,
		save,
		read: () => readReleaseActivationEvidence(root, identity, 2000),
	};
}
it("reads all six ordered activation stages and hashes their bound captured outputs", () => {
	const f = fixture();
	const receipt = f.read();
	expect(receipt?.digest).toMatch(/^[a-f0-9]{64}$/);
	expect(receipt?.stages).toEqual(["A0", "A1", "A2", "A3", "A4", "A5"]);
	expect(f.read()).toEqual(receipt);
});
it.each([
	"missing",
	"fixture",
	"unknown",
	"expired",
	"identity",
	"output",
	"traversal",
	"symlink",
	"extra",
])("fails closed for %s evidence", (kind) => {
	const f = fixture();
	if (kind === "missing") f.bundle.records.pop();
	if (kind === "fixture") f.bundle.records[0].mode = "fixture";
	if (kind === "unknown") f.bundle.records[0].checks[0].result = "unknown";
	if (kind === "expired") f.bundle.expiresAt = 2000;
	if (kind === "identity")
		f.bundle.records[0].endpoint = "https://other.example";
	if (kind === "output") writeFileSync(join(f.root, "output.txt"), "changed");
	if (kind === "traversal")
		f.bundle.records[0].checks[0].outputFile = "../output.txt";
	if (kind === "symlink") {
		symlinkSync("output.txt", join(f.root, "link.txt"));
		f.bundle.records[0].checks[0].outputFile = "link.txt";
	}
	if (kind === "extra") (f.bundle as any).token = "never accepted";
	f.save();
	expect(f.read()).toBeNull();
});
it("requires every named proof and rejects duplicate or reordered stages", () => {
	const f = fixture();
	f.bundle.records[0].checks.pop();
	f.save();
	expect(f.read()).toBeNull();
	const g = fixture();
	g.bundle.records.reverse();
	g.save();
	expect(g.read()).toBeNull();
});

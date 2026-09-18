import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	readBoundFly2729Dependency,
	readFly2729Dependency,
} from "../qa-dependency.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const expectedRoot = mkdtempSync(join(tmpdir(), "fly2729-evidence-"));
	roots.push(expectedRoot);
	const testedHeadSha = "a".repeat(40),
		mergeSha = "b".repeat(40),
		deployedSha = "c".repeat(40);
	const evidence = {
		schemaVersion: 1,
		issueId: "FLY-2729",
		testedHeadSha,
		qaExecutionId: "qa-exec",
		observedAt: "2026-09-18T00:00:00.000Z",
		scenario: "isolated_usage_limit",
		homes: [
			{
				homeId: "flywheel/implement",
				daemonBefore: { pid: 10, startIdentity: "before" },
				daemonAfter: { pid: 11, startIdentity: "after" },
				targetAccountKey: "account-key",
				requestAfterReload: { ok: true, requestId: "request-1" },
				leadPidUnchanged: true,
				threadUnchanged: true,
				windowUnchanged: true,
			},
		],
		result: "PASS",
	};
	const bytes = Buffer.from(JSON.stringify(evidence));
	const digest = createHash("sha256").update(bytes).digest("hex");
	mkdirSync(join(expectedRoot, testedHeadSha), { mode: 0o700 });
	const evidencePath = join(expectedRoot, testedHeadSha, `${digest}.json`);
	writeFileSync(evidencePath, bytes, { mode: 0o600 });
	return {
		expectedRoot,
		evidencePath,
		expectedDeployedSha: deployedSha,
		acceptedClaim: {
			predicate: "qa_passed",
			subjectKind: "git_head",
			subjectDigest: testedHeadSha,
			issuerExecutionId: "qa-exec",
			summary: `FLY2729_DAEMON_EVIDENCE sha256=${digest} path=${evidencePath}`,
		},
		land: { testedHeadSha, mergeSha },
		deployment: { mergeSha, deployedSha },
	};
}

it("leaves a wholly absent dependency pending", () => {
	expect(
		readFly2729Dependency({
			expectedRoot: "/tmp/unused",
			expectedDeployedSha: "a".repeat(40),
		}),
	).toEqual({ status: "pending" });
});

it("requires immutable evidence, accepted claim, land mapping, and deployment mapping together", () => {
	const input = fixture();
	expect(readFly2729Dependency(input)).toMatchObject({ status: "verified" });
	expect(
		readFly2729Dependency({
			...input,
			acceptedClaim: { ...input.acceptedClaim, summary: "forged PASS" },
		}),
	).toEqual({ status: "invalid", reason: "dependency_claim_mismatch" });
	expect(
		readFly2729Dependency({
			...input,
			deployment: { ...input.deployment, mergeSha: "d".repeat(40) },
		}),
	).toEqual({ status: "invalid", reason: "dependency_deployment_mismatch" });
});

it("rejects an external dependency input that tries to override trusted bindings", () => {
	const { expectedRoot, expectedDeployedSha, ...dependency } = fixture();
	expect(
		readBoundFly2729Dependency(
			{ expectedRoot, expectedDeployedSha },
			{ ...dependency, expectedRoot: "/tmp/untrusted-root" },
		),
	).toEqual({ status: "invalid", reason: "dependency_binding_override" });
	expect(
		readBoundFly2729Dependency(
			{ expectedRoot, expectedDeployedSha },
			{ ...dependency, expectedDeployedSha: "d".repeat(40) },
		),
	).toEqual({ status: "invalid", reason: "dependency_binding_override" });
});

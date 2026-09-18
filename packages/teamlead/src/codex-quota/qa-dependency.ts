import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReadinessDependencyState } from "./registered-home-readiness.js";

export interface Fly2729AcceptedClaim {
	predicate: string;
	subjectKind: string;
	subjectDigest: string;
	issuerExecutionId: string;
	summary: string;
}

export interface Fly2729DependencyInput {
	expectedRoot: string;
	evidencePath?: string;
	acceptedClaim?: Fly2729AcceptedClaim;
	land?: { testedHeadSha: string; mergeSha: string };
	deployment?: { mergeSha: string; deployedSha: string };
	expectedDeployedSha: string;
}

function invalid(reason: string): ReadinessDependencyState {
	return { status: "invalid", reason };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isoInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

/** Validate the immutable QA file + accepted claim + land/deploy identity chain. */
export function readFly2729Dependency(
	input: Fly2729DependencyInput,
): ReadinessDependencyState {
	if (
		!input.evidencePath &&
		!input.acceptedClaim &&
		!input.land &&
		!input.deployment
	) {
		return { status: "pending" };
	}
	if (
		!input.evidencePath ||
		!input.acceptedClaim ||
		!input.land ||
		!input.deployment
	) {
		return invalid("dependency_chain_incomplete");
	}
	if (
		!isAbsolute(input.expectedRoot) ||
		resolve(input.expectedRoot) !== input.expectedRoot ||
		!isAbsolute(input.evidencePath) ||
		resolve(input.evidencePath) !== input.evidencePath
	) {
		return invalid("dependency_path_invalid");
	}
	const rel = relative(input.expectedRoot, input.evidencePath);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		return invalid("dependency_path_escape");
	}
	let bytes: Buffer;
	try {
		const root = lstatSync(input.expectedRoot);
		let cursor = input.expectedRoot;
		for (const component of rel.split(sep).slice(0, -1)) {
			cursor = join(cursor, component);
			const directory = lstatSync(cursor);
			if (
				!directory.isDirectory() ||
				directory.isSymbolicLink() ||
				(directory.mode & 0o777) !== 0o700
			) {
				return invalid("dependency_directory_unsafe");
			}
		}
		const file = lstatSync(input.evidencePath);
		if (
			!root.isDirectory() ||
			root.isSymbolicLink() ||
			(root.mode & 0o777) !== 0o700 ||
			!file.isFile() ||
			file.isSymbolicLink() ||
			file.size > 64 * 1024 ||
			(file.mode & 0o777) !== 0o600
		) {
			return invalid("dependency_file_unsafe");
		}
		bytes = readFileSync(input.evidencePath);
	} catch {
		return invalid("dependency_file_unavailable");
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (
		input.evidencePath !==
		join(input.expectedRoot, input.land.testedHeadSha, `${digest}.json`)
	) {
		return invalid("dependency_digest_path_mismatch");
	}
	let evidence: unknown;
	try {
		evidence = JSON.parse(bytes.toString("utf8"));
	} catch {
		return invalid("dependency_json_invalid");
	}
	if (
		!plainObject(evidence) ||
		!exactKeys(evidence, [
			"schemaVersion",
			"issueId",
			"testedHeadSha",
			"qaExecutionId",
			"observedAt",
			"scenario",
			"homes",
			"result",
		]) ||
		evidence.schemaVersion !== 1 ||
		evidence.issueId !== "FLY-2729" ||
		evidence.testedHeadSha !== input.land.testedHeadSha ||
		typeof evidence.qaExecutionId !== "string" ||
		!/^[A-Za-z0-9_.-]{1,160}$/.test(evidence.qaExecutionId) ||
		!isoInstant(evidence.observedAt) ||
		evidence.scenario !== "isolated_usage_limit" ||
		evidence.result !== "PASS" ||
		!Array.isArray(evidence.homes) ||
		evidence.homes.length === 0
	) {
		return invalid("dependency_schema_invalid");
	}
	for (const home of evidence.homes) {
		if (
			!plainObject(home) ||
			!exactKeys(home, [
				"homeId",
				"daemonBefore",
				"daemonAfter",
				"targetAccountKey",
				"requestAfterReload",
				"leadPidUnchanged",
				"threadUnchanged",
				"windowUnchanged",
			]) ||
			typeof home.homeId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(home.homeId) ||
			typeof home.targetAccountKey !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(home.targetAccountKey) ||
			!plainObject(home.daemonBefore) ||
			!plainObject(home.daemonAfter) ||
			!Number.isSafeInteger(home.daemonBefore.pid) ||
			!Number.isSafeInteger(home.daemonAfter.pid) ||
			typeof home.daemonBefore.startIdentity !== "string" ||
			typeof home.daemonAfter.startIdentity !== "string" ||
			(home.daemonBefore.pid === home.daemonAfter.pid &&
				home.daemonBefore.startIdentity === home.daemonAfter.startIdentity) ||
			!plainObject(home.requestAfterReload) ||
			home.requestAfterReload.ok !== true ||
			typeof home.requestAfterReload.requestId !== "string" ||
			home.leadPidUnchanged !== true ||
			home.threadUnchanged !== true ||
			home.windowUnchanged !== true
		) {
			return invalid("dependency_home_evidence_invalid");
		}
	}
	const marker = `FLY2729_DAEMON_EVIDENCE sha256=${digest} path=${input.evidencePath}`;
	if (
		input.acceptedClaim.predicate !== "qa_passed" ||
		input.acceptedClaim.subjectKind !== "git_head" ||
		input.acceptedClaim.subjectDigest !== input.land.testedHeadSha ||
		input.acceptedClaim.issuerExecutionId !== evidence.qaExecutionId ||
		!input.acceptedClaim.summary.includes(marker)
	) {
		return invalid("dependency_claim_mismatch");
	}
	if (
		input.deployment.mergeSha !== input.land.mergeSha ||
		input.deployment.deployedSha !== input.expectedDeployedSha ||
		!/^[a-f0-9]{40}$/.test(input.land.testedHeadSha) ||
		!/^[a-f0-9]{40}$/.test(input.land.mergeSha) ||
		!/^[a-f0-9]{40}$/.test(input.deployment.deployedSha)
	) {
		return invalid("dependency_deployment_mismatch");
	}
	return { status: "verified", evidenceDigest: digest };
}

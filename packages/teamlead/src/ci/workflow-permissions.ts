/**
 * FLY-350 (Z) unit 6 / R4-2 — GitHub Actions workflow-permission scanner.
 *
 * A write-capable Codex Lead can OPEN a PR via the gateway (unit 4). That PR
 * triggers `pull_request` CI. If a `pull_request` workflow runs with a
 * write-capable GITHUB_TOKEN (the repo default, when no `permissions:` block is
 * declared), a model-authored PR could ride CI's token to comment / dispatch /
 * merge — an INDIRECT action channel around the structural "Mufasa cannot
 * :cool:" guarantee (R3-2). This scanner is the regression guard: every
 * `pull_request` workflow MUST pin a least-privilege `permissions:` block (no
 * write), and `pull_request_target` (which runs with a write token against
 * UNTRUSTED PR head code) is flagged for explicit review.
 *
 * Pure (YAML in, violations out) so it is both unit-tested with synthetic
 * fixtures AND run against the repo's real `.github/workflows/*` (zero
 * violations = the invariant holds).
 */

import { parse as parseYaml } from "yaml";

export interface WorkflowViolation {
	file: string;
	reason: string;
}

/** Normalize a workflow `on:` value (string | string[] | map) to a trigger list. */
function triggersOf(on: unknown): string[] {
	if (typeof on === "string") return [on];
	if (Array.isArray(on))
		return on.filter((t): t is string => typeof t === "string");
	if (on && typeof on === "object")
		return Object.keys(on as Record<string, unknown>);
	return [];
}

/** Return a violation reason if `permissions` grants more than least-privilege
 * read, else undefined. Accepts the `read-all` string and a map whose every
 * value is `read`/`none`; rejects `write-all`, any `write` scope, and a missing
 * block (handled by the caller). */
function permsViolation(permissions: unknown): string | undefined {
	if (permissions === "read-all" || permissions === "none") return undefined;
	if (permissions === "write-all") {
		return "permissions: write-all on a PR workflow (grants a write token)";
	}
	if (typeof permissions === "string") {
		return `permissions: "${permissions}" is not an allowed least-privilege value`;
	}
	if (!permissions || typeof permissions !== "object") {
		return "permissions block is malformed";
	}
	const map = permissions as Record<string, unknown>;
	const writeScopes = Object.entries(map)
		.filter(([, v]) => String(v).toLowerCase() === "write")
		.map(([k]) => k);
	if (writeScopes.length > 0) {
		return `grants write to [${writeScopes.sort().join(", ")}] — a PR workflow must be read-only (least privilege)`;
	}
	return undefined;
}

/**
 * Scan workflow files. A workflow that triggers on `pull_request` must declare a
 * top-level least-privilege `permissions:` block (no write). `pull_request_target`
 * is always flagged. Returns ALL violations (empty = clean).
 */
export function scanWorkflowPermissions(
	files: Array<{ name: string; content: string }>,
): WorkflowViolation[] {
	const violations: WorkflowViolation[] = [];
	for (const { name, content } of files) {
		let doc: Record<string, unknown>;
		try {
			doc = (parseYaml(content) ?? {}) as Record<string, unknown>;
		} catch (e) {
			violations.push({
				file: name,
				reason: `unparseable YAML: ${(e as Error).message}`,
			});
			continue;
		}
		const triggers = triggersOf(doc.on);
		const hasPR = triggers.includes("pull_request");
		const hasPRT = triggers.includes("pull_request_target");
		if (hasPRT) {
			violations.push({
				file: name,
				reason:
					"uses pull_request_target — runs with a write token against untrusted PR head code; requires explicit security review",
			});
		}
		if (!hasPR) continue; // not a pull_request workflow (push-only / other)
		if (!("permissions" in doc)) {
			violations.push({
				file: name,
				reason:
					"pull_request workflow has no top-level `permissions:` block (inherits the repo-default token scope — pin to least privilege, e.g. `permissions: contents: read`)",
			});
		} else {
			const v = permsViolation(doc.permissions);
			if (v) violations.push({ file: name, reason: v });
		}
		// A job-level `jobs.<id>.permissions` OVERRIDES the top-level block and can
		// re-grant write even when the top level is read-only — scan every job too
		// (Codex review MEDIUM). A job that OMITS permissions inherits the (already
		// validated) top-level block, so only an explicit job-level block is checked.
		const jobs = doc.jobs;
		if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
			for (const [jobId, jobDef] of Object.entries(
				jobs as Record<string, unknown>,
			)) {
				if (
					jobDef &&
					typeof jobDef === "object" &&
					"permissions" in (jobDef as Record<string, unknown>)
				) {
					const jv = permsViolation(
						(jobDef as Record<string, unknown>).permissions,
					);
					if (jv) {
						violations.push({ file: name, reason: `job "${jobId}": ${jv}` });
					}
				}
			}
		}
	}
	return violations;
}

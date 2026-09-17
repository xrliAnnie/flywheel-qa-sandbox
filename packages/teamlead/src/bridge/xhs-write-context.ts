import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import {
	forwardedLeadAuthorizationEnv,
	validateClaudeLeadLeaseAuthorization,
	validateLeadCarrierAuthorization,
} from "flywheel-comm/lead-lease";
import { z } from "zod";
import { parseStrictJson } from "../xiaohongshu-write/canonical.js";

const id = z.string().min(1).max(256);
const claimSchema = z
	.object({
		projectName: id,
		leadId: id,
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		leaseClaim: z
			.object({
				leaseKey: id,
				generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			})
			.strict()
			.optional(),
		carrierClaim: id.optional(),
		activationId: z.string().uuid().optional(),
	})
	.strict();
/** Called by the token-authenticated Bridge route with its own environment.
 * Header references select current evidence; they never establish it. */
export function createXhsWriteContext(
	header: unknown,
	inputEnv: NodeJS.ProcessEnv,
) {
	try {
		if (typeof header !== "string" || header.length > 8192) throw Error();
		const bytes = Buffer.from(header, "base64");
		if (bytes.toString("base64") !== header) throw Error();
		const claim = claimSchema.parse(
			parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		);
		const env = Object.freeze({ ...inputEnv });
		const home = env.FLYWHEEL_SUMMARY_CONFIG_HOME ?? env.HOME ?? homedir();
		const projectsPath =
			env.FLYWHEEL_PROJECTS_FILE ?? join(home, ".flywheel/projects.json");
		if (!isAbsolute(home) || !isAbsolute(projectsPath)) throw Error();
		const claimEnv = forwardedLeadAuthorizationEnv(
			{ ...claim, claimedLeadId: claim.leadId },
			{ ...env, HOME: home, FLYWHEEL_PROJECTS_FILE: projectsPath },
		);
		const read = () =>
			resolveLeadIdentityRow({
				projectsPath,
				homeDir: home,
				projectName: claim.projectName,
				leadId: claim.leadId,
			});
		const observe = () => {
			const row = read();
			if (row.identity.identityDigest !== claim.identityDigest) throw Error();
			const rowJson = JSON.stringify(row);
			let activationId: string, binding: unknown;
			if (row.identity.backend === "claude-code") {
				if (!claim.leaseClaim || claim.carrierClaim || claim.activationId)
					throw Error();
				const result = validateClaudeLeadLeaseAuthorization({
					claimedLeadId: claim.leadId,
					env: claimEnv,
				});
				if (
					!result.valid ||
					result.generation !== claim.leaseClaim.generation ||
					result.leadKey !== claim.leaseClaim.leaseKey
				)
					throw Error();
				binding = result;
				activationId = `claude-lease:${createHash("sha256")
					.update(
						JSON.stringify([
							claim.identityDigest,
							result.leadKey,
							result.generation,
							result.holderPid,
							result.holderStart,
						]),
					)
					.digest("hex")}`;
			} else if (row.identity.backend === "codex-app-server") {
				if (
					claim.leaseClaim ||
					!claim.carrierClaim ||
					!claim.activationId ||
					row.identity.role !== "dept" ||
					row.lead.codexCapabilityBundleVersion !== 2 ||
					row.lead.codexProfile !== "full-access"
				)
					throw Error();
				const result = validateLeadCarrierAuthorization({
					claimedLeadId: claim.leadId,
					env: claimEnv,
				});
				if (!result.valid || result.processIndeterminate) throw Error();
				binding = [
					result.carrier.instanceDigest,
					result.carrier.pid,
					result.carrier.lstart,
				];
				activationId = claim.activationId;
			} else throw Error();
			if (JSON.stringify(read()) !== rowJson) throw Error();
			return {
				activationId,
				projectRoot: row.project.projectRoot,
				pin: JSON.stringify([rowJson, binding]),
			};
		};
		const initial = observe();
		return Object.freeze({
			scope: Object.freeze({
				projectId: claim.projectName,
				leadId: claim.leadId,
				activationId: initial.activationId,
			}),
			projectRoot() {
				try {
					const current = observe();
					const root = current.projectRoot;
					if (
						current.pin !== initial.pin ||
						typeof root !== "string" ||
						!isAbsolute(root) ||
						realpathSync(root) !== root ||
						!lstatSync(root).isDirectory()
					)
						throw Error();
					if (observe().pin !== initial.pin) throw Error();
					return root;
				} catch {
					throw Error("xhs_identity_denied");
				}
			},
			assertCurrent() {
				try {
					if (observe().pin !== initial.pin) throw Error();
				} catch {
					throw Error("xhs_identity_denied");
				}
			},
		});
	} catch {
		throw Error("xhs_identity_denied");
	}
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { validateLeadCarrierAuthorization } from "flywheel-comm/lead-lease";
import { readSummaryGranularity } from "flywheel-comm/summary-config";
import { parseAndValidateProjects } from "../ProjectConfig.js";

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

/**
 * Capture the expensive registry/carrier proof once per Bridge request. Guards
 * around awaits and side effects compare lightweight authorization-source
 * revisions; they never fork `ps` or reparse projects.json.
 */
export function captureLeadCapabilityScope(options: {
	projectsPath: string;
	homeDir: string;
	projectName: string;
	leadId: string;
	identityDigest: string;
	claimEnv: NodeJS.ProcessEnv;
	denied(): Error;
	rejectChatChannel?: string;
}) {
	const source = readFileSync(options.projectsPath, "utf8"),
		projectsDigest = sha256(source),
		row = resolveLeadIdentityRow({
			projectsPath: options.projectsPath,
			homeDir: options.homeDir,
			projectName: options.projectName,
			leadId: options.leadId,
		}),
		carrier = validateLeadCarrierAuthorization({
			claimedLeadId: options.leadId,
			env: options.claimEnv,
		});
	if (
		row.identity.projectsDigest !== projectsDigest ||
		row.identity.identityDigest !== options.identityDigest ||
		row.identity.backend !== "codex-app-server" ||
		row.identity.role !== "dept" ||
		row.lead.codexCapabilityBundleVersion !== 2 ||
		row.lead.codexProfile !== "full-access" ||
		!carrier.valid ||
		carrier.processIndeterminate
	)
		throw options.denied();
	const carrierEvidencePath =
			options.claimEnv.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE ??
			join(options.homeDir, ".flywheel", "lead-carrier-evidence.json"),
		readCarrierRevision = () => {
			try {
				const text = readFileSync(carrierEvidencePath, "utf8");
				if (!("carrier" in carrier)) return sha256(text);
				const document = JSON.parse(text) as {
					leads?: Record<string, unknown>;
				};
				const entry = document.leads?.[carrier.leadKey];
				if (!entry) throw options.denied();
				return sha256(JSON.stringify(entry));
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code === "ENOENT" &&
					!("carrier" in carrier)
				)
					return undefined;
				throw options.denied();
			}
		},
		carrierRevision = readCarrierRevision();
	const projects = parseAndValidateProjects(JSON.parse(source)),
		project = projects.find(
			(candidate) => candidate.projectName === options.projectName,
		),
		lead = project?.leads.find(
			(candidate) => candidate.agentId === options.leadId,
		);
	if (
		!project ||
		!lead ||
		(options.rejectChatChannel !== undefined &&
			lead.chatChannel === options.rejectChatChannel.trim())
	)
		throw options.denied();
	const summaryRevision = JSON.stringify(
		readSummaryGranularity({ homeDir: options.homeDir }),
	);
	function assertSourceCurrent() {
		if (
			sha256(readFileSync(options.projectsPath, "utf8")) !== projectsDigest ||
			JSON.stringify(readSummaryGranularity({ homeDir: options.homeDir })) !==
				summaryRevision ||
			readCarrierRevision() !== carrierRevision
		)
			throw options.denied();
	}
	assertSourceCurrent();
	return { row, projects, project, lead, assertSourceCurrent };
}

export interface LeadIdentityCommandDeps {
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	homeDir?: string;
	failureDir?: string;
	now?: () => string;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
}

export function runLeadIdentityCommand(
	args: string[],
	deps: LeadIdentityCommandDeps = {},
): number | Promise<number> {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	let projectsPath: string | undefined;
	let projectName: string | undefined;
	let leadId: string | undefined;
	try {
		if (
			args[0] !== "resolve" &&
			args[0] !== "record-failure" &&
			args[0] !== "migrate-bot-user-ids"
		) {
			throw new Error(
				"expected subcommand: resolve|record-failure|migrate-bot-user-ids",
			);
		}
		const { values } = parseArgs({
			args: args.slice(1),
			options: {
				"projects-file": { type: "string" },
				project: { type: "string" },
				lead: { type: "string" },
				code: { type: "string" },
				message: { type: "string" },
				format: { type: "string", default: "json" },
				"roster-file": { type: "string" },
				"backup-file": { type: "string" },
				"summary-config-home": { type: "string" },
			},
			allowPositionals: false,
		});
		projectsPath = required(values["projects-file"], "--projects-file");
		const summaryConfigHome = values["summary-config-home"];
		if (summaryConfigHome !== undefined) {
			if (args[0] !== "resolve") {
				throw new Error("--summary-config-home is only valid for resolve");
			}
			if (!isAbsolute(summaryConfigHome)) {
				throw new Error("--summary-config-home must be an absolute path");
			}
		}
		if (args[0] === "migrate-bot-user-ids") {
			const rosterPath = required(values["roster-file"], "--roster-file");
			const backupPath = required(values["backup-file"], "--backup-file");
			return migrateLeadBotUserIds({
				projectsPath,
				rosterPath,
				backupPath,
				homeDir: deps.homeDir,
				env: deps.env,
				fetch: deps.fetch,
			})
				.then((result) => {
					stdout(JSON.stringify(result));
					return 0;
				})
				.catch((error) => {
					stderr(
						JSON.stringify({
							ok: false,
							code:
								error instanceof LeadIdentityMigrationError
									? error.code
									: "identity_migration_source_error",
							message: error instanceof Error ? error.message : String(error),
						}),
					);
					return 1;
				});
		}
		projectName = required(values.project, "--project");
		leadId = required(values.lead, "--lead");
		if (args[0] === "record-failure") {
			const code = required(values.code, "--code");
			if (!/^identity_[a-z0-9_]+$/.test(code)) {
				throw new Error("--code must be a structured identity_* code");
			}
			const marker = writeLeadIdentityFailureMarker({
				projectsPath,
				projectName,
				leadId,
				code,
				message: values.message ?? code,
				failureDir: deps.failureDir,
				env: deps.env,
				now: deps.now,
			});
			stdout(JSON.stringify(marker));
			return 0;
		}
		if (values.format !== "json" && values.format !== "env") {
			throw new Error('--format must be "json" or "env"');
		}
		const identity = resolveLeadIdentity({
			projectsPath,
			projectName,
			leadId,
			homeDir: summaryConfigHome ?? deps.homeDir,
		});
		if (values.format === "json") {
			stdout(JSON.stringify(identity));
		} else {
			for (const line of identityEnvProjection(identity)) stdout(line);
		}
		return 0;
	} catch (error) {
		const code =
			error instanceof LeadIdentityError
				? error.code
				: error instanceof SummaryAssignmentError ||
						error instanceof SummaryConfigError
					? error.code
					: "identity_command_invalid";
		const message = error instanceof Error ? error.message : String(error);
		if (projectsPath && projectName && leadId) {
			try {
				writeLeadIdentityFailureMarker({
					projectsPath,
					projectName,
					leadId,
					code,
					message,
					failureDir: deps.failureDir,
					env: deps.env,
					now: deps.now,
				});
			} catch (markerError) {
				stderr(
					JSON.stringify({
						ok: false,
						code: "identity_failure_marker_write_failed",
						message:
							markerError instanceof Error
								? markerError.message
								: String(markerError),
					}),
				);
			}
		}
		stderr(
			JSON.stringify({
				ok: false,
				code,
				message,
			}),
		);
		return 1;
	}
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function identityEnvProjection(
	identity: CanonicalLeadIdentity,
): string[] {
	return [
		`FLYWHEEL_LEAD_ID=${identity.leadId}`,
		`LEAD_ID=${identity.leadId}`,
		`FLYWHEEL_PROJECT_NAME=${identity.projectName}`,
		`PROJECT_NAME=${identity.projectName}`,
		`FLYWHEEL_LEAD_KEY=${identity.leadKey}`,
		`FLYWHEEL_LEAD_ROLE=${identity.role}`,
		`FLYWHEEL_LEAD_BACKEND=${identity.backend}`,
		`FLYWHEEL_LEAD_SUMMARY_ROLE=${identity.summaryRole}`,
		`FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=${identity.hasSummaryDuty ? "1" : "0"}`,
		`FLYWHEEL_SUMMARY_GRANULARITY=${identity.summaryGranularity ?? ""}`,
		`FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=${identity.summaryAssignmentDigest ?? ""}`,
		`DISCORD_STATE_DIR=${identity.discordStateDir}`,
		`DISCORD_EXPECTED_BOT_USER_ID=${identity.botUserId ?? ""}`,
		"DISCORD_IDENTITY_MODE=managed",
		`FLYWHEEL_LEAD_IDENTITY_DIGEST=${identity.identityDigest}`,
		`FLYWHEEL_LEAD_PROJECTS_DIGEST=${identity.projectsDigest}`,
	];
}

import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import {
	type CanonicalLeadIdentity,
	LeadIdentityError,
	resolveLeadIdentity,
} from "../lead-identity.js";
import { writeLeadIdentityFailureMarker } from "../lead-identity-failure.js";
import {
	LeadIdentityMigrationError,
	migrateLeadBotUserIds,
} from "../lead-identity-migration.js";
import { SummaryAssignmentError } from "../summary-assignment-core.js";
import { SummaryConfigError } from "../summary-config.js";

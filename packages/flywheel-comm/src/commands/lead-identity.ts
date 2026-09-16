import { resolveCodexLeadCapabilities } from "flywheel-config";
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
				"include-capabilities": { type: "boolean", default: false },
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
		const row = resolveLeadIdentityRow({
			projectsPath,
			projectName,
			leadId,
			homeDir: summaryConfigHome ?? deps.homeDir,
		});
		const identity = row.identity;
		const capabilities = values["include-capabilities"]
			? resolveCodexLeadCapabilities(row.lead)
			: undefined;
		if (values.format === "json") {
			stdout(
				JSON.stringify(
					capabilities
						? { ...identity, codexCapabilities: capabilities }
						: identity,
				),
			);
		} else {
			for (const line of identityEnvProjection(identity)) stdout(line);
			if (capabilities)
				stdout(
					`FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS=${capabilities.runnerActionsEnabled ? "1" : "0"}`,
				);
			if (capabilities?.capabilityBundleVersion === 2)
				stdout("FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION=2");
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

export { identityEnvProjection } from "../lead-identity.js";

import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import {
	identityEnvProjection,
	LeadIdentityError,
	resolveLeadIdentityRow,
} from "../lead-identity.js";
import { writeLeadIdentityFailureMarker } from "../lead-identity-failure.js";
import {
	LeadIdentityMigrationError,
	migrateLeadBotUserIds,
} from "../lead-identity-migration.js";
import { SummaryAssignmentError } from "../summary-assignment-core.js";
import { SummaryConfigError } from "../summary-config.js";

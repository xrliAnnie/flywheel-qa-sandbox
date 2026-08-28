import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	migrateSummaryRegistry,
	SummaryRegistryError,
	verifySummaryRegistryActivation,
} from "../summary-registry-migration.js";

export interface SummaryRegistryCommandDeps {
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	validateTeamleadCandidate?: (candidatePath: string) => void;
	now?: () => string;
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function defaultTeamleadValidator(candidatePath: string): void {
	const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "../../..");
	const configured = process.env.FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR;
	const validator =
		configured ?? join(packagesDir, "teamlead/src/bin/validate-projects.ts");
	const result = configured
		? spawnSync(process.execPath, [validator, candidatePath], {
				encoding: "utf8",
			})
		: spawnSync(
				"pnpm",
				[
					"--dir",
					join(packagesDir, ".."),
					"exec",
					"tsx",
					validator,
					candidatePath,
				],
				{
					encoding: "utf8",
				},
			);
	if (result.error || result.status !== 0) {
		throw new Error(
			`TeamLead validator rejected candidate: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`,
		);
	}
}

export function runSummaryRegistryCommand(
	args: string[],
	deps: SummaryRegistryCommandDeps = {},
): number {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	const env = deps.env ?? process.env;
	try {
		const subcommand = args[0];
		if (subcommand !== "migrate" && subcommand !== "verify-activation") {
			throw new Error("expected subcommand: migrate|verify-activation");
		}
		const { values } = parseArgs({
			args: args.slice(1),
			options: {
				"projects-file": { type: "string" },
				"assignments-file": { type: "string" },
				"receipt-file": { type: "string" },
				"expected-sha256": { type: "string" },
			},
			allowPositionals: false,
		});
		const projectsPath = required(values["projects-file"], "--projects-file");
		const receiptPath = required(values["receipt-file"], "--receipt-file");
		const validateTeamleadCandidate =
			deps.validateTeamleadCandidate ?? defaultTeamleadValidator;
		if (subcommand === "migrate") {
			if (env.FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD !== "1") {
				stderr(
					JSON.stringify({
						ok: false,
						code: "summary_registry_lock_required",
						message:
							"run migration through scripts/migrate-summary-registry.sh so the shared projects-config lock is held",
					}),
				);
				return 1;
			}
			const receipt = migrateSummaryRegistry(
				{
					projectsPath,
					assignmentsPath: required(
						values["assignments-file"],
						"--assignments-file",
					),
					receiptPath,
					expectedSha256: required(
						values["expected-sha256"],
						"--expected-sha256",
					),
					homeDir: deps.homeDir,
				},
				{ validateTeamleadCandidate, now: deps.now },
			);
			stdout(JSON.stringify(receipt));
			return 0;
		}
		const receipt = verifySummaryRegistryActivation(
			{ projectsPath, receiptPath, homeDir: deps.homeDir },
			{ validateTeamleadCandidate },
		);
		stdout(
			JSON.stringify({
				ok: true,
				granularity: receipt.granularity,
				summaryAssignmentDigest: receipt.summaryAssignmentDigest,
			}),
		);
		return 0;
	} catch (error) {
		stderr(
			JSON.stringify({
				ok: false,
				code:
					error instanceof SummaryRegistryError
						? error.code
						: "summary_registry_command_invalid",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return 1;
	}
}

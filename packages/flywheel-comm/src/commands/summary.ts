import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { SummaryGranularity } from "../summary-config.js";
import {
	buildSummaryPath,
	validateSummaryArtifact,
} from "../summary-contract.js";
import { createGitHubSummaryDelivery } from "../summary-delivery.js";
import {
	createGitHubCliSummaryVerifier,
	type SummaryVerifierGitHub,
	verifySummaryPullRequest,
} from "../summary-pr-verifier.js";

const TARGET_REPO = "xrliAnnie/raya";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SummaryDeliveryKey {
	repo: string;
	project: string;
	author: string;
	period: string;
	granularity: SummaryGranularity;
	assignmentDigest: string;
}

export type SummaryDeliveryState =
	| { state: "none" }
	| {
			state: "open";
			prNumber: number;
			url: string;
			branch: string;
			path?: string;
	  }
	| { state: "merged" | "closed"; prNumber: number; url: string };

export interface SummaryDeliveryInput extends SummaryDeliveryKey {
	content: string;
	existing?: Extract<SummaryDeliveryState, { state: "open" }>;
}

export interface SummaryDeliveryResult {
	prNumber: number;
	url: string;
	path?: string;
}

export interface SummaryDelivery {
	inspect(key: SummaryDeliveryKey): Promise<SummaryDeliveryState>;
	create(input: SummaryDeliveryInput): Promise<SummaryDeliveryResult>;
	update(input: SummaryDeliveryInput): Promise<SummaryDeliveryResult>;
}

export interface SummaryCommandDeps {
	env?: NodeJS.ProcessEnv;
	readFile?: (path: string) => string;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	delivery?: SummaryDelivery;
	verifierGitHub?: SummaryVerifierGitHub;
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`summary_command_invalid: ${name} is required`);
	return value;
}

function canonicalIdentity(env: NodeJS.ProcessEnv): {
	project: string;
	author: string;
	granularity: SummaryGranularity;
	assignmentDigest: string;
} {
	const project = required(env.FLYWHEEL_PROJECT_NAME, "FLYWHEEL_PROJECT_NAME");
	const author = required(env.FLYWHEEL_LEAD_ID, "FLYWHEEL_LEAD_ID");
	if (!SAFE_ID.test(project) || !SAFE_ID.test(author)) {
		throw new Error(
			"summary_identity_invalid: canonical project/Lead id is unsafe",
		);
	}
	if (env.FLYWHEEL_LEAD_HAS_SUMMARY_DUTY !== "1") {
		throw new Error(
			"summary_duty_required: canonical identity does not have summary duty",
		);
	}
	const granularity = env.FLYWHEEL_SUMMARY_GRANULARITY;
	if (granularity !== "per-lead" && granularity !== "per-project") {
		throw new Error(
			"summary_granularity_invalid: canonical summary granularity is missing or invalid",
		);
	}
	const assignmentDigest = env.FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST;
	if (!assignmentDigest || !/^[a-f0-9]{64}$/.test(assignmentDigest)) {
		throw new Error(
			"summary_assignment_digest_invalid: canonical assignment digest is missing or malformed",
		);
	}
	return { project, author, granularity, assignmentDigest };
}

export async function runSummaryCommand(
	args: string[],
	deps: SummaryCommandDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	try {
		if (args[0] === "verify-pr") {
			const { values } = parseArgs({
				args: args.slice(1),
				options: {
					pr: { type: "string" },
					repo: { type: "string", default: TARGET_REPO },
				},
				allowPositionals: false,
			});
			if (
				values.repo !== "xrliAnnie/raya" &&
				values.repo !== "xrliAnnie/raya-memory"
			) {
				throw new Error(
					"summary_verifier_repo_forbidden: verifier is limited to Raya's own repositories",
				);
			}
			const prNumber = Number(required(values.pr, "--pr"));
			const granularity = (deps.env ?? process.env)
				.FLYWHEEL_SUMMARY_GRANULARITY;
			if (granularity !== "per-lead" && granularity !== "per-project") {
				throw new Error(
					"summary_granularity_invalid: canonical summary granularity is missing or invalid",
				);
			}
			const result = await verifySummaryPullRequest(
				{ repo: values.repo, prNumber, granularity },
				deps.verifierGitHub ?? createGitHubCliSummaryVerifier(),
			);
			stdout(JSON.stringify(result));
			return 0;
		}
		const { values } = parseArgs({
			args,
			options: {
				file: { type: "string" },
				project: { type: "string" },
				period: { type: "string" },
				"dry-run": { type: "boolean", default: false },
			},
			allowPositionals: false,
		});
		const file = required(values.file, "--file");
		const requestedProject = required(values.project, "--project");
		const period = required(values.period, "--period");
		const identity = canonicalIdentity(deps.env ?? process.env);
		if (requestedProject !== identity.project) {
			throw new Error(
				`summary_project_mismatch: requested ${requestedProject}, canonical ${identity.project}`,
			);
		}
		const content = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(
			file,
		);
		// Validate authorship and content without consulting or mutating the target
		// repository. The delivery layer selects the real collision-free sequence.
		validateSummaryArtifact({
			path: buildSummaryPath({
				project: identity.project,
				lead: identity.author,
				period,
				sequence: 1,
				granularity: identity.granularity,
			}),
			content,
			granularity: identity.granularity,
			expectedProject: identity.project,
			expectedLead: identity.author,
			expectedPeriod: period,
		});
		const key: SummaryDeliveryKey = {
			repo: TARGET_REPO,
			project: identity.project,
			author: identity.author,
			period,
			granularity: identity.granularity,
			assignmentDigest: identity.assignmentDigest,
		};
		if (values["dry-run"]) {
			stdout(
				JSON.stringify({
					ok: true,
					dryRun: true,
					...key,
					sequence: "next-available",
				}),
			);
			return 0;
		}
		const delivery = deps.delivery ?? createGitHubSummaryDelivery();
		const state = await delivery.inspect(key);
		if (state.state === "merged" || state.state === "closed") {
			throw new Error(
				`summary_pr_already_${state.state}: idempotency key belongs to PR #${state.prNumber}; use an explicit next period/correction instead`,
			);
		}
		const result =
			state.state === "open"
				? await delivery.update({ ...key, content, existing: state })
				: await delivery.create({ ...key, content });
		stdout(
			JSON.stringify({
				ok: true,
				action: state.state === "open" ? "updated" : "created",
				...result,
			}),
		);
		return 0;
	} catch (error) {
		stderr(
			JSON.stringify({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return 1;
	}
}

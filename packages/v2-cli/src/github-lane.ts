import { execFileSync } from "node:child_process";

export type GitHubPermission =
	| "admin"
	| "maintain"
	| "write"
	| "triage"
	| "read"
	| "none";

export interface BranchProtectionEvidence {
	requiredApprovingReviewCount: number;
	requiredChecks: string[];
	bypassUsers: string[];
	bypassTeamCount: number;
	bypassAppCount: number;
}

export interface ActiveRulesEvidence {
	requiredChecks: string[];
	applicableRulesetIds: number[];
	bypassActorCount: number;
}

export interface GitHubLanePort {
	actor(): Promise<string>;
	permission(repo: string, actor: string): Promise<GitHubPermission>;
	branchProtection(
		repo: string,
		branch: string,
	): Promise<BranchProtectionEvidence>;
	activeRules(repo: string, branch: string): Promise<ActiveRulesEvidence>;
}

export interface GitHubLaneProbeInput {
	repo: string;
	branch: string;
	observedAt: string;
}

export interface GitHubLaneEvidence {
	v: 1;
	status: "pass" | "fail";
	repo: string;
	branch: string;
	observedAt: string;
	actor: string | null;
	permission: GitHubPermission | null;
	requiredChecks: string[];
	applicableRulesetIds: number[];
	failures: string[];
}

function requireTarget(input: GitHubLaneProbeInput): void {
	if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo)) {
		throw new TypeError("repo must be owner/name");
	}
	if (
		input.branch.trim().length === 0 ||
		input.branch.includes("..") ||
		/[\s~^:?*[\]\\]/.test(input.branch)
	) {
		throw new TypeError("branch is invalid");
	}
	const parsed = Date.parse(input.observedAt);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString() !== input.observedAt
	) {
		throw new TypeError("observedAt must be canonical UTC ISO-8601");
	}
}

export async function probeGitHubLane(
	github: GitHubLanePort,
	input: GitHubLaneProbeInput,
): Promise<GitHubLaneEvidence> {
	requireTarget(input);
	let actor: string | null = null;
	let permission: GitHubPermission | null = null;
	let requiredChecks: string[] = [];
	let applicableRulesetIds: number[] = [];
	const failures: string[] = [];
	try {
		actor = await github.actor();
		if (!actor) throw new Error("GitHub actor is empty");
		permission = await github.permission(input.repo, actor);
		if (permission === "admin") {
			failures.push(`actor ${actor} has admin permission`);
		}
		const protection = await github.branchProtection(input.repo, input.branch);
		const rules = await github.activeRules(input.repo, input.branch);
		requiredChecks = [
			...new Set([...protection.requiredChecks, ...rules.requiredChecks]),
		].sort();
		applicableRulesetIds = [...new Set(rules.applicableRulesetIds)].sort(
			(a, b) => a - b,
		);
		if (requiredChecks.length === 0) {
			failures.push("target branch has no required checks");
		}
		if (protection.requiredApprovingReviewCount < 1) {
			failures.push("target branch does not require an approving review");
		}
		if (
			protection.bypassUsers.includes(actor) ||
			protection.bypassTeamCount > 0 ||
			protection.bypassAppCount > 0 ||
			rules.bypassActorCount > 0
		) {
			failures.push("actor or applicable policy has an unprovable bypass");
		}
	} catch (error) {
		failures.push(
			`GitHub policy evidence unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return {
		v: 1,
		status: failures.length === 0 ? "pass" : "fail",
		repo: input.repo,
		branch: input.branch,
		observedAt: input.observedAt,
		actor,
		permission,
		requiredChecks,
		applicableRulesetIds,
		failures,
	};
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} response is malformed`);
	}
	return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function integer(value: unknown): number {
	return Number.isSafeInteger(value) && (value as number) >= 0
		? (value as number)
		: 0;
}

function strings(values: unknown[]): string[] {
	return values.filter(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
}

export class GhCliLanePort implements GitHubLanePort {
	readonly #ghBin: string;

	constructor(ghBin = "gh") {
		if (ghBin.trim().length === 0) throw new TypeError("ghBin is required");
		this.#ghBin = ghBin;
	}

	#api(path: string): unknown {
		const stdout = execFileSync(this.#ghBin, ["api", path], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return JSON.parse(stdout) as unknown;
	}

	async actor(): Promise<string> {
		const value = record(this.#api("user"), "actor");
		if (typeof value.login !== "string" || value.login.length === 0) {
			throw new Error("GitHub actor login is unavailable");
		}
		return value.login;
	}

	async permission(repo: string, actor: string): Promise<GitHubPermission> {
		const value = record(
			this.#api(`repos/${repo}/collaborators/${actor}/permission`),
			"permission",
		);
		if (
			typeof value.permission !== "string" ||
			!["admin", "maintain", "write", "triage", "read", "none"].includes(
				value.permission,
			)
		) {
			throw new Error("GitHub actor permission is unavailable");
		}
		return value.permission as GitHubPermission;
	}

	async branchProtection(
		repo: string,
		branch: string,
	): Promise<BranchProtectionEvidence> {
		const value = record(
			this.#api(
				`repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
			),
			"branch protection",
		);
		const reviews = record(
			value.required_pull_request_reviews,
			"required pull request reviews",
		);
		const status =
			value.required_status_checks === null
				? {}
				: record(value.required_status_checks, "required status checks");
		const bypass = record(
			reviews.bypass_pull_request_allowances ?? {},
			"pull request bypass allowances",
		);
		const checkObjects = array(status.checks).map((entry) =>
			record(entry, "required check"),
		);
		return {
			requiredApprovingReviewCount: integer(
				reviews.required_approving_review_count,
			),
			requiredChecks: [
				...strings(array(status.contexts)),
				...strings(checkObjects.map((entry) => entry.context)),
			],
			bypassUsers: strings(
				array(bypass.users).map((entry) => record(entry, "bypass user").login),
			),
			bypassTeamCount: array(bypass.teams).length,
			bypassAppCount: array(bypass.apps).length,
		};
	}

	async activeRules(
		repo: string,
		branch: string,
	): Promise<ActiveRulesEvidence> {
		const rules = array(
			this.#api(`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`),
		).map((entry) => record(entry, "active rule"));
		const applicableRulesetIds = [
			...new Set(
				rules
					.map((rule) => rule.ruleset_id)
					.filter(
						(value): value is number =>
							Number.isSafeInteger(value) && (value as number) > 0,
					),
			),
		];
		const requiredChecks = rules.flatMap((rule) => {
			if (rule.type !== "required_status_checks") return [];
			const parameters = record(
				rule.parameters,
				"required status checks parameters",
			);
			return strings(
				array(parameters.required_status_checks).map(
					(entry) => record(entry, "ruleset required status check").context,
				),
			);
		});
		let bypassActorCount = 0;
		for (const rulesetId of applicableRulesetIds) {
			const ruleset = record(
				this.#api(`repos/${repo}/rulesets/${rulesetId}?includes_parents=true`),
				"ruleset",
			);
			bypassActorCount += array(ruleset.bypass_actors).length;
		}
		return {
			requiredChecks,
			applicableRulesetIds,
			bypassActorCount,
		};
	}
}

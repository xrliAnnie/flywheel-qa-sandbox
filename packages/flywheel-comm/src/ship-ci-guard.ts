import { execFileSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}$/;

export type ShipCiGuardResult =
	| {
			green: true;
			reason: "ci_green";
			mergeStateStatus: string;
			checks: string[];
	  }
	| { green: false; reason: "ci_not_green"; detail: string };

export type ShipCiCommandRunner = (
	file: string,
	args: string[],
	options: { cwd: string; timeout: number },
) => string;

const defaultRun: ShipCiCommandRunner = (file, args, options) =>
	execFileSync(file, args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeout,
	});

/**
 * FLY-1314 material #8: prove the current PR's CI axis immediately before a
 * ship gate opens and again immediately before verify-approval authorizes
 * shipping. GitHub CLI is the authority already used by the landing flow.
 * Any missing/malformed/unknown observation fails closed.
 */
export function probeShipCiGreen(args: {
	cwd: string;
	prNumber?: number;
	expectedHead?: string;
	run?: ShipCiCommandRunner;
}): ShipCiGuardResult {
	const cwd = args.cwd.trim();
	if (!cwd) {
		return {
			green: false,
			reason: "ci_not_green",
			detail: "worktree path is missing",
		};
	}
	const expectedHead = args.expectedHead?.trim().toLowerCase();
	if (expectedHead && !FULL_SHA.test(expectedHead)) {
		return {
			green: false,
			reason: "ci_not_green",
			detail: "expected PR head is invalid",
		};
	}
	const selector =
		typeof args.prNumber === "number" &&
		Number.isSafeInteger(args.prNumber) &&
		args.prNumber > 0
			? [String(args.prNumber)]
			: [];
	const run = args.run ?? defaultRun;
	try {
		const view = JSON.parse(
			run(
				"gh",
				["pr", "view", ...selector, "--json", "headRefOid,mergeStateStatus"],
				{ cwd, timeout: 15_000 },
			),
		) as Record<string, unknown>;
		const observedHead =
			typeof view.headRefOid === "string"
				? view.headRefOid.trim().toLowerCase()
				: "";
		const mergeStateStatus =
			typeof view.mergeStateStatus === "string"
				? view.mergeStateStatus.trim().toUpperCase()
				: "";
		if (!FULL_SHA.test(observedHead)) {
			throw new Error("GitHub returned no full PR head SHA");
		}
		if (expectedHead && observedHead !== expectedHead) {
			throw new Error(
				`GitHub PR head ${observedHead} != expected ${expectedHead}`,
			);
		}
		if (
			!mergeStateStatus ||
			mergeStateStatus === "UNKNOWN" ||
			mergeStateStatus === "UNSTABLE" ||
			mergeStateStatus === "DIRTY"
		) {
			throw new Error(`mergeStateStatus=${mergeStateStatus || "missing"}`);
		}

		const checks = JSON.parse(
			run("gh", ["pr", "checks", ...selector, "--json", "bucket,name,state"], {
				cwd,
				timeout: 15_000,
			}),
		) as unknown;
		if (!Array.isArray(checks) || checks.length === 0) {
			throw new Error("no checks were reported");
		}
		const blocked = checks.find(
			(check) =>
				typeof check !== "object" ||
				check === null ||
				(check as Record<string, unknown>).bucket !== "pass",
		);
		if (blocked) {
			const row = blocked as Record<string, unknown>;
			throw new Error(
				`check ${String(row.name ?? "unknown")} is ${String(row.bucket ?? row.state ?? "unknown")}`,
			);
		}
		return {
			green: true,
			reason: "ci_green",
			mergeStateStatus,
			checks: checks.map((check) =>
				String((check as Record<string, unknown>).name ?? "unknown"),
			),
		};
	} catch (err) {
		return {
			green: false,
			reason: "ci_not_green",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

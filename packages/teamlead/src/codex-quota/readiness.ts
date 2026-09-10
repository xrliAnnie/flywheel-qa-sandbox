import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface CodexQuotaHomeObservation {
	home: string;
	ownership: "managed" | "independent" | "unknown";
	/** Supplied by reconciled process/CommDB/lease authority, never directory existence. */
	activity: "active" | "drained" | "unknown";
}

export interface CodexQuotaReadinessOptions {
	canonicalAuthPath: string;
	collectHomes(): Promise<{
		complete: boolean;
		homes: CodexQuotaHomeObservation[];
	}>;
}

export interface CodexQuotaReadinessResult {
	ready: boolean;
	failures: Array<{
		home?: string;
		reason:
			| "credential_not_shared"
			| "authority_unavailable"
			| "canonical_unavailable";
	}>;
}

/** Read-only precondition; migration belongs to the drained home's admission fence. */
export async function checkCodexQuotaReadiness(
	opts: CodexQuotaReadinessOptions,
): Promise<CodexQuotaReadinessResult> {
	try {
		const canonical = await lstat(opts.canonicalAuthPath);
		if (
			!isAbsolute(opts.canonicalAuthPath) ||
			!canonical.isFile() ||
			canonical.isSymbolicLink() ||
			(canonical.mode & 0o777) !== 0o600
		) {
			return { ready: false, failures: [{ reason: "canonical_unavailable" }] };
		}
	} catch {
		return { ready: false, failures: [{ reason: "canonical_unavailable" }] };
	}
	let inventory: Awaited<
		ReturnType<CodexQuotaReadinessOptions["collectHomes"]>
	>;
	try {
		inventory = await opts.collectHomes();
	} catch {
		return { ready: false, failures: [{ reason: "authority_unavailable" }] };
	}
	const failures: CodexQuotaReadinessResult["failures"] = [];
	if (!inventory.complete) failures.push({ reason: "authority_unavailable" });
	for (const observation of inventory.homes) {
		if (
			observation.ownership === "unknown" ||
			observation.activity === "unknown"
		) {
			failures.push({
				home: observation.home,
				reason: "authority_unavailable",
			});
			continue;
		}
		if (
			observation.ownership !== "managed" ||
			observation.activity !== "active"
		)
			continue;
		const authPath = join(observation.home, "auth.json");
		try {
			const home = await lstat(observation.home);
			const pending = await lstat(
				join(observation.home, ".credential-copy-pending"),
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (
				!isAbsolute(observation.home) ||
				!home.isDirectory() ||
				home.isSymbolicLink() ||
				!(await lstat(authPath)).isSymbolicLink() ||
				pending ||
				(await realpath(authPath)) !== (await realpath(opts.canonicalAuthPath))
			) {
				failures.push({
					home: observation.home,
					reason: "credential_not_shared",
				});
			}
		} catch {
			failures.push({
				home: observation.home,
				reason: "credential_not_shared",
			});
		}
	}
	return { ready: failures.length === 0, failures };
}

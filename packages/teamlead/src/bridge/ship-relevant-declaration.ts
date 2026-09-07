import { resolveBoundRepositoryAuthority } from "./repository-authority.js";

export const MAX_DECLARED_PRS_PER_COMPLETION = 8;
export const DECLARED_PR_AUTHORITY_TIMEOUT_MS = 3_000;
export const DECLARED_PR_AUTHORITY_CONCURRENCY = 4;

export interface DeclaredPrEvidence {
	targetRepoPath: string;
	prNumber: number;
	headSha: string;
}

export interface ResolvedShipRelevantDeclaration {
	repoIdentity: string;
	prNumber: number;
	probeRepoSlug: string;
	frozenHeadSha: string;
	targetRepoPath: string;
}

export type DeclaredPrAdmission<T> =
	| { ok: true; declarations: T[] }
	| {
			ok: false;
			reason:
				| "invalid_shape"
				| "too_many"
				| "main_repo_must_use_pr"
				| "duplicates_primary"
				| "head_mismatch"
				| "authority_timeout"
				| "repository_authority_unavailable";
			detail?: string;
	  };

export function parseDeclaredPrEvidence(
	value: unknown,
): DeclaredPrAdmission<DeclaredPrEvidence> {
	if (value === undefined) return { ok: true, declarations: [] };
	if (!Array.isArray(value)) return { ok: false, reason: "invalid_shape" };
	if (value.length > MAX_DECLARED_PRS_PER_COMPLETION) {
		return { ok: false, reason: "too_many" };
	}
	const declarations = new Map<string, DeclaredPrEvidence>();
	for (const candidate of value) {
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			Array.isArray(candidate)
		) {
			return { ok: false, reason: "invalid_shape" };
		}
		const row = candidate as Record<string, unknown>;
		const targetRepoPath =
			typeof row.targetRepoPath === "string" ? row.targetRepoPath.trim() : "";
		const prNumber = row.prNumber;
		const headSha =
			typeof row.headSha === "string" ? row.headSha.toLowerCase() : "";
		if (
			!targetRepoPath ||
			!Number.isSafeInteger(prNumber) ||
			Number(prNumber) <= 0 ||
			!/^[0-9a-f]{40}$/.test(headSha)
		) {
			return { ok: false, reason: "invalid_shape" };
		}
		const key = `${targetRepoPath}\0${String(prNumber)}`;
		if (!declarations.has(key)) {
			declarations.set(key, {
				targetRepoPath,
				prNumber: Number(prNumber),
				headSha,
			});
		}
	}
	return { ok: true, declarations: [...declarations.values()] };
}

async function mapWithConcurrency<T, R>(
	items: T[],
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{
			length: Math.min(DECLARED_PR_AUTHORITY_CONCURRENCY, items.length),
		},
		async () => {
			for (;;) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await worker(items[index]!);
			}
		},
	);
	const settlements = await Promise.allSettled(workers);
	const rejected = settlements.find(
		(settlement): settlement is PromiseRejectedResult =>
			settlement.status === "rejected",
	);
	if (rejected) throw rejected.reason;
	return results;
}

export async function resolveShipRelevantDeclarations(input: {
	authorityRoot: string;
	declarations: DeclaredPrEvidence[];
	primary?: { repoIdentity: string; prNumber: number };
	timeoutMs?: number;
	resolveAuthority?: typeof resolveBoundRepositoryAuthority;
}): Promise<DeclaredPrAdmission<ResolvedShipRelevantDeclaration>> {
	if (input.declarations.length === 0) {
		return { ok: true, declarations: [] };
	}
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		input.timeoutMs ?? DECLARED_PR_AUTHORITY_TIMEOUT_MS,
	);
	const resolveAuthority =
		input.resolveAuthority ?? resolveBoundRepositoryAuthority;
	try {
		const paths = [
			...new Set(
				input.declarations.map((declaration) => declaration.targetRepoPath),
			),
		];
		const resolvedPaths = await mapWithConcurrency(paths, async (path) => {
			const authority = await resolveAuthority({
				authorityRoot: input.authorityRoot,
				requestedRepoPath: path,
				signal: controller.signal,
			});
			return { path, authority };
		});
		const authorityByPath = new Map(
			resolvedPaths.map(({ path, authority }) => [path, authority]),
		);
		const declarations = new Map<string, ResolvedShipRelevantDeclaration>();
		for (const declaration of input.declarations) {
			const authority = authorityByPath.get(declaration.targetRepoPath)!;
			if (authority.identity === "__main__") {
				return { ok: false, reason: "main_repo_must_use_pr" };
			}
			if (authority.headSha.toLowerCase() !== declaration.headSha) {
				return { ok: false, reason: "head_mismatch" };
			}
			if (
				input.primary &&
				authority.identity.toLowerCase() ===
					input.primary.repoIdentity.toLowerCase() &&
				declaration.prNumber === input.primary.prNumber
			) {
				return { ok: false, reason: "duplicates_primary" };
			}
			const key = `${authority.identity.toLowerCase()}\0${declaration.prNumber}`;
			if (!declarations.has(key)) {
				declarations.set(key, {
					repoIdentity: authority.identity.toLowerCase(),
					prNumber: declaration.prNumber,
					probeRepoSlug: authority.probeRepoSlug.toLowerCase(),
					frozenHeadSha: authority.headSha.toLowerCase(),
					targetRepoPath: declaration.targetRepoPath,
				});
			}
		}
		return { ok: true, declarations: [...declarations.values()] };
	} catch (error) {
		return controller.signal.aborted
			? { ok: false, reason: "authority_timeout" }
			: {
					ok: false,
					reason: "repository_authority_unavailable",
					detail: error instanceof Error ? error.message : String(error),
				};
	} finally {
		clearTimeout(timeout);
	}
}

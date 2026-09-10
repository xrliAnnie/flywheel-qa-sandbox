import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export interface IsolationRoot {
	lexical: string;
	canonical: string;
}

export interface BoundaryEvidence {
	socketPath?: string;
	codexHome?: string;
	ledgerPath?: string;
	tmuxSocketPath?: string;
	worktreePath?: string;
}

export type IsolationBootPolicy =
	| "mustBeUnderRoot"
	| "mustBeAbsent"
	| "mustBeUnderRootIfSet"
	| "unchecked";

export interface IsolationBootContractEntry {
	name: string;
	boot: IsolationBootPolicy;
}

export interface IsolationBootOffender {
	name: string;
	value: string;
	kind: "outside_root" | "unset" | "must_be_absent";
}

export class IsolationRootInvalid extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IsolationRootInvalid";
	}
}

export function resolveIsolationRoot(
	env: NodeJS.ProcessEnv = process.env,
): IsolationRoot | null {
	const lexical = env.FLYWHEEL_ISOLATION_ROOT;
	if (lexical === undefined || lexical === "") return null;
	if (/[\0\r\n]/u.test(lexical)) {
		throw new IsolationRootInvalid(
			"FLYWHEEL_ISOLATION_ROOT contains a forbidden control character",
		);
	}
	if (!isAbsolute(lexical)) {
		throw new IsolationRootInvalid("FLYWHEEL_ISOLATION_ROOT must be absolute");
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(lexical);
	} catch {
		throw new IsolationRootInvalid(
			"FLYWHEEL_ISOLATION_ROOT must name an existing directory",
		);
	}
	if (stat.isSymbolicLink()) {
		throw new IsolationRootInvalid(
			"FLYWHEEL_ISOLATION_ROOT must not be a symlink",
		);
	}
	if (!stat.isDirectory()) {
		throw new IsolationRootInvalid(
			"FLYWHEEL_ISOLATION_ROOT must name a directory",
		);
	}
	try {
		return { lexical, canonical: realpathSync(lexical) };
	} catch {
		throw new IsolationRootInvalid(
			"FLYWHEEL_ISOLATION_ROOT cannot be resolved",
		);
	}
}

function canonicalizeCandidate(candidate: string): string {
	if (!isAbsolute(candidate) || /[\0\r\n]/u.test(candidate)) {
		throw new Error("boundary evidence must be an absolute safe path");
	}
	const resolved = resolve(candidate);
	let existing = resolved;
	const missingSegments: string[] = [];
	for (;;) {
		try {
			const canonical = realpathSync(existing);
			return resolve(canonical, ...missingSegments);
		} catch {
			const parent = dirname(existing);
			if (parent === existing)
				throw new Error("boundary path cannot be resolved");
			missingSegments.unshift(basename(existing));
			existing = parent;
		}
	}
}

export function isUnderIsolationRoot(
	root: IsolationRoot,
	candidate: string,
): boolean {
	try {
		const canonical = canonicalizeCandidate(candidate);
		return (
			canonical === root.canonical ||
			canonical.startsWith(`${root.canonical}${sep}`)
		);
	} catch {
		return false;
	}
}

const BOUNDARY_FIELDS = [
	"socketPath",
	"codexHome",
	"ledgerPath",
	"tmuxSocketPath",
	"worktreePath",
] as const satisfies readonly (keyof BoundaryEvidence)[];

export type BoundaryCheckResult =
	| { ok: true; mode: "production" | "isolated" }
	| {
			ok: false;
			reason: "no_evidence";
	  }
	| {
			ok: false;
			reason: "outside_root";
			offending: (keyof BoundaryEvidence)[];
	  };

export function checkBoundaryEvidence(
	root: IsolationRoot | null,
	evidence: BoundaryEvidence,
): BoundaryCheckResult {
	if (root === null) return { ok: true, mode: "production" };
	const present = BOUNDARY_FIELDS.filter((field) => {
		const value = evidence[field];
		return typeof value === "string" && value.length > 0;
	});
	if (present.length === 0) return { ok: false, reason: "no_evidence" };
	const offending = present.filter(
		(field) => !isUnderIsolationRoot(root, evidence[field] as string),
	);
	if (offending.length > 0) {
		return { ok: false, reason: "outside_root", offending };
	}
	return { ok: true, mode: "isolated" };
}

export type IsolationBootCheckResult =
	| { ok: true; mode: "production" | "isolated" }
	| { ok: false; offenders: IsolationBootOffender[] };

export function assertIsolationBoundaryAtBoot(
	env: NodeJS.ProcessEnv,
	contract: readonly IsolationBootContractEntry[],
): IsolationBootCheckResult {
	const root = resolveIsolationRoot(env);
	if (root === null) return { ok: true, mode: "production" };
	const offenders: IsolationBootOffender[] = [];
	for (const entry of contract) {
		const value = env[entry.name] ?? "";
		switch (entry.boot) {
			case "unchecked":
				break;
			case "mustBeAbsent":
				if (value !== "") {
					offenders.push({
						name: entry.name,
						value,
						kind: "must_be_absent",
					});
				}
				break;
			case "mustBeUnderRoot":
				if (value === "") {
					offenders.push({ name: entry.name, value, kind: "unset" });
					break;
				}
				if (!isUnderIsolationRoot(root, value)) {
					offenders.push({ name: entry.name, value, kind: "outside_root" });
				}
				break;
			case "mustBeUnderRootIfSet":
				if (value !== "" && !isUnderIsolationRoot(root, value)) {
					offenders.push({ name: entry.name, value, kind: "outside_root" });
				}
				break;
		}
	}
	return offenders.length > 0
		? { ok: false, offenders }
		: { ok: true, mode: "isolated" };
}

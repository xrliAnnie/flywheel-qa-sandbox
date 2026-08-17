import type { FlagProvenanceInput } from "../StateStore.js";

export const FLAG_REGISTRY_PATH =
	"packages/config/src/feature-flags/registry.ts";
export const FLAG_PROVENANCE_COMMIT_BUDGET = 2_000;

export interface GitCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type ExecGit = (args: string[]) => Promise<GitCommandResult>;

interface Token {
	kind: "identifier" | "string" | "punctuation";
	value: string;
	quote?: string;
}

function tokenizeTypeScript(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index]!;
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			index += 2;
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) throw new Error("unterminated registry block comment");
			index = end + 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			let value = "";
			index += 1;
			let closed = false;
			while (index < source.length) {
				const current = source[index]!;
				if (current === "\\") {
					if (index + 1 >= source.length) break;
					value += current + source[index + 1];
					index += 2;
					continue;
				}
				if (current === quote) {
					closed = true;
					index += 1;
					break;
				}
				value += current;
				index += 1;
			}
			if (!closed) throw new Error("unterminated registry string literal");
			tokens.push({ kind: "string", value, quote });
			continue;
		}
		if (/[A-Za-z_$]/.test(char)) {
			const start = index;
			index += 1;
			while (index < source.length && /[A-Za-z0-9_$]/.test(source[index]!)) {
				index += 1;
			}
			tokens.push({ kind: "identifier", value: source.slice(start, index) });
			continue;
		}
		tokens.push({ kind: "punctuation", value: char });
		index += 1;
	}
	return tokens;
}

/**
 * A deliberately narrow historical extractor. Unknown/dynamic `name` shapes
 * fail the whole provenance round; silently skipping one would turn a known
 * source-query defect into a false "orphan" classification.
 */
export function extractFlagNamesFromRegistrySource(
	source: string,
): Set<string> {
	const marker = source.indexOf("FEATURE_FLAGS");
	if (marker < 0) throw new Error("FEATURE_FLAGS declaration is missing");
	const tokens = tokenizeTypeScript(source.slice(marker));
	const assignment = tokens.findIndex(
		(token) => token.kind === "punctuation" && token.value === "=",
	);
	const opening = tokens.findIndex(
		(token, index) =>
			index > assignment && token.kind === "punctuation" && token.value === "[",
	);
	if (assignment < 0 || opening < 0) {
		throw new Error("FEATURE_FLAGS array is missing");
	}
	const names = new Set<string>();
	let arrayDepth = 0;
	let braceDepth = 0;
	let closed = false;
	for (let index = opening; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.kind === "punctuation") {
			if (token.value === "[") arrayDepth += 1;
			if (token.value === "]") {
				arrayDepth -= 1;
				if (arrayDepth === 0) {
					closed = true;
					break;
				}
			}
			if (token.value === "{") braceDepth += 1;
			if (token.value === "}") braceDepth -= 1;
			continue;
		}
		if (
			token.kind !== "identifier" ||
			token.value !== "name" ||
			arrayDepth !== 1 ||
			braceDepth !== 1
		) {
			continue;
		}
		const colon = tokens[index + 1];
		const literal = tokens[index + 2];
		if (
			colon?.kind !== "punctuation" ||
			colon.value !== ":" ||
			literal?.kind !== "string" ||
			literal.quote === "`" ||
			!/^[a-z0-9_]+$/.test(literal.value)
		) {
			throw new Error("unknown registry name syntax");
		}
		if (names.has(literal.value)) {
			throw new Error(`duplicate registry name in history: ${literal.value}`);
		}
		names.add(literal.value);
	}
	if (!closed) throw new Error("FEATURE_FLAGS array is unterminated");
	return names;
}

interface HistoryCommit {
	sha: string;
	committedAt: number;
	author: string;
	body: string;
	names: Set<string>;
}

function parseLog(stdout: string): Omit<HistoryCommit, "names">[] {
	const records = stdout.split("\x1e").filter((record) => record.trim() !== "");
	if (records.length > FLAG_PROVENANCE_COMMIT_BUDGET) {
		throw new Error(
			`flag provenance history exceeds ${FLAG_PROVENANCE_COMMIT_BUDGET} commits`,
		);
	}
	return records.map((record) => {
		// `git log --format=...%x1e` still writes its ordinary record newline
		// around the explicit separator. Never let that newline become part of a
		// SHA/object name; trailing body whitespace has no attribution meaning.
		const fields = record.trim().split("\x1f");
		const [sha, rawCommittedAt, author, ...bodyParts] = fields;
		const committedAt = Number(rawCommittedAt);
		if (!sha || !author || !Number.isSafeInteger(committedAt)) {
			throw new Error("malformed flag provenance git log record");
		}
		return { sha, committedAt, author, body: bodyParts.join("\x1f") };
	});
}

function pathAbsentAtRevision(result: GitCommandResult): boolean {
	return (
		result.exitCode !== 0 &&
		/(path .* (does not exist|exists on disk, but not in)|Path .* does not exist)/i.test(
			result.stderr,
		)
	);
}

function sameNames(left: Set<string>, right: Set<string>): boolean {
	return left.size === right.size && [...left].every((name) => right.has(name));
}

function issueIds(body: string): string[] {
	return [
		...new Set(
			(body.match(/\b(?:FLY|GEO)-\d+\b/gi) ?? []).map((issue) =>
				issue.toUpperCase(),
			),
		),
	];
}

function prNumbers(body: string): number[] {
	return [
		...new Set(
			[...body.matchAll(/\(#(\d+)\)/g)].map((match) => Number(match[1])),
		),
	];
}

export async function buildFlagProvenance(input: {
	currentFlagNames: string[];
	execGit: ExecGit;
}): Promise<FlagProvenanceInput[]> {
	const current = new Set(input.currentFlagNames);
	if (current.size !== input.currentFlagNames.length) {
		throw new Error("current flag registry contains duplicate names");
	}
	const shallow = await input.execGit(["rev-parse", "--is-shallow-repository"]);
	if (shallow.exitCode !== 0) {
		throw new Error(`cannot inspect git history depth: ${shallow.stderr}`);
	}
	if (shallow.stdout.trim() === "true") {
		throw new Error("flag provenance requires non-shallow git history");
	}
	const log = await input.execGit([
		"log",
		"--first-parent",
		"--reverse",
		"--format=%H%x1f%ct%x1f%an%x1f%B%x1e",
		"--",
		FLAG_REGISTRY_PATH,
	]);
	if (log.exitCode !== 0) {
		throw new Error(`flag provenance git log failed: ${log.stderr}`);
	}
	const metadata = parseLog(log.stdout);
	const history: HistoryCommit[] = [];
	for (const commit of metadata) {
		const objectPath = `${commit.sha}:${FLAG_REGISTRY_PATH}`;
		const shown = await input.execGit(["show", objectPath]);
		let names: Set<string>;
		if (shown.exitCode === 0) {
			names = extractFlagNamesFromRegistrySource(shown.stdout);
		} else if (pathAbsentAtRevision(shown)) {
			names = new Set();
		} else {
			throw new Error(
				`flag provenance git show failed for ${commit.sha}: ${shown.stderr}`,
			);
		}
		history.push({ ...commit, names });
	}
	const head = history.at(-1)?.names ?? new Set<string>();
	if (!sameNames(head, current)) {
		const absent = [...current].filter((name) => !head.has(name));
		throw new Error(
			`current flag absent at head or registry history mismatched: ${absent.join(",")}`,
		);
	}

	const introduction = new Map<string, HistoryCommit>();
	let previous = new Set<string>();
	for (const commit of history) {
		for (const name of commit.names) {
			if (!previous.has(name)) introduction.set(name, commit);
		}
		previous = commit.names;
	}

	return input.currentFlagNames.map((flagName) => {
		const commit = introduction.get(flagName);
		if (!commit) {
			throw new Error(`no introduction commit for current flag ${flagName}`);
		}
		const issues = issueIds(commit.body);
		const prs = prNumbers(commit.body);
		return {
			flagName,
			incarnationCommit: commit.sha,
			status: issues.length === 1 ? "resolved" : "unresolved",
			sourceIssue: issues.length === 1 ? issues[0]! : null,
			author: commit.author,
			committedAt: commit.committedAt,
			prNumber: prs.length === 1 ? prs[0]! : null,
		};
	});
}

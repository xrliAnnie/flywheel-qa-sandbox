export type SummaryLedgerUnavailableReason =
	| "truncated at gh --limit 500"
	| `gh exit ${number}`
	| `malformed gh output: ${string}`
	| "timeout";

export interface SummaryPull {
	number: number;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	project: string;
	lead: string;
	headRefName: string;
	createdAt: number;
}

export type SummaryLedgerResult =
	| { status: "ok"; pulls: SummaryPull[] }
	| { status: "unavailable"; reason: SummaryLedgerUnavailableReason };

export type ExecFileAsync = (
	file: string,
	args: string[],
	opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const SUMMARY_BRANCH =
	/^summary\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\/[0-9a-f]{16}$/;

function unavailable(field: string): SummaryLedgerResult {
	return { status: "unavailable", reason: `malformed gh output: ${field}` };
}

function validUrl(
	value: unknown,
	repo: string,
	number: number,
): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.host === "github.com" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === `/${repo}/pull/${number}` &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export async function listSummaryPulls(
	exec: ExecFileAsync,
	repo: string,
): Promise<SummaryLedgerResult> {
	let stdout: string;
	try {
		({ stdout } = await exec(
			"gh",
			[
				"pr",
				"list",
				"--repo",
				repo,
				"--state",
				"all",
				"--limit",
				"500",
				"--json",
				"number,url,state,createdAt,headRefName",
			],
			{ timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
		));
	} catch (error) {
		const commandError = error as { code?: unknown; killed?: unknown };
		if (commandError.killed === true || commandError.code === "ETIMEDOUT") {
			return { status: "unavailable", reason: "timeout" };
		}
		const code =
			typeof commandError.code === "number" &&
			Number.isInteger(commandError.code)
				? commandError.code
				: -1;
		return { status: "unavailable", reason: `gh exit ${code}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return unavailable("root");
	}
	if (!Array.isArray(parsed)) return unavailable("root");
	if (parsed.length >= 500) {
		return { status: "unavailable", reason: "truncated at gh --limit 500" };
	}

	const pulls: SummaryPull[] = [];
	for (const value of parsed) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return unavailable("item");
		}
		const row = value as Record<string, unknown>;
		if (
			typeof row.number !== "number" ||
			!Number.isSafeInteger(row.number) ||
			row.number <= 0
		) {
			return unavailable("number");
		}
		if (
			row.state !== "OPEN" &&
			row.state !== "MERGED" &&
			row.state !== "CLOSED"
		) {
			return unavailable("state");
		}
		if (!validUrl(row.url, repo, row.number)) return unavailable("url");
		if (typeof row.headRefName !== "string" || row.headRefName.length > 512) {
			return unavailable("headRefName");
		}
		if (
			typeof row.createdAt !== "string" ||
			!Number.isFinite(Date.parse(row.createdAt))
		) {
			return unavailable("createdAt");
		}
		const branch = SUMMARY_BRANCH.exec(row.headRefName);
		if (!branch) continue;
		pulls.push({
			number: row.number,
			url: row.url,
			state: row.state,
			project: branch[1]!,
			lead: branch[2]!,
			headRefName: row.headRefName,
			createdAt: Date.parse(row.createdAt),
		});
	}
	return { status: "ok", pulls };
}

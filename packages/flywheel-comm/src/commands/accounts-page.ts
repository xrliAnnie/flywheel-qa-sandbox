/** FLY-2688 — on-demand account quota page; no scheduler or startup hook. */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReport } from "./publish-report.js";

export interface AccountsPagePublishInput {
	htmlPath: string;
	project: string;
	channelId?: string;
	title: string;
	publishOnly?: boolean;
	signal?: AbortSignal;
}

export interface AccountsPageDeps {
	env?: Record<string, string | undefined>;
	fetchFn?: (
		url: string,
		init: { headers: Record<string, string>; signal?: AbortSignal },
	) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
	publish?: (input: AccountsPagePublishInput) => Promise<number>;
	writeFile?: (path: string, data: string) => void;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
	exit?: (code: number) => never;
	outDefault?: string;
}

const USAGE =
	"usage: flywheel-comm accounts-page [--project <name>] [--channel <id>] [--out <file>] [--bridge-url <url>] [--publish-only] [--timeout-ms <1..10000>]\n  a bounded call (--timeout-ms) or --publish-only renders the stored Codex readings; the plain call refreshes them first";
const VALUE_FLAGS = new Set([
	"--project",
	"--channel",
	"--out",
	"--bridge-url",
	"--timeout-ms",
]);

function parseFlags(args: string[]): Map<string, string> | null {
	const flags = new Map<string, string>();
	for (let index = 0; index < args.length; ) {
		const flag = args[index];
		if (flag === "--publish-only") {
			if (flags.has(flag)) return null;
			flags.set(flag, "true");
			index += 1;
			continue;
		}
		const value = args[index + 1];
		if (
			flag === undefined ||
			!VALUE_FLAGS.has(flag) ||
			value === undefined ||
			value.startsWith("--") ||
			flags.has(flag)
		) {
			return null;
		}
		flags.set(flag, value);
		index += 2;
	}
	return flags;
}

export async function runAccountsPage(
	args: string[],
	deps: AccountsPageDeps = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((message: string) => console.log(message));
	const errorLog =
		deps.errorLog ?? ((message: string) => console.error(message));
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const flags = parseFlags(args);
	if (flags === null) {
		errorLog(USAGE);
		return exit(1);
	}
	const token = env.TEAMLEAD_API_TOKEN?.trim();
	if (!token) {
		errorLog("accounts-page: TEAMLEAD_API_TOKEN is required");
		return exit(1);
	}
	const timeoutRaw = flags.get("--timeout-ms");
	const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
	if (
		timeoutMs !== undefined &&
		(!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
	) {
		errorLog("accounts-page: --timeout-ms must be an integer from 1 to 10000");
		return exit(1);
	}
	const signal =
		timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
	const bridgeUrl = (
		flags.get("--bridge-url") ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://localhost:9876"
	).replace(/\/+$/, "");
	// FLY-2688: only an unbounded on-demand call asks the Bridge to read the
	// Codex accounts. `--publish-only` runs inside the account_switched
	// notification's 5s budget, and any `--timeout-ms` call is capped at 10s —
	// far below a six-account probe — so both render the stored readings.
	const refresh = !flags.has("--publish-only") && timeoutMs === undefined;
	const url = `${bridgeUrl}/api/accounts-page.html${refresh ? "?refresh=1" : ""}`;
	const fetchFn =
		deps.fetchFn ??
		((
			requestUrl: string,
			init: { headers: Record<string, string>; signal?: AbortSignal },
		) =>
			fetch(requestUrl, init) as unknown as ReturnType<
				NonNullable<AccountsPageDeps["fetchFn"]>
			>);
	let html: string;
	try {
		const response = await fetchFn(url, {
			headers: { Authorization: `Bearer ${token}` },
			...(signal ? { signal } : {}),
		});
		if (!response.ok) {
			errorLog(`accounts-page: Bridge returned ${response.status} for ${url}`);
			return exit(1);
		}
		html = await response.text();
		if (!html.trim()) {
			errorLog("accounts-page: Bridge returned empty HTML");
			return exit(1);
		}
	} catch (error) {
		if (signal?.aborted) {
			errorLog("accounts-page: timeout");
			return exit(1);
		}
		errorLog(
			`accounts-page: cannot reach Bridge at ${url}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return exit(1);
	}

	const out =
		flags.get("--out") ??
		deps.outDefault ??
		join(tmpdir(), "flywheel-accounts-page.html");
	const writeFile =
		deps.writeFile ??
		((path: string, data: string) => writeFileSync(path, data));
	writeFile(out, html);
	const publish =
		deps.publish ??
		(async (input: AccountsPagePublishInput) => {
			const deadline = input.signal;
			const { envelope, exitCode } = await publishReport({
				htmlPath: input.htmlPath,
				project: input.project,
				channelId: input.channelId,
				title: input.title,
				publishOnly: input.publishOnly,
				fetchImpl: deadline
					? (request, init) => fetch(request, { ...init, signal: deadline })
					: undefined,
			});
			log(JSON.stringify(envelope));
			return exitCode;
		});
	const code = await publish({
		htmlPath: out,
		project: flags.get("--project") ?? "flywheel",
		channelId: flags.get("--channel"),
		title: "账号额度一览",
		...(flags.has("--publish-only") ? { publishOnly: true } : {}),
		...(signal ? { signal } : {}),
	});
	if (code !== 0) return exit(code);
}

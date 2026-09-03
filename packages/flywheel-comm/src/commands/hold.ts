import { randomUUID } from "node:crypto";

interface HttpResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

interface HoldCommandDeps {
	env?: Record<string, string | undefined>;
	httpJson?: (
		url: string,
		init: {
			method: string;
			headers: Record<string, string>;
			body?: string;
		},
	) => Promise<HttpResponse>;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
	requestId?: () => string;
}

const USAGE = [
	"usage:",
	"  flywheel-comm hold list --run <id> [--bridge-url <url>]",
	"  flywheel-comm hold resume --run <id> --shape <shape> --hold-event <uid> --reason <reason> [--decision <decision>] [--request-id <id>] [--bridge-url <url>]",
].join("\n");

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

export async function runHoldCommand(
	args: string[],
	deps: HoldCommandDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((message: string) => console.log(message));
	const errorLog =
		deps.errorLog ?? ((message: string) => console.error(message));
	const token = env.TEAMLEAD_API_TOKEN?.trim();
	const subcommand = args[0];
	const runId = option(args, "--run")?.trim();
	if (!token || !runId || (subcommand !== "list" && subcommand !== "resume")) {
		errorLog(USAGE);
		return 1;
	}
	const bridgeUrl = (
		option(args, "--bridge-url") ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://127.0.0.1:9876"
	).replace(/\/+$/, "");
	const httpJson =
		deps.httpJson ??
		((url: string, init: Parameters<typeof fetch>[1]) =>
			fetch(url, init) as unknown as Promise<HttpResponse>);
	const headers = {
		Authorization: `Bearer ${token}`,
		Origin: bridgeUrl,
		"Content-Type": "application/json",
	};
	if (subcommand === "list") {
		try {
			const response = await httpJson(
				`${bridgeUrl}/api/runs/${encodeURIComponent(runId)}/holds`,
				{ method: "GET", headers },
			);
			const body = await response.json().catch(() => ({}));
			log(JSON.stringify(body));
			return response.ok ? 0 : 1;
		} catch (error) {
			errorLog(
				`hold list: cannot reach Bridge at ${bridgeUrl}: ${(error as Error).message}`,
			);
			return 1;
		}
	}

	const shape = option(args, "--shape")?.trim();
	const holdEventUid = option(args, "--hold-event")?.trim();
	const reason = option(args, "--reason")?.trim();
	const decision = option(args, "--decision")?.trim();
	const clientRequestId =
		option(args, "--request-id")?.trim() ??
		deps.requestId?.() ??
		`hold-resume:${randomUUID()}`;
	if (!shape || !holdEventUid || !reason || !clientRequestId) {
		errorLog(USAGE);
		return 1;
	}
	const canonicalInput = {
		runId,
		shape,
		holdEventUid,
		...(decision ? { decision } : {}),
		reason,
		principal: "master",
		clientRequestId,
	};
	try {
		const stagedResponse = await httpJson(
			`${bridgeUrl}/api/runs/${encodeURIComponent(runId)}/resume/stage`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(canonicalInput),
			},
		);
		const staged = (await stagedResponse.json().catch(() => ({}))) as {
			canonical?: unknown;
			confirmToken?: unknown;
		};
		if (
			!stagedResponse.ok ||
			!staged.canonical ||
			typeof staged.confirmToken !== "string"
		) {
			log(JSON.stringify(staged));
			return 1;
		}
		const appliedResponse = await httpJson(
			`${bridgeUrl}/api/runs/${encodeURIComponent(runId)}/resume`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					canonical: staged.canonical,
					confirmToken: staged.confirmToken,
				}),
			},
		);
		const applied = await appliedResponse.json().catch(() => ({}));
		log(JSON.stringify(applied));
		return appliedResponse.ok ? 0 : 1;
	} catch (error) {
		errorLog(
			`hold resume: cannot reach Bridge at ${bridgeUrl}: ${(error as Error).message}`,
		);
		return 1;
	}
}

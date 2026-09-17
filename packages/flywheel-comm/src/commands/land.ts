import { randomUUID } from "node:crypto";

interface HttpResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

interface LandCommandDeps {
	env?: Record<string, string | undefined>;
	httpJson?: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string },
	) => Promise<HttpResponse>;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
	requestId?: () => string;
}

const USAGE =
	"usage: flywheel-comm land reclose --operation <full-id> --expected-generation <n> --expected-head <sha> --reason <text> [--request-id <uuid>] [--bridge-url <url>]";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

export async function runLandCommand(
	args: string[],
	deps: LandCommandDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((message: string) => console.log(message));
	const errorLog =
		deps.errorLog ?? ((message: string) => console.error(message));
	const operationId = option(args, "--operation")?.trim();
	const generationText = option(args, "--expected-generation")?.trim();
	const expectedResumeGeneration = Number(generationText);
	const expectedApprovedHead = option(args, "--expected-head")
		?.trim()
		.toLowerCase();
	const reason = option(args, "--reason")?.trim();
	const requestId = (
		option(args, "--request-id") ??
		deps.requestId?.() ??
		randomUUID()
	)
		.trim()
		.toLowerCase();
	const token = env.TEAMLEAD_API_TOKEN?.trim();
	if (
		args[0] !== "reclose" ||
		!token ||
		!operationId ||
		!generationText ||
		!Number.isSafeInteger(expectedResumeGeneration) ||
		expectedResumeGeneration < 0 ||
		!/^[0-9a-f]{40}$/.test(expectedApprovedHead ?? "") ||
		!reason ||
		reason.length > 500 ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			requestId,
		)
	) {
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
	try {
		const response = await httpJson(
			`${bridgeUrl}/api/lifecycle/land/${encodeURIComponent(operationId)}/resume`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Origin: bridgeUrl,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					mode: "closeout_only",
					expectedResumeGeneration,
					expectedApprovedHead,
					reason,
					requestId,
				}),
			},
		);
		const body = await response.json().catch(() => ({}));
		log(JSON.stringify(body));
		return response.ok ? 0 : 1;
	} catch (error) {
		errorLog(
			`land reclose: cannot reach Bridge at ${bridgeUrl}: ${(error as Error).message}`,
		);
		return 1;
	}
}

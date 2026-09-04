import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

interface EpicPageHttpResponse {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export interface EpicPageCliDeps {
	env?: Record<string, string | undefined>;
	fetchFn?: (
		url: string,
		init: {
			method: string;
			headers: Record<string, string>;
			body?: string;
		},
	) => Promise<EpicPageHttpResponse>;
	writeFile?: (path: string, data: string) => void;
	readFile?: (path: string) => string;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
}

const USAGE = [
	"usage:",
	"  flywheel-comm epic-page generate [--project <name>] [--bridge-url <url>]",
	"  flywheel-comm epic-page show [--project <name>] [--format json|md]",
	"  flywheel-comm epic-page render [--project <name>] --out <file.html>",
].join("\n");

export async function runEpicPage(
	args: string[],
	deps: EpicPageCliDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? ((message: string) => console.log(message));
	const errorLog =
		deps.errorLog ?? ((message: string) => console.error(message));
	const fetchFn =
		deps.fetchFn ??
		((url, init) =>
			fetch(url, init) as unknown as Promise<EpicPageHttpResponse>);
	const writeFile =
		deps.writeFile ??
		((path: string, data: string) => writeFileSync(path, data, "utf8"));
	const readFile =
		deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	let emitted = false;
	const emit = (value: Record<string, unknown>): void => {
		if (emitted) return;
		emitted = true;
		log(JSON.stringify(value));
	};
	const fail = (
		error: string,
		diagnostic?: string,
		status?: number,
	): number => {
		if (diagnostic) errorLog(diagnostic);
		emit({ ok: false, error, ...(status === undefined ? {} : { status }) });
		return 1;
	};

	const subcommand = args[0];
	const rest = args.slice(1);
	if (!subcommand || !["generate", "show", "render"].includes(subcommand)) {
		return fail("invalid_arguments", USAGE);
	}
	let values: Record<string, string | boolean | undefined>;
	try {
		values = parseArgs({
			args: rest,
			options: {
				project: { type: "string" },
				"bridge-url": { type: "string" },
				...(subcommand === "show"
					? { format: { type: "string" as const } }
					: {}),
				...(subcommand === "render"
					? { out: { type: "string" as const } }
					: {}),
			},
			strict: true,
			allowPositionals: false,
		}).values;
	} catch {
		return fail("invalid_arguments", USAGE);
	}
	const value = (name: string): string | undefined => {
		const parsed = values[name];
		return typeof parsed === "string" ? parsed : undefined;
	};
	const project = value("project") ?? env.FLYWHEEL_PROJECT_NAME;
	if (!project)
		return fail("missing_project", "epic-page: project is required");
	const token = env.TEAMLEAD_API_TOKEN;
	if (!token)
		return fail("missing_token", "epic-page: TEAMLEAD_API_TOKEN is required");
	const bridgeUrl = (
		value("bridge-url") ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://localhost:9876"
	).replace(/\/+$/, "");
	const headers = { Authorization: `Bearer ${token}` };

	const url = `${bridgeUrl}/api/epic-page/generate`;
	let init: {
		method: string;
		headers: Record<string, string>;
		body?: string;
	};
	let format: "json" | "md" | "html";
	let out: string | undefined;
	if (subcommand === "generate") {
		init = {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ projectName: project }),
		};
		format = "json";
	} else {
		format =
			subcommand === "render"
				? "html"
				: ((value("format") ?? "json") as "json" | "md" | "html");
		if (
			(subcommand === "show" && format !== "json" && format !== "md") ||
			(subcommand === "render" && format !== "html")
		) {
			return fail("invalid_arguments", USAGE);
		}
		out = value("out");
		if (subcommand === "render" && !out) {
			return fail("invalid_arguments", USAGE);
		}
		init = {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ projectName: project, format }),
		};
	}

	let response: EpicPageHttpResponse;
	try {
		response = await fetchFn(url, init);
	} catch (error) {
		return fail(
			"bridge_unreachable",
			`epic-page: cannot reach Bridge: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.ok) {
		let body: unknown = {};
		try {
			body = await response.json();
		} catch {
			// The stable HTTP status remains enough when the body is not JSON.
		}
		const error =
			body &&
			typeof body === "object" &&
			"error" in body &&
			typeof (body as { error?: unknown }).error === "string"
				? String((body as { error: string }).error)
				: "http_error";
		return fail(
			error,
			`epic-page: Bridge returned ${response.status}`,
			response.status,
		);
	}

	if (format === "json") {
		const result = await response.json();
		emit({ ok: true, command: subcommand, result });
		return 0;
	}
	const content = await response.text();
	if (subcommand === "render") {
		try {
			writeFile(out!, content);
			if (readFile(out!) !== content) {
				return fail(
					"write_verification_failed",
					"epic-page render: saved file does not match the Bridge response",
				);
			}
		} catch (error) {
			return fail(
				"write_verification_failed",
				`epic-page render: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > 512 * 1024) {
			errorLog(
				`epic-page render: HTML is ${bytes} bytes (>512KB); publish-report hosting will reject it`,
			);
		}
		emit({ ok: true, command: subcommand, out, bytes });
		return 0;
	}
	errorLog(content);
	emit({ ok: true, command: subcommand, markdown: content });
	return 0;
}

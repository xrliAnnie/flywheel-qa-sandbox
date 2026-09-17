import { randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { assertLoopbackCarrierUrl } from "../lead-lease.js";

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const PUBLISH_REPORT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const USAGE =
	"use ship-judgment-history render --project flywheel --out <file.html> [--bridge-url <loopback-url>]; local output may be up to 32MiB, but publish-report rejects HTML over 512KiB";

interface Dependencies {
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
}

async function readBoundedHtml(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytes + value.byteLength > MAX_HISTORY_BYTES) {
			await reader.cancel();
			throw new Error("history_document_too_large");
		}
		chunks.push(value);
		bytes += value.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.concat(chunks, bytes),
	);
}

/** Fetches one read-only history snapshot and atomically writes it locally. */
export async function runShipJudgmentHistory(
	args: string[],
	deps: Dependencies = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const errorLog = deps.errorLog ?? console.error;
	const fail = (error: string) => {
		log(JSON.stringify({ ok: false, error }));
		return 1;
	};
	if (args[0] !== "render") return fail(USAGE);
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({
			args: args.slice(1),
			strict: true,
			allowPositionals: false,
			tokens: true,
			options: {
				project: { type: "string" },
				out: { type: "string" },
				"bridge-url": { type: "string" },
			},
		});
		const names = parsed.tokens
			.filter((token) => token.kind === "option")
			.map((token) => token.name);
		if (new Set(names).size !== names.length) return fail("duplicate_option");
		values = parsed.values;
	} catch {
		return fail(USAGE);
	}
	if (values.project !== "flywheel") return fail("invalid_project");
	const out = values.out;
	if (!out) return fail("output_required");
	const env = deps.env ?? process.env;
	if (!env.TEAMLEAD_API_TOKEN) return fail("api_token_required");
	let url: URL;
	try {
		url = assertLoopbackCarrierUrl(
			`${(values["bridge-url"] ?? env.BRIDGE_URL ?? env.FLYWHEEL_BRIDGE_URL ?? "http://localhost:9876").replace(/\/+$/, "")}/api/ship-judgment/history/render`,
		);
	} catch {
		return fail("loopback_bridge_required");
	}
	url.searchParams.set("project", values.project);
	const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	let response: Response;
	try {
		response = await (deps.fetchImpl ?? fetch)(url, {
			method: "GET",
			redirect: "error",
			signal,
			headers: { Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}` },
		});
		if (!response.ok) {
			await response.body?.cancel();
			return fail(`bridge_http_${response.status}`);
		}
		if (!response.headers.get("content-type")?.includes("text/html")) {
			await response.body?.cancel();
			return fail("unexpected_history_response");
		}
	} catch {
		return fail(
			signal.aborted ? "history_render_timed_out" : "history_render_failed",
		);
	}
	let html: string;
	try {
		html = await readBoundedHtml(response);
	} catch (error) {
		return fail(
			signal.aborted
				? "history_render_timed_out"
				: error instanceof Error &&
						error.message === "history_document_too_large"
					? error.message
					: "history_render_failed",
		);
	}
	const temp = join(dirname(out), `.${basename(out)}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temp, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
		if (readFileSync(temp, "utf8") !== html)
			throw new Error("write_verification_failed");
		renameSync(temp, out);
	} catch {
		if (existsSync(temp)) unlinkSync(temp);
		return fail("history_output_write_failed");
	}
	const bytes = Buffer.byteLength(html);
	if (bytes > PUBLISH_REPORT_MAX_BYTES)
		errorLog(
			`ship-judgment-history: HTML is ${bytes} bytes (>512KiB); publish-report will reject it`,
		);
	log(
		JSON.stringify({
			ok: true,
			command: "render",
			out,
			bytes,
			publish_report_max_bytes: PUBLISH_REPORT_MAX_BYTES,
		}),
	);
	return 0;
}

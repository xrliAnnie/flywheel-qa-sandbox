import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { RecordProbe, SiteProbe } from "../strength-two/judge.js";
import type { ReportHostOverride } from "./report-host-override.js";
import { REPORT_RETENTION_MS } from "./report-retention.js";

export const SITE_PROBE_TIMEOUT_MS = 3_000;
export const RECORD_PROBE_TIMEOUT_MS = 5_000;
export const SITE_BODY_MAX_BYTES = 64 * 1024;
export const RECORD_BODY_MAX_BYTES = 1024 * 1024;

const SHA40_LOWER_RE = /^[0-9a-f]{40}$/;
const REPORT_TOKEN_RE = /^[0-9a-f]{32}$/;
const GITHUB_PART_RE = /^[A-Za-z0-9_.-]+$/;

export interface StrengthTwoReportEntry {
	token: string;
	createdAt: string;
}

export interface StrengthTwoReportRegistry {
	list(): StrengthTwoReportEntry[];
	readReportHtml(token: string): string;
}

export type StrengthTwoExecFile = (
	file: string,
	args: readonly string[],
	options: { signal: AbortSignal; maxBuffer: number; encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

export type ClassifiedRecordUrl =
	| { kind: "hosted_report"; token: string }
	| {
			kind: "github_comment";
			owner: string;
			repo: string;
			issue: string;
			commentId: string;
	  }
	| { kind: "unsupported" };

export interface RecordUrlClassificationOptions {
	vercelProjectName?: string;
	hostOverride?: Pick<ReportHostOverride, "publicBaseUrl">;
}

function normalizedBaseUrl(value: string): string | null {
	try {
		const parsed = new URL(value);
		if (parsed.username || parsed.password || parsed.search || parsed.hash)
			return null;
		return parsed.href.replace(/\/$/, "");
	} catch {
		return null;
	}
}

export function classifyRecordUrl(
	value: string,
	opts: RecordUrlClassificationOptions,
): ClassifiedRecordUrl {
	if (typeof value !== "string" || value.length > 2_048) {
		return { kind: "unsupported" };
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { kind: "unsupported" };
	}
	if (parsed.username || parsed.password || parsed.search) {
		return { kind: "unsupported" };
	}

	const project = opts.vercelProjectName;
	if (project) {
		const vercelPrefix = `https://${project}.vercel.app/r/`;
		const overrideBase = opts.hostOverride
			? normalizedBaseUrl(opts.hostOverride.publicBaseUrl)
			: null;
		const overridePrefix = overrideBase
			? `${overrideBase}/${project}/r/`
			: null;
		for (const prefix of [vercelPrefix, overridePrefix]) {
			if (!prefix || !value.startsWith(prefix)) continue;
			const token = value.slice(prefix.length, -1);
			if (
				value.endsWith("/") &&
				!parsed.hash &&
				REPORT_TOKEN_RE.test(token) &&
				value === `${prefix}${token}/`
			) {
				return { kind: "hosted_report", token };
			}
		}
	}

	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "github.com" ||
		parsed.port
	) {
		return { kind: "unsupported" };
	}
	const match = parsed.pathname.match(
		/^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9][0-9]*)$/,
	);
	const fragment = parsed.hash.match(/^#issuecomment-([1-9][0-9]*)$/);
	if (
		!match ||
		!fragment ||
		!GITHUB_PART_RE.test(match[1]!) ||
		!GITHUB_PART_RE.test(match[2]!)
	) {
		return { kind: "unsupported" };
	}
	return {
		kind: "github_comment",
		owner: match[1]!,
		repo: match[2]!,
		issue: match[3]!,
		commentId: fragment[1]!,
	};
}

export type SiteStructuralFailure = {
	ok: false;
	reason: "port_unresolved" | "port_is_self";
	raw: Record<string, unknown>;
	detail: string;
};

export type SiteProbeResult = SiteProbe | SiteStructuralFailure;

export interface SiteProbeOptions {
	slot: number;
	selfPort?: number;
	slotsFilePath: string;
	/** Route-resolved port keeps the probed endpoint identical to the stored fact. */
	resolvedPort?: number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxBodyBytes?: number;
}

export function resolveSiteBridgePort(
	slotsFilePath: string,
	slot: number,
): number | undefined {
	try {
		const parsed = JSON.parse(readFileSync(slotsFilePath, "utf8")) as {
			slots?: Array<{ id?: unknown; bridgePort?: unknown }>;
		};
		const entry = parsed.slots?.[slot - 1];
		return entry &&
			Number.isSafeInteger(entry.bridgePort) &&
			Number(entry.bridgePort) > 0 &&
			Number(entry.bridgePort) <= 65_535
			? Number(entry.bridgePort)
			: undefined;
	} catch {
		return undefined;
	}
}

interface BoundedBodyResult {
	outcome: "ok" | "timeout" | "too_large" | "error";
	bytes: Uint8Array;
	detail?: string;
}

function abortErrorPromise(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const rejectAbort = () => {
			const error = new Error("probe deadline exceeded");
			error.name = "AbortError";
			reject(error);
		};
		if (signal.aborted) rejectAbort();
		else signal.addEventListener("abort", rejectAbort, { once: true });
	});
}

async function readBoundedBody(
	response: Response,
	maxBodyBytes: number,
	signal: AbortSignal,
): Promise<BoundedBodyResult> {
	const reader = response.body?.getReader();
	if (!reader) return { outcome: "ok", bytes: new Uint8Array() };
	const chunks: Uint8Array[] = [];
	let total = 0;
	const aborted = abortErrorPromise(signal);
	try {
		while (true) {
			const next = await Promise.race([reader.read(), aborted]);
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBodyBytes) {
				void reader.cancel("body exceeds configured maximum");
				return { outcome: "too_large", bytes: new Uint8Array() };
			}
			chunks.push(next.value);
		}
	} catch (error) {
		if (signal.aborted || (error as Error).name === "AbortError") {
			void reader.cancel("probe deadline exceeded");
			return { outcome: "timeout", bytes: new Uint8Array() };
		}
		return {
			outcome: "error",
			bytes: new Uint8Array(),
			detail: errorText(error),
		};
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { outcome: "ok", bytes: combined };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
	return (
		signal.aborted || (error instanceof Error && error.name === "AbortError")
	);
}

function safeRawFacts(
	value: unknown,
	httpStatus: number,
): Record<string, unknown> {
	const source =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	return {
		status: httpStatus,
		ok: source.ok,
		shuttingDown: source.shuttingDown,
		buildMode: source.buildMode,
		buildSha: source.buildSha,
		artifactBuildSha: source.artifactBuildSha,
	};
}

export async function probeSite(
	opts: SiteProbeOptions,
): Promise<SiteProbeResult> {
	const port =
		opts.resolvedPort ?? resolveSiteBridgePort(opts.slotsFilePath, opts.slot);
	if (port === undefined) {
		return {
			ok: false,
			reason: "port_unresolved",
			raw: {},
			detail: `slot ${opts.slot} bridge port unresolved`,
		};
	}
	if (port === opts.selfPort) {
		return {
			ok: false,
			reason: "port_is_self",
			raw: {},
			detail: `slot ${opts.slot} resolves to request bridge`,
		};
	}

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		opts.timeoutMs ?? SITE_PROBE_TIMEOUT_MS,
	);
	try {
		const response = await Promise.race([
			(opts.fetchImpl ?? fetch)(`http://127.0.0.1:${port}/health`, {
				signal: controller.signal,
				redirect: "manual",
			}),
			abortErrorPromise(controller.signal),
		]);
		const body = await readBoundedBody(
			response,
			opts.maxBodyBytes ?? SITE_BODY_MAX_BYTES,
			controller.signal,
		);
		if (body.outcome === "timeout") {
			return {
				ok: false,
				reason: "timeout",
				httpStatus: response.status,
				raw: { status: response.status },
				detail: "health response deadline exceeded",
			};
		}
		if (body.outcome === "too_large") {
			return {
				ok: false,
				reason: "bad_payload",
				httpStatus: response.status,
				raw: { status: response.status },
				detail: "health response body too large",
			};
		}
		if (body.outcome === "error") {
			return {
				ok: false,
				reason: "unreachable",
				httpStatus: response.status,
				raw: { status: response.status },
				detail: body.detail ?? "health response stream failed",
			};
		}
		let payload: unknown;
		try {
			payload = JSON.parse(Buffer.from(body.bytes).toString("utf8"));
		} catch {
			return {
				ok: false,
				reason: "bad_payload",
				httpStatus: response.status,
				raw: { status: response.status },
				detail: "health response is not JSON",
			};
		}
		const raw = safeRawFacts(payload, response.status);
		if (
			typeof raw.ok !== "boolean" ||
			typeof raw.shuttingDown !== "boolean" ||
			typeof raw.buildMode !== "string" ||
			typeof raw.buildSha !== "string" ||
			typeof raw.artifactBuildSha !== "string" ||
			!SHA40_LOWER_RE.test(raw.buildSha) ||
			!SHA40_LOWER_RE.test(raw.artifactBuildSha)
		) {
			return {
				ok: false,
				reason: "bad_payload",
				httpStatus: response.status,
				raw,
				detail: "health response has invalid readiness fields",
			};
		}
		if (
			response.status !== 200 ||
			raw.ok !== true ||
			raw.shuttingDown !== false ||
			raw.buildMode !== "built"
		) {
			return {
				ok: false,
				reason: "not_ready",
				httpStatus: response.status,
				raw,
				detail: "health response is not ready",
			};
		}
		return {
			ok: true,
			httpStatus: 200,
			healthOk: true,
			shuttingDown: false,
			buildMode: "built",
			buildSha: raw.buildSha,
			artifactBuildSha: raw.artifactBuildSha,
			validated: "site_probe",
		};
	} catch (error) {
		return {
			ok: false,
			reason: isTimeoutError(error, controller.signal)
				? "timeout"
				: "unreachable",
			raw: {},
			detail: errorText(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

export interface ProbeRecordOptions extends RecordUrlClassificationOptions {
	url: string;
	registry: StrengthTwoReportRegistry;
	fetchImpl?: typeof fetch;
	execFileImpl?: StrengthTwoExecFile;
	now?: () => number;
	timeoutMs?: number;
	maxBodyBytes?: number;
}

export type RecordProbeResult = RecordProbe | { kind: "unsupported" };

const defaultExecFile: StrengthTwoExecFile = async (file, args, options) => {
	const run = promisify(execFile);
	const result = await run(file, [...args], options);
	return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function githubFailureOutcome(error: unknown, signal: AbortSignal) {
	if (isTimeoutError(error, signal)) return "timeout" as const;
	const err = error as NodeJS.ErrnoException & { stderr?: unknown };
	const stderr = typeof err.stderr === "string" ? err.stderr : "";
	if (/\b404\b/.test(stderr)) return "not_found" as const;
	if (/\b(?:401|403)\b/.test(stderr)) return "forbidden" as const;
	if (
		err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
		/maxbuffer/i.test(`${errorText(error)} ${stderr}`)
	) {
		return "bad_payload" as const;
	}
	return "unreachable" as const;
}

export async function probeRecord(
	opts: ProbeRecordOptions,
): Promise<RecordProbeResult> {
	const classified = classifyRecordUrl(opts.url, opts);
	if (classified.kind === "unsupported") return classified;
	const maxBodyBytes = opts.maxBodyBytes ?? RECORD_BODY_MAX_BYTES;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		opts.timeoutMs ?? RECORD_PROBE_TIMEOUT_MS,
	);
	try {
		if (classified.kind === "hosted_report") {
			// Registry failures are invariant failures and intentionally escape to the route.
			const entry = opts.registry
				.list()
				.find((candidate) => candidate.token === classified.token);
			if (!entry) {
				return {
					kind: "hosted_report",
					outcome: "not_in_registry",
					detail: "report token not in registry",
				};
			}
			const createdAt = Date.parse(entry.createdAt);
			if (
				!Number.isFinite(createdAt) ||
				(opts.now ?? Date.now)() - createdAt >= REPORT_RETENTION_MS
			) {
				return {
					kind: "hosted_report",
					outcome: "expired",
					detail: "report registry entry expired",
				};
			}
			const local = Buffer.from(
				opts.registry.readReportHtml(classified.token),
				"utf8",
			);
			let response: Response;
			try {
				response = await Promise.race([
					(opts.fetchImpl ?? fetch)(opts.url, {
						signal: controller.signal,
						redirect: "manual",
					}),
					abortErrorPromise(controller.signal),
				]);
			} catch (error) {
				return {
					kind: "hosted_report",
					outcome: isTimeoutError(error, controller.signal)
						? "timeout"
						: "unreachable",
					detail: errorText(error),
				};
			}
			if (response.status !== 200) {
				return {
					kind: "hosted_report",
					outcome: "http_error",
					httpStatus: response.status,
					detail: `record returned HTTP ${response.status}`,
				};
			}
			const body = await readBoundedBody(
				response,
				maxBodyBytes,
				controller.signal,
			);
			if (body.outcome !== "ok") {
				return {
					kind: "hosted_report",
					outcome:
						body.outcome === "timeout"
							? "timeout"
							: body.outcome === "too_large"
								? "body_too_large"
								: "unreachable",
					httpStatus: response.status,
					detail:
						body.outcome === "timeout"
							? "record response deadline exceeded"
							: body.outcome === "too_large"
								? "record response body too large"
								: (body.detail ?? "record response stream failed"),
				};
			}
			const digest = sha256(body.bytes);
			const bytes = body.bytes.byteLength;
			if (bytes <= 0 || digest !== sha256(local)) {
				return {
					kind: "hosted_report",
					outcome: "digest_mismatch",
					httpStatus: 200,
					digest,
					bytes,
					detail: "remote report digest differs from hardened registry bytes",
				};
			}
			return {
				kind: "hosted_report",
				outcome: "ok",
				evidence: { httpStatus: 200, digest, bytes },
			};
		}

		let output: { stdout: string; stderr: string };
		try {
			output = await Promise.race([
				(opts.execFileImpl ?? defaultExecFile)(
					"gh",
					[
						"api",
						`repos/${classified.owner}/${classified.repo}/issues/comments/${classified.commentId}`,
					],
					{
						signal: controller.signal,
						maxBuffer: maxBodyBytes,
						encoding: "utf8",
					},
				),
				abortErrorPromise(controller.signal),
			]);
		} catch (error) {
			return {
				kind: "github_comment",
				outcome: githubFailureOutcome(error, controller.signal),
				detail: errorText(error),
			};
		}
		let payload: unknown;
		try {
			payload = JSON.parse(output.stdout);
		} catch {
			return {
				kind: "github_comment",
				outcome: "bad_payload",
				detail: "gh api response is not JSON",
			};
		}
		const body = (payload as { body?: unknown }).body;
		const htmlUrl = (payload as { html_url?: unknown }).html_url;
		if (
			typeof body !== "string" ||
			body.length === 0 ||
			typeof htmlUrl !== "string"
		) {
			return {
				kind: "github_comment",
				outcome: "bad_payload",
				detail: "gh api response lacks body or html_url",
			};
		}
		const returned = classifyRecordUrl(htmlUrl, {});
		if (
			returned.kind !== "github_comment" ||
			returned.owner !== classified.owner ||
			returned.repo !== classified.repo ||
			returned.issue !== classified.issue ||
			returned.commentId !== classified.commentId
		) {
			return {
				kind: "github_comment",
				outcome: "url_mismatch",
				detail: "gh api html_url does not match requested comment URL",
			};
		}
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > maxBodyBytes) {
			return {
				kind: "github_comment",
				outcome: "bad_payload",
				detail: "gh api comment body exceeds configured maximum",
			};
		}
		return {
			kind: "github_comment",
			outcome: "ok",
			evidence: { httpStatus: 200, digest: sha256(body), bytes },
		};
	} finally {
		clearTimeout(timer);
	}
}

function redact(value: string): string {
	return value
		.replace(/[\r\n\u2028\u2029]+/g, " ")
		.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:ghp|gho|ghu)_[A-Za-z0-9_]+\b/g, "[REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
		.replace(/\btoken\s*=\s*[^\s&,"'}]+/gi, "token=[REDACTED]")
		.replace(/\bcredential\s*=\s*[^\s&,"'}]+/gi, "credential=[REDACTED]");
}

function truncateUtf8(value: string, maxBytes: number): string {
	let candidate = value;
	while (
		Buffer.byteLength(candidate, "utf8") > maxBytes &&
		candidate.length > 0
	) {
		candidate = candidate.slice(0, Math.floor(candidate.length * 0.9));
	}
	return candidate;
}

function boundedJson(value: unknown, maxBytes: number): string {
	let raw: string;
	try {
		raw = JSON.stringify(value, (_key, item) =>
			typeof item === "string" ? truncateUtf8(redact(item), 256) : item,
		);
	} catch {
		raw = JSON.stringify({ detail: "probe detail could not be serialized" });
	}
	raw = redact(raw ?? "null");
	if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw;
	let low = 0;
	let high = raw.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = JSON.stringify({ detail: raw.slice(0, middle) });
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return JSON.stringify({ detail: raw.slice(0, low) });
}

export function buildProbeDetail(value: unknown): string {
	return boundedJson(value, 4_096);
}

export interface RecordLivenessRow {
	record_status: "satisfied" | "unsatisfied";
	record_url: string;
	record_url_kind: "hosted_report" | "github_comment";
	record_digest: string | null;
}

export async function probeRecordLiveness(
	row: RecordLivenessRow,
	deps: Omit<ProbeRecordOptions, "url">,
): Promise<"live" | "verified_then_expired" | "unsatisfied"> {
	if (row.record_status === "unsatisfied") return "unsatisfied";
	const probe = await probeRecord({ ...deps, url: row.record_url });
	if (
		probe.kind === row.record_url_kind &&
		probe.outcome === "ok" &&
		probe.evidence.digest === row.record_digest
	) {
		return "live";
	}
	return "verified_then_expired";
}

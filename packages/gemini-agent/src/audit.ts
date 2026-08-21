/**
 * FLY-1018 JSONL audit (plan §2.6) — write-before-call transcript.
 *
 * One file per session (`session-<sid>.jsonl`) plus a terminal summary row
 * in `sessions.jsonl`. All writes are SYNCHRONOUS appends: an action that
 * is not yet on disk has not happened (design principles 6/10). Redaction
 * discipline: args/user text enter as 200-char digests; tokens/keys never
 * appear here; memory bodies are counted (bodyChars), not copied.
 *
 * `session-<sid>.state.json` persists the last interaction id so the CLI
 * can resume a server-side Interactions thread across process restarts.
 */

import fs from "node:fs";
import path from "node:path";
import { appendRotatedLogSync } from "flywheel-config";
import type { AuditLog, SessionStats, TerminalReason } from "./types.js";

const DIGEST_CHARS = 200;

/** Redaction digest — first 200 chars, single line. */
export function digest(text: string): string {
	return text.slice(0, DIGEST_CHARS);
}

/** Injectable fs seam for ordering tests. */
export interface AuditFsLike {
	mkdirSync(dir: string, opts: { recursive: boolean }): void;
	appendFileSync(file: string, data: string): void;
	writeFileSync(file: string, data: string): void;
	readFileSync(file: string): string;
}

const realFs: AuditFsLike = {
	mkdirSync: (dir, opts) => {
		fs.mkdirSync(dir, opts);
	},
	appendFileSync: (file, data) => {
		fs.appendFileSync(file, data, "utf8");
	},
	writeFileSync: (file, data) => {
		fs.writeFileSync(file, data, "utf8");
	},
	readFileSync: (file) => fs.readFileSync(file, "utf8"),
};

export interface JsonlAuditLogOptions {
	dir: string;
	sessionId: string;
	fsLike?: AuditFsLike;
	now?: () => string;
	/** Test/custom-fs seam for the cross-session rotated index only. */
	appendIndex?: (path: string, data: string) => void;
}

export class JsonlAuditLog implements AuditLog {
	private readonly dir: string;
	private readonly sessionId: string;
	private readonly fsLike: AuditFsLike;
	private readonly now: () => string;
	private readonly sessionFile: string;
	private readonly appendIndex: (path: string, data: string) => void;

	constructor(opts: JsonlAuditLogOptions) {
		this.dir = opts.dir;
		this.sessionId = opts.sessionId;
		this.fsLike = opts.fsLike ?? realFs;
		this.now = opts.now ?? (() => new Date().toISOString());
		this.sessionFile = path.join(this.dir, `session-${this.sessionId}.jsonl`);
		this.appendIndex =
			opts.appendIndex ??
			(opts.fsLike
				? (file, data) => this.fsLike.appendFileSync(file, data)
				: (file, data) => appendRotatedLogSync(file, data));
		this.fsLike.mkdirSync(this.dir, { recursive: true });
	}

	private line(event: Record<string, unknown>): void {
		this.fsLike.appendFileSync(
			this.sessionFile,
			`${JSON.stringify({ ts: this.now(), sessionId: this.sessionId, ...event })}\n`,
		);
	}

	sessionStart(e: {
		entry: "cli" | "discord" | "delegate";
		model: string;
		surface: string;
		projectName: string;
		userTextDigest: string;
	}): void {
		this.line({ type: "session_start", ...e });
	}

	modelCall(step: number, transition: string): void {
		this.line({ type: "model_call", step, transition });
	}

	modelResponse(
		step: number,
		functionCallCount: number,
		textChars: number,
		usage: { inputTokens: number; outputTokens: number },
	): void {
		this.line({
			type: "model_response",
			step,
			functionCallCount,
			textChars,
			usage,
		});
	}

	toolDispatch(
		step: number,
		tool: string,
		argsDigest: string,
		decision: "dispatch" | "hallucinated" | "schema_reject",
	): void {
		this.line({ type: "tool_dispatch", step, tool, argsDigest, decision });
	}

	toolResult(
		step: number,
		tool: string,
		ok: boolean,
		httpStatus: number | undefined,
		durationMs: number,
		bodyChars: number,
		truncated: boolean,
	): void {
		this.line({
			type: "tool_result",
			step,
			tool,
			ok,
			httpStatus,
			durationMs,
			bodyChars,
			truncated,
		});
	}

	retry(
		layer: "model" | "tool",
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorKind: string,
	): void {
		this.line({
			type: "retry",
			layer,
			attempt,
			maxAttempts,
			delayMs,
			errorKind,
		});
	}

	terminal(reason: TerminalReason, stats: SessionStats): void {
		this.line({ type: "terminal", reason, stats });
		this.appendIndex(
			path.join(this.dir, "sessions.jsonl"),
			`${JSON.stringify({ ts: this.now(), sessionId: this.sessionId, type: "terminal", reason, stats })}\n`,
		);
	}

	warning(message: string): void {
		this.line({ type: "warning", message });
	}

	/** Persist the last Interactions id for `--resume` (plan §2.6). */
	saveInteractionId(interactionId: string): void {
		this.fsLike.writeFileSync(
			path.join(this.dir, `session-${this.sessionId}.state.json`),
			JSON.stringify({
				sessionId: this.sessionId,
				lastInteractionId: interactionId,
			}),
		);
	}

	static loadInteractionId(
		dir: string,
		sessionId: string,
		fsLike: AuditFsLike = realFs,
	): string | null {
		try {
			const raw = fsLike.readFileSync(
				path.join(dir, `session-${sessionId}.state.json`),
			);
			const parsed = JSON.parse(raw) as { lastInteractionId?: unknown };
			return typeof parsed.lastInteractionId === "string"
				? parsed.lastInteractionId
				: null;
		} catch {
			return null;
		}
	}
}

/**
 * FLY-1285: authenticated supervisor → Bridge tmux hold observations.
 *
 * Reporters may create/update a diagnostic observation but never resolve it.
 * Resolution belongs to ServerLossCoordinator after positive target evidence.
 */
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore, TmuxHoldReason } from "../StateStore.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024;
const MAX_CLOCK_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_FUTURE_MS = 5 * 60 * 1_000;
const HOLD_REASONS = new Set<TmuxHoldReason>([
	"saturated",
	"split_brain",
	"ambiguous",
	"unknown",
	"rescue_failed",
	"lock_unavailable",
]);

export interface TmuxHoldObservationRouteDeps {
	store: StateStore;
	projects: ProjectEntry[];
	apiToken?: string;
	/** Production accepts only the current uid's canonical default socket. */
	canonicalSocketPath?: string;
	now?: () => number;
}

export function isTmuxBackedSession(session: Session): boolean {
	return (session.adapter_type ?? "claude-tmux").includes("tmux");
}

export function canonicalDefaultTmuxSocketPath(): string {
	const uid = process.getuid?.();
	if (!Number.isSafeInteger(uid) || (uid ?? -1) < 0) {
		throw new Error("cannot determine current uid for tmux socket");
	}
	let canonicalTmp = "/tmp";
	try {
		canonicalTmp = realpathSync("/tmp");
	} catch {
		// `/tmp` is the tmux default even when it cannot be resolved yet.
	}
	return resolve(join(canonicalTmp, `tmux-${uid}`, "default"));
}

function secureEqual(actual: string, expected: string): boolean {
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function normalizedPath(value: unknown): string | null {
	if (typeof value !== "string" || !value || value.length > 1_024) return null;
	if (value.includes("\0") || !value.startsWith("/")) return null;
	return resolve(value);
}

function asReason(value: unknown): TmuxHoldReason | null {
	return typeof value === "string" && HOLD_REASONS.has(value as TmuxHoldReason)
		? (value as TmuxHoldReason)
		: null;
}

function parseHeldSince(value: unknown, now: number): number | null {
	const millis =
		typeof value === "number" && Number.isFinite(value)
			? value < 10_000_000_000
				? value * 1_000
				: value
			: NaN;
	if (!Number.isFinite(millis)) return null;
	if (millis < now - MAX_CLOCK_AGE_MS || millis > now + MAX_CLOCK_FUTURE_MS) {
		return null;
	}
	return millis;
}

function parseEvidence(
	value: unknown,
):
	| { ok: true; evidence: Record<string, unknown> }
	| { ok: false; status: number } {
	if (value == null) return { ok: true, evidence: {} };
	if (typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, status: 400 };
	}
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return { ok: false, status: 400 };
	}
	if (Buffer.byteLength(encoded) > MAX_EVIDENCE_BYTES) {
		return { ok: false, status: 413 };
	}
	const evidence = JSON.parse(encoded) as Record<string, unknown>;
	if ("originalServerPid" in evidence) {
		const pid = evidence.originalServerPid;
		if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
			return { ok: false, status: 400 };
		}
		evidence.originalServerPidSource = "supervisor_archive";
	}
	return { ok: true, evidence };
}

export function createTmuxHoldObservationRouter(
	deps: TmuxHoldObservationRouteDeps,
): Router {
	const router = Router();
	const now = deps.now ?? (() => Date.now());

	router.post("/", (req, res) => {
		if (!deps.apiToken) {
			res
				.status(503)
				.json({ ok: false, error: "bridge api token not configured" });
			return;
		}
		const bearer =
			req.header("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
		if (!secureEqual(bearer, deps.apiToken)) {
			res.status(401).json({ ok: false, error: "unauthorized" });
			return;
		}

		const declaredLength = Number(req.header("content-length") ?? 0);
		let bodyBytes = Number.isFinite(declaredLength) ? declaredLength : 0;
		try {
			bodyBytes = Math.max(
				bodyBytes,
				Buffer.byteLength(JSON.stringify(req.body)),
			);
		} catch {
			res.status(400).json({ ok: false, error: "invalid body" });
			return;
		}
		if (bodyBytes > MAX_BODY_BYTES) {
			res.status(413).json({ ok: false, error: "body too large" });
			return;
		}

		const body = (req.body ?? {}) as Record<string, unknown>;
		const projectName =
			typeof body.projectName === "string" ? body.projectName.trim() : "";
		const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
		const project = deps.projects.find(
			(entry) => entry.projectName === projectName,
		);
		if (!project || !project.leads.some((lead) => lead.agentId === leadId)) {
			res
				.status(400)
				.json({ ok: false, error: "unknown project/lead identity" });
			return;
		}

		const socketPath = normalizedPath(body.socketPath);
		const canonical = normalizedPath(
			deps.canonicalSocketPath ?? canonicalDefaultTmuxSocketPath(),
		);
		if (!socketPath || !canonical || socketPath !== canonical) {
			res.status(400).json({ ok: false, error: "non-canonical tmux socket" });
			return;
		}
		const reason = asReason(body.kind);
		if (!reason) {
			res.status(400).json({ ok: false, error: "unsupported tmux hold kind" });
			return;
		}
		const heldSinceMs = parseHeldSince(body.heldSinceTs, now());
		if (heldSinceMs == null) {
			res.status(400).json({ ok: false, error: "invalid heldSinceTs" });
			return;
		}
		const incidentId =
			typeof body.incidentId === "string" &&
			/^[A-Za-z0-9-]{8,128}$/.test(body.incidentId)
				? body.incidentId
				: undefined;
		if (body.incidentId !== undefined && !incidentId) {
			res.status(400).json({ ok: false, error: "invalid incidentId" });
			return;
		}
		const parsedEvidence = parseEvidence(body.evidence);
		if (!parsedEvidence.ok) {
			res
				.status(parsedEvidence.status)
				.json({ ok: false, error: "invalid evidence" });
			return;
		}

		const affectedExecutionIds = deps.store
			.getRunningSessions()
			.filter(isTmuxBackedSession)
			.map((session) => session.execution_id);
		try {
			const hold = deps.store.getOrCreateActiveTmuxHold(socketPath, {
				incidentId,
				reason,
				shape: "provisional",
				shapeSource: "observation",
				evidence: {
					...parsedEvidence.evidence,
					reporterHeldSinceTs: new Date(heldSinceMs).toISOString(),
					leadId,
					projectName,
				},
				affectedExecutionIds,
			});
			res.json({ ok: true, incidentId: hold.incidentId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("incident") &&
				(message.includes("stale") || message.includes("mismatch"))
			) {
				res.status(409).json({ ok: false, error: message });
				return;
			}
			console.error(`[tmux-hold-observation] ${message}`);
			res
				.status(500)
				.json({ ok: false, error: "observation persistence failed" });
		}
	});

	return router;
}

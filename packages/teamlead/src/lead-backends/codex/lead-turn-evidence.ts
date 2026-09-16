import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { LeadRuntimeConfigTarget } from "./LeadRuntimeConfigCoordinator.js";

export interface LeadTurnEvidence {
	threadId: string;
	turnId: string;
	model: string;
	effort: string;
	source: "rollout_turn_context";
	recordedAt: string;
	recordDigest: string;
}
const MAX_TAIL_BYTES = 1024 * 1024;
function inside(root: string, path: string) {
	const rel = relative(root, path);
	return (
		rel !== "" &&
		!isAbsolute(rel) &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`)
	);
}
function readRange(fd: number, start: number, size: number): string {
	const buffer = Buffer.alloc(size);
	let count = 0;
	while (count < size) {
		const read = readSync(fd, buffer, count, size - count, start + count);
		if (!read) break;
		count += read;
	}
	return buffer.subarray(0, count).toString("utf8");
}
function parse(line: string): any {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}
/** Bounded, read-only evidence. Missing/truncated/ambiguous records never become observed. */
export function readLeadTurnEvidence(args: {
	codexHome: string;
	path: string;
	threadId: string;
	turnId: string;
}): LeadTurnEvidence | undefined {
	const home = realpathSync(args.codexHome);
	const path = realpathSync(args.path);
	if (
		!isAbsolute(args.path) ||
		!["sessions", "archived_sessions"].some((dir) =>
			inside(join(home, dir), path),
		)
	)
		throw new Error("rollout_path_invalid");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("rollout_path_invalid");
		const prefix = readRange(fd, 0, Math.min(stat.size, 65536));
		const end = prefix.indexOf("\n");
		if (end < 0) return undefined;
		const meta = parse(prefix.slice(0, end));
		if (meta?.type !== "session_meta" || meta.payload?.id !== args.threadId)
			return undefined;
		const offset = Math.max(0, stat.size - MAX_TAIL_BYTES);
		const tail = readRange(fd, offset, stat.size - offset);
		const lines = tail.split("\n");
		if (offset > 0) lines.shift();
		lines.pop(); // Only newline-terminated JSONL records are committed evidence.
		let evidence: LeadTurnEvidence | undefined;
		for (const line of lines) {
			const row = parse(line);
			if (row?.type !== "turn_context" || row.payload?.turn_id !== args.turnId)
				continue;
			const { model, effort } = row.payload;
			if (
				typeof model !== "string" ||
				!model ||
				typeof effort !== "string" ||
				!effort ||
				typeof row.timestamp !== "string" ||
				!Number.isFinite(Date.parse(row.timestamp))
			)
				return undefined;
			if (evidence && (evidence.model !== model || evidence.effort !== effort))
				return undefined;
			evidence = {
				threadId: args.threadId,
				turnId: args.turnId,
				model,
				effort,
				source: "rollout_turn_context",
				recordedAt: row.timestamp,
				recordDigest: createHash("sha256").update(line).digest("hex"),
			};
		}
		return evidence;
	} finally {
		closeSync(fd);
	}
}

export interface LeadTurnObservation {
	target: LeadRuntimeConfigTarget;
	evidence: LeadTurnEvidence;
	source: "registry_hot" | "external_session_settings";
	observedAt: string;
}
export interface LeadRuntimeReadback {
	model: string;
	effort: string;
	drifted?: boolean;
	observation?: LeadTurnObservation;
}
export function validLeadTurnObservation(
	value: unknown,
	target: LeadRuntimeConfigTarget,
): value is LeadTurnObservation {
	if (!value || typeof value !== "object") return false;
	const v = value as LeadTurnObservation;
	const e = v.evidence;
	return (
		!!v.target &&
		typeof v.target === "object" &&
		(
			[
				"projectName",
				"leadKey",
				"identityDigest",
				"carrierId",
				"ownerEpoch",
				"runtimeGeneration",
				"threadId",
				"operationId",
				"configDigest",
				"configGeneration",
				"modelRegistryRevision",
				"model",
				"effort",
			] as const
		).every((key) => v.target[key] === target[key]) &&
		(v.source === "registry_hot" || v.source === "external_session_settings") &&
		typeof v.observedAt === "string" &&
		Number.isFinite(Date.parse(v.observedAt)) &&
		!!e &&
		e.threadId === target.threadId &&
		typeof e.turnId === "string" &&
		!!e.turnId &&
		typeof e.model === "string" &&
		!!e.model &&
		typeof e.effort === "string" &&
		!!e.effort &&
		e.source === "rollout_turn_context" &&
		typeof e.recordedAt === "string" &&
		Number.isFinite(Date.parse(e.recordedAt)) &&
		typeof e.recordDigest === "string" &&
		/^[a-f0-9]{64}$/.test(e.recordDigest) &&
		(v.source !== "registry_hot" ||
			(e.model === target.model && e.effort === target.effort))
	);
}

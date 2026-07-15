/**
 * FLY-1018 M2 — channel binding config (plan §3).
 *
 * `~/.flywheel/gemini-agent.json` (path overridable via
 * FLYWHEEL_GEMINI_AGENT_CONFIG) maps a Discord channel to a project + an
 * EXPLICIT Lead + a persona. The binding is the north-star anchor ("talk
 * to a specific Lead about a specific thing") AND the ship-request target
 * contract: request_ship_approval's leadId comes from here, never from a
 * projectName→lead inference (Codex R3-1).
 *
 * The binding set doubles as the channel ALLOWLIST: an interaction from a
 * channel with no binding is refused. Parsing is fail-closed — a schema
 * error refuses daemon startup rather than running half-configured.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError } from "../config.js";

export interface ChannelBinding {
	channelId: string;
	projectName: string;
	/** Required — the explicit ship-request target Lead (Codex R3-1/R4). */
	leadId: string;
	/**
	 * FLY-1060 QA F2: the bound Lead's department label — auto-applied to
	 * created issues so dispatch passes the dept-scope admission gate.
	 */
	deptLabel?: string;
	identityPath?: string;
	contextNote?: string;
}

export function defaultBindingsPath(
	env: Record<string, string | undefined> = process.env,
): string {
	return (
		env.FLYWHEEL_GEMINI_AGENT_CONFIG?.trim() ||
		path.join(os.homedir(), ".flywheel", "gemini-agent.json")
	);
}

function isBlank(v: unknown): boolean {
	return typeof v !== "string" || v.trim() === "";
}

/** Parse + validate the bindings document (fail-closed on any schema error). */
export function parseBindings(raw: string, source: string): ChannelBinding[] {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (err) {
		throw new ConfigError(
			`${source}: not valid JSON — ${(err as Error).message}`,
		);
	}
	const bindings = (doc as { bindings?: unknown })?.bindings;
	if (!Array.isArray(bindings) || bindings.length === 0) {
		throw new ConfigError(
			`${source}: "bindings" must be a non-empty array of channel bindings`,
		);
	}

	const seen = new Set<string>();
	const out: ChannelBinding[] = [];
	bindings.forEach((entry, i) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new ConfigError(`${source}: bindings[${i}] must be an object`);
		}
		const b = entry as Record<string, unknown>;
		if (isBlank(b.channelId)) {
			throw new ConfigError(
				`${source}: bindings[${i}].channelId is required (non-blank string)`,
			);
		}
		if (isBlank(b.projectName)) {
			throw new ConfigError(
				`${source}: bindings[${i}].projectName is required (non-blank string)`,
			);
		}
		// leadId is REQUIRED — the ship-request target must be explicit; a
		// binding without one would force exactly the projectName→lead
		// inference the design forbids (Codex R3-1, R4 parser-case note).
		if (isBlank(b.leadId)) {
			throw new ConfigError(
				`${source}: bindings[${i}].leadId is required (non-blank string) — the ship-request target Lead is explicit, never inferred from the project`,
			);
		}
		const channelId = (b.channelId as string).trim();
		if (seen.has(channelId)) {
			throw new ConfigError(
				`${source}: duplicate channelId "${channelId}" (bindings[${i}])`,
			);
		}
		seen.add(channelId);
		// FLY-1060 QA F2: optional dept label — blank would silently disable the
		// auto-apply the operator thought they configured, so fail-closed.
		if (b.deptLabel !== undefined && isBlank(b.deptLabel)) {
			throw new ConfigError(
				`${source}: bindings[${i}].deptLabel must be a non-blank string when present`,
			);
		}
		if (b.identityPath !== undefined && isBlank(b.identityPath)) {
			throw new ConfigError(
				`${source}: bindings[${i}].identityPath must be a non-blank string when present`,
			);
		}
		if (b.contextNote !== undefined && typeof b.contextNote !== "string") {
			throw new ConfigError(
				`${source}: bindings[${i}].contextNote must be a string when present`,
			);
		}
		out.push({
			channelId,
			projectName: (b.projectName as string).trim(),
			leadId: (b.leadId as string).trim(),
			...(b.deptLabel !== undefined && {
				deptLabel: (b.deptLabel as string).trim(),
			}),
			...(b.identityPath !== undefined && {
				identityPath: (b.identityPath as string).trim(),
			}),
			...(b.contextNote !== undefined && {
				contextNote: b.contextNote as string,
			}),
		});
	});
	return out;
}

/** Load bindings from disk. identityPath existence is checked here so a
 * mis-typed path fails at startup, not mid-conversation (context assembly
 * still degrades gracefully if the file disappears later). */
export function loadBindings(
	filePath = defaultBindingsPath(),
	fsLike: Pick<typeof fs, "readFileSync" | "existsSync"> = fs,
): ChannelBinding[] {
	let raw: string;
	try {
		raw = fsLike.readFileSync(filePath, "utf8") as string;
	} catch {
		throw new ConfigError(
			`bindings config not readable: ${filePath} (set FLYWHEEL_GEMINI_AGENT_CONFIG or create the file)`,
		);
	}
	const bindings = parseBindings(raw, filePath);
	for (const b of bindings) {
		if (b.identityPath && !fsLike.existsSync(b.identityPath)) {
			throw new ConfigError(
				`${filePath}: identityPath does not exist: ${b.identityPath} (channel ${b.channelId})`,
			);
		}
	}
	return bindings;
}

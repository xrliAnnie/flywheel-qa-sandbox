/**
 * FLY-282 — self-healing `allowBots` provisioning for the shared
 * `#leads-roundtable` channel.
 *
 * THE BUG: the Discord plugin fork drops a bot-authored message unless the
 * author's bot id is in the recipient Lead's `access.json` `allowBots`
 * (a per-Lead whitelist). That whitelist is hand-maintained, so a newly
 * onboarded Lead is missing from every existing Lead's list and bot->bot
 * @-mentions in the roundtable silently fail (Cass->Simba, 2026-06-16).
 *
 * THE FIX (brainstorm-gate Option A, authoritative ids): at startup each Lead
 *   1. resolves its OWN real bot id via its OWN token -> Discord `/users/@me`
 *      (authoritative — hand-maintained id rosters drift/swap),
 *   2. PUBLISHES `{leadId, botUserId, name}` to a shared registry dir,
 *   3. UNIONS every registered peer id into its own `access.json` `allowBots`.
 *
 * Idempotent + atomic -> re-runs are no-ops and the mesh self-heals as Leads
 * restart on their normal deploy/launchd cycle.
 *
 * SCOPE OF `allowBots` (accurate boundary — FLY-282 Codex review MEDIUM-2):
 * `allowBots` is GLOBAL per-Lead, not per-channel. Widening it only lets a peer
 * bot past the plugin's intake bot-filter (`server.ts:1112-1114`). Whether that
 * peer then gets a REPLY anywhere is still gated by the recipient's existing
 * controls, evaluated per matched group in `gate()`: the channel must be in the
 * Lead's `groups`, pass `groupAllowFrom`, satisfy `requireMention`, AND the peer
 * bot must have Discord permission to post there. For `#leads-roundtable`
 * (`requireMention:true`) that is the intended path. It is NOT strictly
 * "roundtable-only": a non-roundtable group with `requireMention:false` and an
 * empty `allowFrom` would also process a whitelisted peer bot that can post in
 * that channel. In practice cross-project peers are not members of another
 * project's channels, and this trust is PRE-EXISTING (each Lead's `allowBots`
 * already listed most peers) — this change only COMPLETES the mesh, it does not
 * introduce a new global-trust posture. `reconcile()` logs an advisory when a
 * roundtable member has such an open non-roundtable group so operators can see it.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DISCORD_API = "https://discord.com/api/v10";

export interface RegistryEntry {
	leadId: string;
	botUserId: string;
	name?: string;
	channelIds?: string[];
	updatedAt?: number;
}

/** Minimal shape of the Discord plugin's `access.json` we touch. Unknown fields
 * are preserved verbatim on write. */
export interface AccessLike {
	groups?: Record<string, unknown>;
	allowBots?: string[];
	[key: string]: unknown;
}

export interface ReconcileOptions {
	/** This Lead's id (e.g. "cos-lead") — used for the registry filename. */
	leadId: string;
	/** This Lead's Discord bot token. Absent/empty -> skip publish, still consume. */
	token?: string;
	/** Path to this Lead's `access.json`. */
	accessFile: string;
	/** Shared registry directory (one `<leadId>.json` per member). */
	registryDir: string;
	/** Roundtable / cross-dept channel ids. Membership = any of these in `groups`. */
	channelIds: string[];
	fetchImpl?: typeof fetch;
	logger?: (msg: string) => void;
	now?: () => number;
	/** Bounded timeout for the Discord `/users/@me` identity call (ms). A stalled
	 * call must never hang Lead startup (FLY-282 Codex review HIGH-1). Default 4000. */
	identityTimeoutMs?: number;
}

export interface ReconcileResult {
	/** Whether this Lead is a roundtable member (else the whole call is a no-op). */
	member: boolean;
	/** Whether this Lead successfully published its own identity this run. */
	published: boolean;
	/** This Lead's resolved bot id (when publish succeeded). */
	selfId?: string;
	/** Number of registry peer ids considered for the union. */
	peersConsidered: number;
	/** Whether `access.json` `allowBots` was changed (and rewritten). */
	allowBotsChanged: boolean;
	/** Ids newly added to `allowBots` this run. */
	added: string[];
	/** Advisory (FLY-282 Codex review MEDIUM-2): non-roundtable group channel ids
	 * that are "open" (`requireMention:false` AND empty/absent `allowFrom`), where a
	 * whitelisted peer bot that can post would be processed. Informational only. */
	openNonRoundtableGroups: string[];
}

/** Union `peers` into `existing` (preserve existing order, append only new peers,
 * de-dupe the appended peers). `changed` is false when nothing new was added.
 * A non-array `existing` (absent, or a corrupt non-array `allowBots`) is treated as
 * empty — so a malformed value is repaired to a clean array rather than spread into
 * characters (FLY-282 Codex code review LOW-2). */
export function unionAllowBots(
	existing: string[] | undefined,
	peers: string[],
): { allowBots: string[]; changed: boolean } {
	const result = Array.isArray(existing) ? [...existing] : [];
	const seen = new Set(result);
	let changed = false;
	for (const id of peers) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
		changed = true;
	}
	return { allowBots: result, changed };
}

/** A Lead is a roundtable member when any configured channel id is in its
 * `access.groups`. */
export function isRoundtableMember(
	access: AccessLike,
	channelIds: string[],
): boolean {
	const groups = access.groups;
	if (!groups || channelIds.length === 0) return false;
	return channelIds.some((id) => Object.hasOwn(groups, id));
}

/** Advisory (FLY-282 Codex review MEDIUM-2): the NON-roundtable group channel ids
 * that are "open" — `requireMention:false` AND empty/absent `allowFrom` — where a
 * whitelisted peer bot that can post would be processed without being addressed.
 * Informational only; this function changes no behavior. */
export function findOpenNonRoundtableGroups(
	access: AccessLike,
	channelIds: string[],
): string[] {
	const groups = access.groups;
	if (!groups) return [];
	const roundtable = new Set(channelIds);
	const open: string[] = [];
	for (const [id, policy] of Object.entries(groups)) {
		if (roundtable.has(id)) continue;
		const p = (policy ?? {}) as {
			requireMention?: boolean;
			allowFrom?: unknown[];
		};
		// `requireMention` defaults to true in the plugin, so only an EXPLICIT false
		// is open; an empty/absent `allowFrom` means "anyone allowed".
		const requireMention = p.requireMention ?? true;
		const allowFromEmpty =
			!Array.isArray(p.allowFrom) || p.allowFrom.length === 0;
		if (!requireMention && allowFromEmpty) open.push(id);
	}
	return open;
}

/** Resolve the bot's authoritative identity from its token via `/users/@me`.
 *
 * BOUNDED by `timeoutMs` (FLY-282 Codex review HIGH-1): a stalled / half-open
 * Discord call must never hang Lead startup. The whole fetch+json is raced
 * against a timer (so even a `fetchImpl` that ignores `AbortSignal` — e.g. a test
 * double — is still bounded), and the `AbortController` aborts the real request
 * for cleanup. Throws on timeout / non-2xx / missing id; the caller treats any
 * throw as a best-effort publish failure (skip publish, still consume peers). */
export async function resolveSelfIdentity(
	token: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 4000,
): Promise<{ id: string; name: string }> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`Discord /users/@me timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	const doFetch = async (): Promise<{ id: string; name: string }> => {
		const res = await fetchImpl(`${DISCORD_API}/users/@me`, {
			headers: { Authorization: `Bot ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`Discord GET /users/@me ${res.status}`);
		}
		const body = (await res.json()) as {
			id?: string;
			username?: string;
			global_name?: string;
		};
		if (!body.id) throw new Error("Discord /users/@me returned no id");
		return { id: body.id, name: body.global_name ?? body.username ?? body.id };
	};
	try {
		return await Promise.race([doFetch(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Read every `*.json` in `dir` as a `RegistryEntry`. Missing dir -> `[]`;
 * a corrupt / non-json / id-less file is skipped (never throws on bad data). */
export function parseRegistry(dir: string): RegistryEntry[] {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const raw = readFileSync(join(dir, f), "utf8");
			const parsed = JSON.parse(raw) as Partial<RegistryEntry>;
			if (typeof parsed.botUserId === "string" && parsed.botUserId.length > 0) {
				out.push({
					leadId: parsed.leadId ?? f.replace(/\.json$/, ""),
					botUserId: parsed.botUserId,
					name: parsed.name,
					channelIds: parsed.channelIds,
					updatedAt: parsed.updatedAt,
				});
			}
		} catch {
			// skip corrupt / empty / non-json file
		}
	}
	return out;
}

/** Filesystem-safe registry filename for a lead id. */
function registryFileName(leadId: string): string {
	return `${leadId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** Atomic write: temp file (mode 0600) then rename over the target. */
function atomicWrite(file: string, contents: string): void {
	const tmp = `${file}.tmp.${process.pid}`;
	writeFileSync(tmp, contents, { mode: 0o600 });
	renameSync(tmp, file);
}

/** Read + parse `access.json`. Returns null on missing/corrupt (caller no-ops). */
function readAccess(accessFile: string): AccessLike | null {
	try {
		return JSON.parse(readFileSync(accessFile, "utf8")) as AccessLike;
	} catch {
		return null;
	}
}

/**
 * Reconcile one Lead's roundtable `allowBots`. Best-effort: every failure path
 * degrades to a no-op rather than throwing, so it can never abort Lead startup.
 */
export async function reconcile(
	opts: ReconcileOptions,
): Promise<ReconcileResult> {
	const log = opts.logger ?? (() => {});
	const now = opts.now ?? Date.now;
	const noop: ReconcileResult = {
		member: false,
		published: false,
		peersConsidered: 0,
		allowBotsChanged: false,
		added: [],
		openNonRoundtableGroups: [],
	};

	const access = readAccess(opts.accessFile);
	if (!access) {
		log(
			`[roundtable-allowbots] no readable access.json at ${opts.accessFile} — skip`,
		);
		return noop;
	}
	if (!isRoundtableMember(access, opts.channelIds)) {
		log(
			`[roundtable-allowbots] ${opts.leadId} is not a roundtable member — skip`,
		);
		return noop;
	}

	// (2) PUBLISH own authoritative identity — best effort.
	let published = false;
	let selfId: string | undefined;
	if (opts.token) {
		try {
			const me = await resolveSelfIdentity(
				opts.token,
				opts.fetchImpl,
				opts.identityTimeoutMs,
			);
			selfId = me.id;
			mkdirSync(opts.registryDir, { recursive: true, mode: 0o700 });
			const entry: RegistryEntry = {
				leadId: opts.leadId,
				botUserId: me.id,
				name: me.name,
				channelIds: opts.channelIds,
				updatedAt: now(),
			};
			atomicWrite(
				join(opts.registryDir, registryFileName(opts.leadId)),
				`${JSON.stringify(entry, null, 2)}\n`,
			);
			published = true;
			log(
				`[roundtable-allowbots] ${opts.leadId} published id ${me.id} (${me.name})`,
			);
		} catch (err) {
			log(
				`[roundtable-allowbots] ${opts.leadId} identity publish failed (will consume existing peers): ${(err as Error).message}`,
			);
		}
	}

	// (3) CONSUME — union every registered peer id into allowBots. Guard against a
	// corrupt non-array `allowBots` (LOW-2): treat it as empty so `before.includes`
	// is real array membership and a malformed value is repaired to a clean array.
	const peers = parseRegistry(opts.registryDir).map((e) => e.botUserId);
	const before = Array.isArray(access.allowBots) ? access.allowBots : [];
	const { allowBots, changed } = unionAllowBots(before, peers);
	const added = allowBots.filter((id) => !before.includes(id));

	if (changed) {
		access.allowBots = allowBots;
		atomicWrite(opts.accessFile, `${JSON.stringify(access, null, 2)}\n`);
		log(
			`[roundtable-allowbots] ${opts.leadId} allowBots += [${added.join(", ")}]`,
		);
	}

	// Advisory only (MEDIUM-2): surface non-roundtable groups where a whitelisted
	// peer bot could be processed without being addressed. No behavior change.
	const openNonRoundtableGroups = findOpenNonRoundtableGroups(
		access,
		opts.channelIds,
	);
	if (openNonRoundtableGroups.length > 0) {
		log(
			`[roundtable-allowbots] ${opts.leadId} advisory: open non-roundtable groups ` +
				`(requireMention:false, allowFrom empty) widened allowBots can reach: ` +
				`[${openNonRoundtableGroups.join(", ")}]`,
		);
	}

	return {
		member: true,
		published,
		selfId,
		peersConsidered: peers.length,
		allowBotsChanged: changed,
		added,
		openNonRoundtableGroups,
	};
}

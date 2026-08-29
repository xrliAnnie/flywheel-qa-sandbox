#!/usr/bin/env node
/**
 * FLY-314 Part(b) — one-off, SAFE archiver for orphan roundtable topic threads.
 *
 * Background: with trigger=any_top_level + reply-in-thread NOT yet live, every flat
 * reply in #leads-roundtable spawned its own single-message thread (the mess Annie
 * saw). Once reply-in-thread is deployed, replies funnel into the topic thread and no
 * new orphans are produced; this script tidies the pre-existing ones.
 *
 * SAFETY CONTRACT (Codex design review R1#6 — never archive a live conversation):
 *   - dry-run by DEFAULT — prints candidates, changes nothing. Pass --apply to archive.
 *   - a thread is an "orphan" candidate ONLY if ALL hold:
 *       parent_id == roundtable channel
 *       REAL message count (fetched, not the unreliable list `message_count`) <= 1
 *       last activity older than --before=<ISO> (deploy-start cutoff)
 *   - anything with >1 message, or newer than the cutoff, is SKIPPED (it may be a live
 *     topic — e.g. Ariel's interview threads — or have real replies).
 *   - idempotent (already-archived threads are skipped) + observable (prints kept/skipped).
 *
 * Usage:
 *   CASS_BOT_TOKEN=... node archive-roundtable-orphan-threads.mjs \
 *     --guild <id> --channel <roundtable id> --before 2026-06-24T00:00:00Z [--apply]
 *
 * The token must be the bot that OWNS the threads (the roundtable poller bot, e.g.
 * CASS) — Discord only lets the owner / a MANAGE_THREADS bot archive a thread.
 */

const API = "https://discord.com/api/v10";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
	return fallback;
}
const APPLY = process.argv.includes("--apply");
const GUILD = arg("guild");
const CHANNEL = arg("channel");
const BEFORE = arg("before"); // ISO cutoff; required to avoid touching live threads
const TOKEN =
	process.env.CASS_BOT_TOKEN ||
	process.env.DISCORD_BOT_TOKEN ||
	process.env.ROUNDTABLE_BOT_TOKEN;

function die(msg) {
	process.stderr.write(`archive-roundtable-orphan-threads: ${msg}\n`);
	process.exit(1);
}
if (!TOKEN) die("missing bot token (CASS_BOT_TOKEN / DISCORD_BOT_TOKEN)");
if (!GUILD) die("missing --guild <id>");
if (!CHANNEL) die("missing --channel <roundtable id>");
if (!BEFORE || Number.isNaN(Date.parse(BEFORE)))
	die(
		"missing/invalid --before <ISO cutoff> (required — protects live threads)",
	);
const cutoff = Date.parse(BEFORE);

const headers = { Authorization: `Bot ${TOKEN}` };

async function realMessageCount(threadId) {
	// Fetch up to 5 messages — the list endpoint's `message_count` is unreliable
	// (observed off-by-one), so the real count is the source of truth.
	const res = await fetch(`${API}/channels/${threadId}/messages?limit=5`, {
		headers,
	});
	if (!res.ok) return { count: Infinity, lastTs: Infinity }; // unknown → never archive
	const msgs = await res.json();
	if (!Array.isArray(msgs)) return { count: Infinity, lastTs: Infinity };
	const lastTs = msgs.length
		? Math.max(...msgs.map((m) => Date.parse(m.timestamp) || 0))
		: 0;
	return { count: msgs.length, lastTs };
}

async function main() {
	const res = await fetch(`${API}/guilds/${GUILD}/threads/active`, { headers });
	if (!res.ok) die(`list active threads HTTP ${res.status}`);
	const data = await res.json();
	const threads = (data.threads ?? []).filter((t) => t.parent_id === CHANNEL);
	process.stdout.write(
		`${APPLY ? "APPLY" : "DRY-RUN"} — ${threads.length} active threads under roundtable; cutoff=${BEFORE}\n\n`,
	);
	let archived = 0;
	let kept = 0;
	for (const t of threads) {
		const md = t.thread_metadata ?? {};
		const name = (t.name ?? "").replace(/\n/g, " ").slice(0, 50);
		if (md.archived) {
			kept++;
			continue;
		} // idempotent
		const { count, lastTs } = await realMessageCount(t.id);
		const tooNew = lastTs >= cutoff;
		const hasReplies = count > 1;
		if (hasReplies || tooNew) {
			kept++;
			process.stdout.write(
				`  KEEP   ${t.id} msgs=${count} ${tooNew ? "(newer-than-cutoff)" : "(has-replies)"} | ${name}\n`,
			);
			continue;
		}
		// orphan candidate
		if (!APPLY) {
			archived++;
			process.stdout.write(`  WOULD-ARCHIVE ${t.id} msgs=${count} | ${name}\n`);
			continue;
		}
		const ar = await fetch(`${API}/channels/${t.id}`, {
			method: "PATCH",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ archived: true }),
		});
		if (ar.ok) {
			archived++;
			process.stdout.write(`  ARCHIVED ${t.id} | ${name}\n`);
		} else {
			kept++;
			process.stdout.write(
				`  FAIL ${t.id} HTTP ${ar.status} (owner/perms?) | ${name}\n`,
			);
		}
	}
	process.stdout.write(
		`\n${APPLY ? "archived" : "would-archive"}=${archived}  kept=${kept}\n`,
	);
}
main().catch((e) => die(String(e)));

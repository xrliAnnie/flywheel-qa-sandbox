#!/usr/bin/env tsx
/**
 * FLY-1646 livelock demonstration.
 *
 * Drives the REAL ChatReceiptRuntime worker loop (from the deployed Discord
 * plugin, discord/0.0.4/chat-receipt-runtime.ts) against the REAL migrated
 * CommDB, with runCommand wired to the REAL flywheel-comm chat-receipt
 * library functions.
 *
 * Falsifiable claim: with post-FLY-1572 semantics the worker loop cannot
 * terminate. `complete` keeps reporting success (progress=true) while the
 * pending predicate keeps returning the same rows (workRemains=true), so
 * neither `break` in workerLoop() can ever fire and every pass re-emits the
 * whole set with a `[redelivery]` prefix.
 *
 * Control: the same loop under pre-FLY-1572 semantics (where `complete`
 * removed the row from the pending set) terminates after one pass.
 */
import {
	ChatReceiptRuntime,
	type CommandResult,
} from "/Users/xiaorongli/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/chat-receipt-runtime.js";
import {
	completeChatReceipt,
	listPendingChatReceipts,
} from "../../../../packages/flywheel-comm/src/commands/chat-receipt.js";

const DB = process.argv[2];
const LEAD = process.argv[3] ?? "flywheel-eng-lead";
const MODE = process.argv[4] ?? "post"; // "post" | "pre"
if (!DB) throw new Error("usage: fly1646-livelock.ts <dbPath> [leadId] [pre|post]");

/** Pre-FLY-1572 parity: `complete` also removed the row from `pending`. */
const legacyDelivered = new Set<string>();

const ok = (stdout: string): CommandResult => ({
	stdout,
	stderr: "",
	exitCode: 0,
	timedOut: false,
});

const runCommand = async (argv: string[]): Promise<CommandResult> => {
	const sub = argv[3];
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (sub === "pending") {
		const page = listPendingChatReceipts({
			dbPath: DB,
			leadId: LEAD,
			cursorSeq: Number(flag("--cursor") ?? 0),
			limit: Number(flag("--limit") ?? 20),
		});
		const rows =
			MODE === "pre"
				? page.rows.filter((r) => !legacyDelivered.has(r.id))
				: page.rows;
		return ok(JSON.stringify({ rows, nextCursor: page.nextCursor }));
	}
	if (sub === "complete") {
		const messageId = flag("--message-id") as string;
		const res = completeChatReceipt({
			dbPath: DB,
			leadId: LEAD,
			messageId,
			now: new Date().toISOString(),
		});
		legacyDelivered.add(res.receiptId);
		return ok(JSON.stringify(res));
	}
	if (sub === "quarantine") return ok("{}");
	return ok("{}");
};

let notifications = 0;
let redeliveries = 0;
const seen = new Map<string, number>();
const WALL_CLOCK_CAP_MS = 20_000;

class Bailout extends Error {}

const runtime = new ChatReceiptRuntime({
	mode: { kind: "enabled", commCli: "n/a", dbPath: DB, leadId: LEAD },
	stateDir: `${process.env.TMPDIR ?? "/tmp"}/fly1646-livelock-state`,
	runCommand,
	// Production uses setTimeout(1000) between pages. Keep a REAL macrotask
	// timer (same shape) but shorten it so the harness runs many passes fast.
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms > 0 ? 1 : 0)),
	log: () => {},
	advise: async () => {},
	notify: async (n) => {
		notifications++;
		const id = String(n.meta.receipt_id);
		seen.set(id, (seen.get(id) ?? 0) + 1);
		if (n.content.startsWith("[redelivery] ")) redeliveries++;
		// NOTE: deliberately never throws. The runtime swallows notify errors
		// and skips `complete`, which would suppress `progress` and mask the
		// livelock. Termination is judged purely by the wall-clock race below.
	},
});

async function main(): Promise<void> {
	const started = Date.now();
	runtime.kickWorker();
	try {
		await Promise.race([
			runtime.whenIdle(),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Bailout(`still looping after ${WALL_CLOCK_CAP_MS}ms`)),
					WALL_CLOCK_CAP_MS,
				),
			),
		]);
		console.log(
			JSON.stringify({
				mode: MODE,
				verdict: "LOOP TERMINATED",
				notifications,
				redeliveries,
				distinct_receipts: seen.size,
				max_times_one_receipt_replayed: Math.max(0, ...seen.values()),
				elapsed_ms: Date.now() - started,
			}),
		);
	} catch (error) {
		if (!(error instanceof Bailout)) throw error;
		console.log(
			JSON.stringify({
				mode: MODE,
				verdict: "LOOP DID NOT TERMINATE (livelock)",
				stopped_by: error.message,
				notifications,
				redeliveries,
				distinct_receipts: seen.size,
				max_times_one_receipt_replayed: Math.max(0, ...seen.values()),
				elapsed_ms: Date.now() - started,
			}),
		);
	}
	process.exit(0);
}

main();

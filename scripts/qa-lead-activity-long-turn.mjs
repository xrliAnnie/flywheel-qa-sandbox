#!/usr/bin/env node
// FLY-2882 QA fixture: make one real Lead in a 529 room run a turn of at least
// 60 seconds, and sample GET /api/lead-activity before, during and after it.
//
// The Lead is asked (through the same chat-ingest lane the Discord plugin
// uses) to run one blocking `sleep`, so busy/idle and the turn start are
// known from the outside. Works for both carriers. Evidence carries only
// state / time / source / reason fields — never message or pane text.
//
// Exit: 0 all checks pass · 1 endpoint disagrees with the fixture (FAIL
// evidence) · 2 setup or usage error · 3 inconclusive (the Lead did not honor
// the fixture, never reached idle, or the delivery time is unprovable).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIN_LONG_TURN_MS = 60_000;
export const START_TOLERANCE_MS = 30_000;
/** Delivery → first rendered/observed busy; answers before it are not judged. */
export const START_GRACE_MS = 15_000;
/** One turn reports one start; second-precision rounding stays well inside this. */
const SAME_TURN_MS = 5_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

export class FixtureError extends Error {}

export function parseArgs(argv) {
	const options = {
		slot: undefined,
		agent: undefined,
		holdSeconds: 75,
		pollSeconds: 5,
		settleSeconds: 240,
		warmup: true,
		authorId: undefined,
		authorName: undefined,
		out: undefined,
	};
	const numeric = (flag, value, min, max) => {
		if (!/^\d+$/.test(value ?? "") || +value < min || +value > max)
			throw new FixtureError(`${flag} must be an integer in [${min}, ${max}]`);
		return +value;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--slot":
				options.slot = numeric(flag, value, 1, 999);
				i++;
				break;
			case "--agent":
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value ?? ""))
					throw new FixtureError("--agent must be a Lead id");
				options.agent = value;
				i++;
				break;
			case "--hold-seconds":
				options.holdSeconds = numeric(flag, value, 65, 600);
				i++;
				break;
			case "--poll-seconds":
				options.pollSeconds = numeric(flag, value, 1, 30);
				i++;
				break;
			case "--settle-seconds":
				options.settleSeconds = numeric(flag, value, 30, 1800);
				i++;
				break;
			case "--author-id":
				if (!/^\d{5,25}$/.test(value ?? ""))
					throw new FixtureError("--author-id must be a Discord id");
				options.authorId = value;
				i++;
				break;
			case "--author-name":
				if (!/^[A-Za-z0-9._-]{1,64}$/.test(value ?? ""))
					throw new FixtureError("--author-name is invalid");
				options.authorName = value;
				i++;
				break;
			case "--out":
				if (!value?.startsWith("/"))
					throw new FixtureError("--out must be an absolute path");
				options.out = value;
				i++;
				break;
			case "--no-warmup":
				options.warmup = false;
				break;
			default:
				throw new FixtureError(`unknown argument: ${flag}`);
		}
	}
	if (options.slot === undefined || options.agent === undefined)
		throw new FixtureError("--slot and --agent are required");
	return options;
}

export function warmupPrompt(nonce) {
	return [
		`[FLY-2882 QA warm-up · ${nonce}] Automated 529 QA probe of the read-only lead-activity endpoint.`,
		`Reply in this channel with exactly: FLY-2882 warm-up ${nonce} ready`,
		"Use no tools and start no other work.",
	].join("\n");
}

export function longTurnPrompt(nonce, holdSeconds) {
	return [
		`[FLY-2882 QA long-turn fixture · ${nonce}] Automated 529 QA timing probe of the read-only lead-activity endpoint. It is safe and read-only.`,
		"Do exactly this, in this one turn, and nothing else:",
		`1. Run this single shell command in the foreground and wait for it to finish. It takes about ${holdSeconds} seconds; give the tool a timeout of at least ${(holdSeconds + 60) * 1000} ms and do not background it: sleep ${holdSeconds}`,
		`2. If the tool cuts the command off early, keep running \`sleep 10\` until at least ${holdSeconds} seconds have passed since you started step 1.`,
		`3. Then reply in this channel with exactly: FLY-2882 long-turn ${nonce} done`,
		"Do not read files, start other work, or dispatch anyone.",
	].join("\n");
}

/** A Discord-shaped snowflake for the synthetic message (unique per call). */
export function syntheticMessageId(nowMs, random = randomBytes(3)) {
	const low = BigInt(random.readUIntBE(0, 3) & 0x3fffff);
	return (((BigInt(nowMs) - DISCORD_EPOCH_MS) << 22n) | low).toString();
}

function boundedJson(path, readFile) {
	const text = readFile(path);
	if (text.length > 65_536) throw new FixtureError(`oversized: ${path}`);
	return JSON.parse(text);
}

/**
 * Everything the fixture needs from the room, read from the room's own
 * artifacts: the Lead's coordinates, the Bridge launch spec, the API token.
 */
export function loadRoom(options, deps) {
	const slotDir = `/tmp/flywheel-test-slot-${options.slot}`;
	const coordinates = boundedJson(
		join(slotDir, "launchd", options.agent, "lead-coordinates.json"),
		deps.readFile,
	);
	if (
		coordinates.agentId !== options.agent ||
		(coordinates.carrier !== "claude-code" &&
			coordinates.carrier !== "codex-app-server") ||
		typeof coordinates.projectName !== "string" ||
		typeof coordinates.commDbPath !== "string" ||
		normalize(coordinates.commDbPath) !== coordinates.commDbPath ||
		!coordinates.commDbPath.startsWith(`${slotDir}/`) ||
		!/^\d+$/.test(coordinates.primaryChatChannelId ?? "")
	)
		throw new FixtureError("lead coordinates do not describe this Lead");
	const launch = boundedJson(
		join(slotDir, "bridge-launch.json"),
		deps.readFile,
	);
	if (
		!/^http:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}$/.test(
			launch.bridgeUrl ?? "",
		)
	)
		throw new FixtureError("room Bridge URL is not a loopback URL");
	const tokenPath = join(slotDir, "state", "api-token");
	if (!deps.isPrivateFile(tokenPath))
		throw new FixtureError(
			"room has no 0600 API token (start it with --generalized or TEST_REPLY_BY_ISSUE=1)",
		);
	const token = deps.readFile(tokenPath).trim();
	if (!token) throw new FixtureError("room API token is empty");
	return {
		slotDir,
		agent: options.agent,
		carrier: coordinates.carrier,
		projectName: coordinates.projectName,
		commDbPath: coordinates.commDbPath,
		chatChannelId: coordinates.primaryChatChannelId,
		leadBotId: coordinates.botUserId,
		bridgeUrl: launch.bridgeUrl,
		token,
	};
}

/** Only the fields the evidence may carry. */
export function toSample(atMs, dto) {
	const sample = {
		at: new Date(atMs).toISOString(),
		atMs,
		state: dto.state,
		source: dto.source,
	};
	if (dto.state === "busy") {
		sample.startedAt = dto.turn.startedAt;
		sample.startedAtMs = Date.parse(dto.turn.startedAt);
		sample.elapsedMs = dto.turn.elapsedMs;
		sample.precision = dto.turn.precision;
		sample.trigger =
			dto.trigger.kind === "issue"
				? { kind: "issue", issueId: dto.trigger.issueId }
				: { kind: "undetermined", reason: dto.trigger.reason };
	}
	if (dto.state === "unknown") sample.reason = dto.unknown.reason;
	return sample;
}

/**
 * Judge one fixture run on the fixture's own clock — never on the endpoint's
 * self-reported duration. `truthStartMs` is when the Bridge handed the message
 * to the Lead's carrier (mailbox `notified_at`); without it nothing is proven.
 *
 * The fixture's turn is the busy answers read at or after the true start whose
 * reported start is within tolerance of it and stable (one turn: ±5 s of the
 * first such answer) — a busy read before delivery is never this turn. The
 * checked window runs from `truth + grace` to the first idle after the turn's
 * last busy (to the end of sampling if no idle closes it): every answer in it
 * must belong to the turn — an idle / unknown / HTTP error / other start there
 * is FAIL evidence, including an idle the turn's busy later contradicts. For a
 * PASS the fixture itself must see the turn busy for at least `minBusyMs`
 * (first to last busy sample — the start-up wait never counts), the closing
 * idle must not come before the requested hold ends, and idle before.
 */
export function evaluateLongTurn({
	samples,
	injectedAtMs,
	truthStartMs,
	holdMs = Number.POSITIVE_INFINITY,
	minBusyMs = MIN_LONG_TURN_MS,
	toleranceMs = START_TOLERANCE_MS,
	graceMs = START_GRACE_MS,
}) {
	// A sample stamped at the injection instant was read before the ingest call.
	const before = samples.filter((s) => s.atMs <= injectedAtMs);
	const after = samples.filter((s) => s.atMs > injectedAtMs);
	const answer = (s) =>
		s.state === "unknown" ? `unknown:${s.reason}` : s.state;
	const checks = { idleBefore: before.some((s) => s.state === "idle") };
	if (!Number.isFinite(truthStartMs))
		return { verdict: "inconclusive", why: "no_delivery_evidence", checks };
	const candidates = after.filter(
		(s) =>
			s.state === "busy" &&
			s.atMs >= truthStartMs &&
			Math.abs(s.startedAtMs - truthStartMs) <= toleranceMs,
	);
	const anchor = candidates[0];
	const turn = candidates.filter(
		(s) => Math.abs(s.startedAtMs - anchor.startedAtMs) <= SAME_TURN_MS,
	);
	if (turn.length === 0) {
		const wrong = after.filter(
			(s) => s.atMs >= truthStartMs + graceMs && s.state !== "idle",
		);
		return {
			verdict: wrong.length > 0 ? "fail" : "inconclusive",
			why: wrong.length > 0 ? "no_busy_for_the_fixture_turn" : "never_busy",
			checks,
			answers: [...new Set(wrong.map(answer))],
		};
	}
	const first = turn[0];
	const last = turn[turn.length - 1];
	const closing = after.find((s) => s.atMs > last.atMs && s.state === "idle");
	const inside = after.filter(
		(s) =>
			s.atMs >= truthStartMs + graceMs &&
			s.atMs < (closing?.atMs ?? Number.POSITIVE_INFINITY) &&
			!turn.includes(s),
	);
	checks.onlyBusyInsideTurn = inside.length === 0;
	checks.startErrorMs = Math.max(
		...turn.map((s) => Math.abs(s.startedAtMs - truthStartMs)),
	);
	checks.longTurnObserved = last.atMs - first.atMs >= minBusyMs;
	checks.triggerUndetermined = turn.every(
		(s) => s.trigger?.kind === "undetermined",
	);
	checks.idleAfter = closing !== undefined;
	// An idle before the requested hold ended cannot be told apart from a Lead
	// that stopped early, so it is never a PASS (review R2).
	checks.idleBeforeHoldEnd =
		closing !== undefined && closing.atMs < truthStartMs + holdMs;
	const failed = !checks.onlyBusyInsideTurn || !checks.triggerUndetermined;
	const verdict = failed
		? "fail"
		: !checks.longTurnObserved ||
				checks.idleBeforeHoldEnd ||
				!checks.idleBefore ||
				!checks.idleAfter
			? "inconclusive"
			: "pass";
	return {
		verdict,
		why:
			verdict === "pass"
				? "ok"
				: [
						...[
							"onlyBusyInsideTurn",
							"triggerUndetermined",
							"longTurnObserved",
							"idleBefore",
							"idleAfter",
						].filter((key) => checks[key] === false),
						...(checks.idleBeforeHoldEnd ? ["idleBeforeHoldEnd"] : []),
					].join(","),
		checks,
		turn: {
			startedAt: first.startedAt,
			samples: turn.length,
			firstBusyAt: first.at,
			lastBusyAt: last.at,
			observedBusyMs: last.atMs - first.atMs,
		},
		insideAnswers: inside.map(answer),
	};
}

export const EXIT = { pass: 0, fail: 1, setup: 2, inconclusive: 3 };

async function readActivity(room, deps) {
	const url = `${room.bridgeUrl}/api/lead-activity?projectName=${encodeURIComponent(room.projectName)}&leadId=${encodeURIComponent(room.agent)}`;
	const response = await deps.fetch(url, {
		headers: { authorization: `Bearer ${room.token}` },
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	const atMs = deps.now();
	if (response.status !== 200)
		return {
			at: new Date(atMs).toISOString(),
			atMs,
			state: `http_${response.status}`,
		};
	return toSample(atMs, await response.json());
}

/** Poll until `done(sample)` or the deadline; every sample is kept. */
async function pollUntil(room, deps, options, samples, deadlineMs, done) {
	for (;;) {
		const sample = await readActivity(room, deps);
		samples.push(sample);
		deps.log?.(
			`[fixture] ${sample.at} ${sample.state}${sample.elapsedMs !== undefined ? ` ${Math.round(sample.elapsedMs / 1000)}s` : ""}${sample.reason ? ` ${sample.reason}` : ""}`,
		);
		if (done(sample)) return true;
		if (deps.now() >= deadlineMs) return false;
		await deps.sleep(options.pollSeconds * 1000);
	}
}

export async function runLongTurn(options, deps) {
	const room = loadRoom(options, deps);
	const author = options.authorId
		? { id: options.authorId, name: options.authorName ?? "qa-fixture" }
		: deps.defaultAuthor();
	if (author.id === room.leadBotId)
		throw new FixtureError("the author must not be the Lead's own bot");
	const nonce = deps.nonce();
	const samples = [];
	const evidence = {
		schema: "fly-2882-long-turn-fixture.v1",
		slot: options.slot,
		agent: room.agent,
		carrier: room.carrier,
		projectName: room.projectName,
		nonce,
		holdSeconds: options.holdSeconds,
		samples,
	};
	try {
		evidence.result = await driveFixture(
			room,
			author,
			nonce,
			options,
			deps,
			evidence,
		);
	} catch (error) {
		// Keep what was observed; a Bridge that stops answering mid-run is evidence too.
		evidence.result = { verdict: "setup", why: error.message };
	}
	return evidence;
}

async function driveFixture(room, author, nonce, options, deps, evidence) {
	const { samples } = evidence;
	const idle = (s) => s.state === "idle";
	const settled = await pollUntil(
		room,
		deps,
		options,
		samples,
		deps.now(),
		idle,
	);
	if (!settled && options.warmup) {
		const warm = deps.ingest(room, author, warmupPrompt(nonce));
		evidence.warmup = { injectedAt: new Date(warm.atMs).toISOString() };
		await pollUntil(
			room,
			deps,
			options,
			samples,
			deps.now() + options.settleSeconds * 1000,
			idle,
		);
	}
	const injected = deps.ingest(
		room,
		author,
		longTurnPrompt(nonce, options.holdSeconds),
	);
	// Keep sampling through the whole requested hold, even past an early idle.
	const holdEndMs = injected.atMs + options.holdSeconds * 1000;
	let sawBusy = false;
	await pollUntil(
		room,
		deps,
		options,
		samples,
		holdEndMs + options.settleSeconds * 1000,
		(s) => {
			if (s.state === "busy") sawBusy = true;
			return sawBusy && s.state === "idle" && s.atMs >= holdEndMs;
		},
	);
	const delivery = deps.readDelivery(room, injected.deliveryId);
	// Lead recipients: the Bridge delivery loop stamps notified_at when the
	// carrier accepts the batch; delivered_at is only written at ACK.
	const notifiedAtMs = Date.parse(delivery?.notified_at ?? "");
	evidence.injection = {
		injectedAt: new Date(injected.atMs).toISOString(),
		deliveryId: injected.deliveryId,
		deliveryState: delivery?.state ?? null,
		notifiedAt: delivery?.notified_at ?? null,
		deliveredAt: delivery?.delivered_at ?? null,
		ackedAt: delivery?.acked_at ?? null,
	};
	return evaluateLongTurn({
		samples,
		injectedAtMs: injected.atMs,
		truthStartMs: notifiedAtMs,
		holdMs: options.holdSeconds * 1000,
	});
}

// ── real dependencies ───────────────────────────────────────────────────────

function isPrivateFile(path) {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

/**
 * The chat-ingest child invocation. Its environment is exactly the room
 * coordinates plus a throwaway HOME: the doorbell's 401/403 fallback reads
 * `$HOME/.flywheel/.env`, so the real HOME would hand a production token to
 * the room Bridge. Never this runner's CommDB, ingest token or state dir.
 */
export function chatIngestInvocation(
	room,
	author,
	text,
	{ atMs, messageId, home },
) {
	return {
		file: process.execPath,
		args: [
			join(REPO, "packages/flywheel-comm/dist/index.js"),
			"chat-ingest",
			"--db",
			room.commDbPath,
			"--lead",
			room.agent,
			"--chat-id",
			room.chatChannelId,
			"--origin-channel-id",
			room.chatChannelId,
			"--reply-channel-id",
			room.chatChannelId,
			"--message-id",
			messageId,
			"--author-id",
			author.id,
			"--author-name",
			author.name,
			"--ts",
			new Date(atMs).toISOString(),
			"--msg-kind",
			"guild",
			"--attachments-json",
			"[]",
			"--content-stdin",
		],
		options: {
			input: text,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: home,
				BRIDGE_URL: room.bridgeUrl,
				PROJECT_NAME: room.projectName,
				TEAMLEAD_API_TOKEN: room.token,
			},
		},
	};
}

function realIngest(room, author, text) {
	const atMs = Date.now();
	const home = mkdtempSync(join(tmpdir(), "f2882-ingest-home-"));
	let child;
	try {
		const call = chatIngestInvocation(room, author, text, {
			atMs,
			messageId: syntheticMessageId(atMs),
			home,
		});
		child = spawnSync(call.file, call.args, call.options);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
	if (child.status !== 0)
		throw new FixtureError(`chat-ingest exited ${child.status}`);
	const verdict = JSON.parse(child.stdout.split("\n")[0] ?? "");
	if (verdict.lane !== "inserted_inbox" || verdict.deadLettered)
		throw new FixtureError(`chat-ingest lane ${verdict.lane}`);
	return { atMs, deliveryId: verdict.deliveryId };
}

function realReadDelivery(room, deliveryId) {
	const require = createRequire(join(REPO, "packages/teamlead/package.json"));
	const Database = require("better-sqlite3");
	const db = new Database(room.commDbPath, {
		readonly: true,
		fileMustExist: true,
		timeout: 5_000,
	});
	try {
		// Metadata columns only — never content / delivery_content.
		return (
			db
				.prepare(
					"SELECT state, notified_at, delivered_at, acked_at FROM mailbox WHERE delivery_id = ?",
				)
				.get(deliveryId) ?? null
		);
	} finally {
		db.close();
	}
}

function slotOneAuthor() {
	const slots = JSON.parse(
		readFileSync(join(homedir(), ".flywheel", "test-slots.json"), "utf8"),
	);
	const one = slots.slots?.find((slot) => slot.id === 1);
	if (!/^\d+$/.test(one?.botAppId ?? ""))
		throw new FixtureError("no slot-1 bot id; pass --author-id/--author-name");
	return { id: one.botAppId, name: "flywheel-test-1" };
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`qa-lead-activity-long-turn: ${error.message}`);
		console.error(
			"usage: qa-lead-activity-long-turn.mjs --slot <n> --agent <leadId> [--hold-seconds 75] [--poll-seconds 5] [--settle-seconds 240] [--no-warmup] [--author-id <id> --author-name <name>] [--out <abs.json>]",
		);
		return EXIT.setup;
	}
	let evidence;
	try {
		evidence = await runLongTurn(options, {
			readFile: (path) => readFileSync(path, "utf8"),
			isPrivateFile,
			fetch: globalThis.fetch,
			now: Date.now,
			sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
			nonce: () => randomBytes(6).toString("hex"),
			ingest: realIngest,
			readDelivery: realReadDelivery,
			defaultAuthor: slotOneAuthor,
			log: (line) => console.error(line),
		});
	} catch (error) {
		console.error(`qa-lead-activity-long-turn: ${error.message}`);
		return EXIT.setup;
	}
	const json = `${JSON.stringify(evidence, null, 2)}\n`;
	if (options.out) writeFileSync(options.out, json, { mode: 0o600 });
	process.stdout.write(json);
	return EXIT[evidence.result.verdict];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	process.exitCode = await main();
}

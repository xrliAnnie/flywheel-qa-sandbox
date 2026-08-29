/**
 * QA · FLY-1065 — end-to-end integration proof of Annie's two acceptance asks,
 * wiring the REAL feature-carrying production components together (not mocks of
 * them), driven by a scripted bilingual multi-turn conversation:
 *
 *   GeminiLiveBackend (turn aggregation + scrub, real)  ──final:true──▶
 *     ├─ TivPresenter.caption (real)   →  the running bidirectional TEXT panel
 *     └─ JsonlTranscriptSink (real)    →  the per-meeting <sessionId>.jsonl on disk
 *                                              │
 *   AssistantLanding.run (real) ── reads that SAME file ──▶ verbatim record comment
 *
 * What runs FOR REAL: the turn-aggregation + scrub chain (GeminiLiveBackend /
 * TurnAccumulator / scrubTranscript), the caption-rendering logic (TivPresenter),
 * the JSONL sink, and the landing's chunking + idempotency + row-reading
 * (AssistantLanding). What is STUBBED: the @google/genai transport wire (fed the
 * scripted server events — the seam the real-Gemini E2E in
 * evidence/live-aggregation-e2e.md covers 8/8), and the two I/O deps (a capturing
 * TivSendDeps standing in for Discord, a capturing LandingLinear standing in for
 * Linear). The P3 sink↔landing path alignment is set here by pointing both at one
 * temp file — that models the alignment; the PRODUCTION wiring that guarantees it
 * (wiring.ts assistantTranscriptPath) is covered separately by
 * assistant-wiring.test.ts. The real-Discord/real-Linear round is
 * evidence/staged-discord-e2e.md.
 *
 * Annie ([FLY-1047], 2026-07-09): "它在 Text 界面这边显示得还是不够清晰。这边
 * 能够把我说了什么、对方说了什么都显示出来吗？以及能不能实现类似对话记录的功能。"
 *   Ask 1 = live bidirectional display (who-said-what, per turn, in the channel).
 *   Ask 2 = an after-meeting verbatim record.
 * Both are asserted below, plus the secret red line, the interrupted mark, and
 * the 中英混说 language-agnostic contract.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GeminiLiveBackend,
	type GeminiLiveTransport,
	type GeminiModelProfile,
	JsonlTranscriptSink,
	type LiveConnection,
	type LiveConnectParams,
	type LiveServerEvent,
} from "flywheel-voice-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AssistantLanding,
	type LandingLinear,
} from "../assistant/AssistantLanding.js";
import { TivPresenter, type TivSendDeps } from "../discord/TivPresenter.js";

// ── transport stub (the @google/genai wire) — see the header for the full
//    mock accounting (the two I/O deps are stubbed below) ──────────────────────
class FakeConnection implements LiveConnection {
	closed = false;
	private cb?: (e: LiveServerEvent) => void;
	sendAudio(): void {}
	sendText(): void {}
	endAudioStream(): void {}
	sendToolResponse(): void {}
	onEvent(cb: (e: LiveServerEvent) => void): void {
		this.cb = cb;
	}
	emit(e: LiveServerEvent): void {
		this.cb?.(e);
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}
class FakeTransport implements GeminiLiveTransport {
	last?: FakeConnection;
	async connect(_p: LiveConnectParams): Promise<LiveConnection> {
		this.last = new FakeConnection();
		return this.last;
	}
}

const PROFILE: GeminiModelProfile = {
	model: "gemini-3.1-flash-live-preview",
	asyncFunctionCalling: false,
};

// a spoken credential — the shape scrubTranscript must redact at every exit.
const SPOKEN_SECRET = "sk-abcd1234efgh5678ijkl";

/** one scripted turn: her fragments, then his fragments, then the flush signal.
 * `end` = "generation" (normal turn) or "interrupted" (she barged in). */
interface Turn {
	user: string[];
	assistant: string[];
	end: "generation" | "interrupted";
}

const SCRIPT: Turn[] = [
	// 1 · pure Chinese
	{
		user: ["今天我们", "聊转写面板"],
		assistant: ["好的，", "我帮你看文本面板"],
		end: "generation",
	},
	// 2 · pure English (中英双语合同：英文轮)
	{
		user: ["Can you ", "show both sides?"],
		assistant: ["Yes, ", "I show both."],
		end: "generation",
	},
	// 3 · 中英混说同一轮
	{
		user: ["把 record ", "记下来 please"],
		assistant: ["好的 ", "I'll keep the record"],
		end: "generation",
	},
	// 4 · the assistant reads a credential aloud — the secret red line
	{
		user: ["念一下那个 key"],
		assistant: ["The key is ", SPOKEN_SECRET, " 好了"],
		end: "generation",
	},
	// 5 · she barges in mid-answer — interrupted mark
	{ user: ["等等"], assistant: ["我觉得", "应该这样"], end: "interrupted" },
];

describe("QA · FLY-1065 end-to-end: bidirectional captions + verbatim record", () => {
	let dir: string;
	let sessionId: string;
	let jsonlPath: string;

	// captured caption / status surface (what the Discord channel would show)
	let captions: string[];
	let statusAnchors: string[]; // one entry per NEW status message (spam sentinel)
	// what the single status anchor currently shows, appended on every
	// send/edit — its length proves edit-in-place happened and its tail proves
	// the latest line won (not a stale one).
	let statusRenders: string[];
	let tiv: TivPresenter;

	// This test drives the transcript→caption/quotes/recap path the way
	// AssistantSession's wireConversation handler does (final:true only; the
	// interrupted tail note composed at the call site; quotes = user finals).
	// It deliberately does NOT re-instantiate AssistantSession — its state
	// machine (concluding/landing recap guard + toLanding close-before-run
	// ordering) is covered directly by assistant-session.test.ts. Here recap is
	// a simplified "last assistant final" feed, enough to give the landing a
	// summary body; the assertions below never depend on recap-state nuance.
	const quotes: { ts: string; text: string }[] = [];
	let recapText: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "qa-fly1065-"));
		sessionId = "qa-fly1065-session";
		jsonlPath = join(dir, `${sessionId}.jsonl`);
		captions = [];
		statusAnchors = [];
		statusRenders = [];
		quotes.length = 0;
		recapText = "";

		const deps: TivSendDeps = {
			async send(text) {
				captions.push(text);
			},
			async sendForId(text) {
				statusAnchors.push(text);
				statusRenders.push(text);
				return { messageId: `status-${statusAnchors.length}` };
			},
			async edit(_id, text) {
				statusRenders.push(text);
			},
		};
		tiv = new TivPresenter({ deps, statusThrottleMs: 5 });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function runMeeting(): Promise<void> {
		const transport = new FakeTransport();
		const backend = new GeminiLiveBackend({ transport, profile: PROFILE });
		const sink = new JsonlTranscriptSink(jsonlPath);
		const session = await (
			backend.createConversation as NonNullable<
				typeof backend.createConversation
			>
		)({
			brain: { async *respond() {} },
			transcriptSink: sink,
		});

		// wire final transcripts → the text panel, the way AssistantSession's
		// wireConversation handler does (final:true only; interrupted tail note
		// at the call site; quotes = user finals; recap = assistant finals).
		session.on("transcript", (t) => {
			const ev = t as {
				role: "user" | "assistant";
				text: string;
				final: boolean;
				interrupted?: boolean;
			};
			if (!ev.final) return;
			tiv.caption(ev.role, ev.interrupted ? `${ev.text} (被打断)` : ev.text);
			if (ev.role === "user") {
				quotes.push({ ts: "00:00:00", text: ev.text });
			} else if (!ev.interrupted) {
				recapText += (recapText ? "\n" : "") + ev.text;
			}
		});

		const conn = transport.last as FakeConnection;
		for (const turn of SCRIPT) {
			for (const frag of turn.user) {
				conn.emit({
					type: "transcript",
					role: "user",
					text: frag,
					final: false,
				});
			}
			// first assistant fragment opens the turn → flushes her user turn (probe:
			// input transcription lands before the first output fragment).
			turn.assistant.forEach((frag, i) => {
				if (turn.end === "interrupted" && i > 0) return; // rest arrives post-append below
				conn.emit({
					type: "transcript",
					role: "assistant",
					text: frag,
					final: false,
				});
			});
			if (turn.end === "generation") {
				// the real signal sequence: generation-complete fires the fast caption
				// (~51ms after the last fragment), turn-complete terminates the turn
				// (~10s later) and resets turnActive/turnCancelled for the next turn.
				conn.emit({ type: "generation-complete" });
				conn.emit({ type: "turn-complete" });
			} else {
				// append the remaining fragment(s), THEN interrupt (the half-line must
				// be buffered before the interrupted flush or cancel swallows it).
				for (const frag of turn.assistant.slice(1)) {
					conn.emit({
						type: "transcript",
						role: "assistant",
						text: frag,
						final: false,
					});
				}
				conn.emit({ type: "interrupted" });
			}
		}
		await session.close(); // flushes any residual (rotator/teardown tail)
	}

	it("Ask 1 — live text panel shows who-said-what, one short message per turn", async () => {
		await runMeeting();

		// exactly one caption per role per turn → 10 messages, correctly attributed.
		expect(captions).toEqual([
			"🗣️ **Annie**:今天我们聊转写面板",
			"💬 **助理**:好的，我帮你看文本面板",
			"🗣️ **Annie**:Can you show both sides?",
			"💬 **助理**:Yes, I show both.",
			"🗣️ **Annie**:把 record 记下来 please",
			"💬 **助理**:好的 I'll keep the record",
			"🗣️ **Annie**:念一下那个 key",
			"💬 **助理**:The key is [redacted] 好了",
			"🗣️ **Annie**:等等",
			"💬 **助理**:我觉得应该这样 (被打断)",
		]);
	});

	it("Ask 1 — bilingual (中/英/混说) turns pass through the panel untouched", async () => {
		await runMeeting();
		expect(captions[2]).toContain("Can you show both sides?"); // pure English
		expect(captions[5]).toContain("好的 I'll keep the record"); // 中英混说 same turn
		// language-agnostic: no CJK special-casing mangled either register.
	});

	it("secret red line — a spoken credential is redacted at EVERY exit", async () => {
		await runMeeting();

		// exit 1: the live caption
		const secretCaption = captions.find(
			(c) => c.includes("助理") && c.includes("key is"),
		);
		expect(secretCaption).toContain("[redacted]");
		expect(captions.join("\n")).not.toContain(SPOKEN_SECRET);

		// exit 2: the persisted JSONL
		const raw = readFileSync(jsonlPath, "utf8");
		expect(raw).toContain("[redacted]");
		expect(raw).not.toContain(SPOKEN_SECRET);
	});

	it("Ask 2 — the JSONL sink persists one final row per role per turn", async () => {
		await runMeeting();
		const rows = readFileSync(jsonlPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>);

		expect(rows).toHaveLength(10); // 5 user + 5 assistant, one per turn
		expect(rows.every((r) => r.final === true)).toBe(true);
		expect(rows.map((r) => r.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		// the interrupted turn is recorded as-said, with the mark.
		const last = rows[9];
		expect(last.role).toBe("assistant");
		expect(last.text).toBe("我觉得应该这样");
		expect(last.interrupted).toBe(true);
	});

	it("Ask 2 — the after-meeting landing turns that SAME file into a verbatim record comment", async () => {
		await runMeeting();

		const comments: { issueId: string; body: string }[] = [];
		let closed = false;
		const linear: LandingLinear = {
			async comment(issueId, body) {
				comments.push({ issueId, body });
				return { url: "https://linear.app/geoforge3d/issue/FLY-1065#c1" };
			},
			async closeIssue() {
				closed = true;
			},
		};
		const landing = new AssistantLanding({
			linear,
			receiptPath: join(dir, `${sessionId}.landing-receipt.json`),
			transcriptPath: jsonlPath, // the SAME file the sink wrote — P3 alignment
			commandName: "gemini",
		});

		const result = await landing.run({
			issueId: "FLY-1065",
			sessionId,
			recapText,
			quotes,
			confirmed: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.transcriptChunks).toBe(1);
		expect(closed).toBe(true);

		// comment[0] = summary, comment[1] = verbatim record (Annie's 对话记录 ask).
		expect(comments).toHaveLength(2);
		expect(comments[0].body).toContain("会议纪要");
		expect(comments[0].body).toContain(`assistant-summary ${sessionId}`);

		const record = comments[1].body;
		expect(record).toContain("逐字对话记录");
		expect(record).toContain(`assistant-transcript ${sessionId} chunk 1/1`);
		// every turn, both sides, role-labelled — who-said-what after the meeting.
		expect(record).toContain("**Annie**:今天我们聊转写面板");
		expect(record).toContain("**助理**:好的，我帮你看文本面板");
		expect(record).toContain("**Annie**:Can you show both sides?");
		expect(record).toContain("**助理**:好的 I'll keep the record");
		expect(record).toContain("**助理**:我觉得应该这样 (被打断)"); // interrupted mark carried through
		// the secret never reaches Linear either (defense in depth at the exit).
		expect(record).toContain("[redacted]");
		expect(record).not.toContain(SPOKEN_SECRET);
	});

	it("Ask 1 — status is ONE anchor message edited in place (no 967 spam)", async () => {
		await runMeeting();

		// three state changes, each past the throttle window so the single-flight
		// machine flushes each one — the panel must not print three messages; it
		// prints one anchor and edits it to the newer lines.
		const settle = () => new Promise((r) => setTimeout(r, 25));
		tiv.status("🎧 正在听…");
		await settle();
		tiv.status("💭 正在想…");
		await settle();
		tiv.status("🛬 正在落纪要…");
		await settle();

		// exactly one NEW status message ever created (the no-spam invariant)…
		expect(statusAnchors).toHaveLength(1);
		// …and it was edited in place at least once (>1 render = send + ≥1 edit),
		// converging on the LATEST line (single-flight never leaves a stale one).
		expect(statusRenders.length).toBeGreaterThan(1);
		expect(statusRenders.at(-1)).toBe("🛬 正在落纪要…");
	});
});

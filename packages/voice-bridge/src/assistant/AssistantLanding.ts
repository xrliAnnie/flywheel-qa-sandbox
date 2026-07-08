/**
 * AssistantLanding (FLY-967 P6a) — the /gemini after-meeting pipeline:
 * summary (assistant recap + the founder's VERBATIM quotes from the JSONL
 * transcript — control prompts never enter the quote pool by construction)
 * → POST comment → close issue.
 *
 * Failure order is law (545 §6 landing semantics): a failed comment leaves
 * the issue open and names the transcript path as the fallback; a failed
 * close keeps the receipt so a re-run goes straight to close. The receipt
 * (comment success, keyed by sessionId) makes re-runs idempotent — the
 * summary comment is never duplicated (Codex R1 #5); the comment body also
 * carries an "assistant-summary <sessionId>" marker line for human audit.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LandingLinear {
	comment(issueId: string, body: string): Promise<{ url?: string }>;
	closeIssue(issueId: string): Promise<void>;
}

export interface AssistantLandingOptions {
	linear: LandingLinear;
	/** landing-receipt.json, transcript-adjacent. */
	receiptPath: string;
	/** named in the founder-facing fallback when the comment fails. */
	transcriptPath: string;
	/** the shipped slash-command name shown in the summary header. */
	commandName?: string;
	log?: (line: string) => void;
}

export interface LandingInput {
	issueId: string;
	sessionId: string;
	/** the assistant's spoken recap (assistant transcript of the final turn). */
	recapText: string;
	/** the founder's verbatim lines (user transcript entries only). */
	quotes: { ts: string; text: string }[];
	/** false = she left before the verbal confirmation (degraded close). */
	confirmed: boolean;
}

export type LandingResult =
	| { ok: true; commentUrl?: string }
	| { ok: false; stage: "comment" | "close"; message: string };

interface Receipt {
	issueId: string;
	sessionId: string;
	commentAt: string;
	commentUrl?: string;
}

export class AssistantLanding {
	constructor(private readonly opts: AssistantLandingOptions) {}

	static buildSummary(input: LandingInput, commandName = "gemini"): string {
		const lines = [
			`## 会议纪要(/${commandName} 助理)`,
			`assistant-summary ${input.sessionId}`,
			"",
		];
		if (!input.confirmed) {
			lines.push(
				"> ⚠️ 本纪要**未经口头确认**(会议在 recap 确认前结束)——如有出入请直接在 issue 里改。",
				"",
			);
		}
		lines.push(input.recapText.trim(), "", "### 原话引用");
		for (const q of input.quotes) {
			lines.push(`- [${q.ts}]「${q.text}」`);
		}
		return lines.join("\n");
	}

	async run(input: LandingInput): Promise<LandingResult> {
		let receipt = this.readReceipt();
		const receiptValid =
			receipt?.issueId === input.issueId &&
			receipt?.sessionId === input.sessionId;

		if (!receiptValid) {
			try {
				const posted = await this.opts.linear.comment(
					input.issueId,
					AssistantLanding.buildSummary(input, this.opts.commandName),
				);
				receipt = {
					issueId: input.issueId,
					sessionId: input.sessionId,
					commentAt: new Date().toISOString(),
					commentUrl: posted.url,
				};
				this.writeReceipt(receipt);
			} catch (err) {
				return {
					ok: false,
					stage: "comment",
					message: `纪要没写进 issue(${String((err as Error).message ?? err)})——完整记录在 ${this.opts.transcriptPath},issue 保持打开,可重跑落地。`,
				};
			}
		} else {
			this.opts.log?.(
				`[landing] receipt found for ${input.sessionId} — skipping the comment, going straight to close`,
			);
		}

		try {
			await this.opts.linear.closeIssue(input.issueId);
		} catch (err) {
			return {
				ok: false,
				stage: "close",
				message: `纪要已写进 issue,但关闭失败(${String((err as Error).message ?? err)})——请人工关闭 ${input.issueId};重跑只会补关闭,不会重发纪要。`,
			};
		}
		return { ok: true, commentUrl: receipt?.commentUrl };
	}

	private readReceipt(): Receipt | null {
		try {
			return JSON.parse(readFileSync(this.opts.receiptPath, "utf8")) as Receipt;
		} catch {
			return null;
		}
	}

	private writeReceipt(r: Receipt): void {
		mkdirSync(dirname(this.opts.receiptPath), { recursive: true });
		const tmp = `${this.opts.receiptPath}.tmp`;
		writeFileSync(tmp, JSON.stringify(r));
		renameSync(tmp, this.opts.receiptPath);
	}
}

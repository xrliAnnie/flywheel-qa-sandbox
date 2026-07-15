/**
 * FLY-1065 — scrubTranscript: the secret red line. Every external exit (final
 * transcript events, JSONL rows, Discord captions, Linear comments) passes
 * through this pure function. Credential shapes → [redacted]; ordinary spoken
 * language (Chinese / English / mixed), URLs and issue ids pass untouched —
 * the false-positive surface is pinned here.
 */
import { describe, expect, it } from "vitest";
import { scrubTranscript } from "../scrub.js";

const wrap = (secret: string) => [
	`这个 key 是 ${secret} 别念出来`,
	`the credential is ${secret} keep it safe`,
	`混排 mixed 的情况 ${secret} also hits`,
];

describe("scrubTranscript — credential shapes are redacted", () => {
	const cases: [string, string][] = [
		["OpenAI-style sk- key", "sk-AbCdEfGhIjKlMnOp1234"],
		["GitHub PAT ghp_", "ghp_ABCDEFGHIJKLMNOPQRST12"],
		["GitHub fine-grained github_pat_", "github_pat_ABCDEFGHIJKLMNOPQRST12"],
		["GitHub OAuth gho_", "gho_ABCDEFGHIJKLMNOPQRST12"],
		["Slack xoxb token", "xoxb-1234567890-abcdef"],
		["Google AIza key", "AIzaSyA1234567890abcdefghijklmnopqrstu"],
		[
			"bare long random string (letters+digits)",
			"q9Zx7Yw2Vt5Ur8Sq1Po4Nm6Lk3Ji0Hg9Fe8Dc7Ba",
		],
	];
	for (const [name, secret] of cases) {
		it(`redacts ${name} in Chinese / English / mixed wrapping`, () => {
			for (const text of wrap(secret)) {
				const out = scrubTranscript(text);
				expect(out).not.toContain(secret);
				expect(out).toContain("[redacted]");
			}
		});
	}

	it("redacts Bearer tokens", () => {
		const out = scrubTranscript("header 是 Bearer abc.DEF-ghi_jkl~mno 这样");
		expect(out).not.toContain("Bearer abc.DEF-ghi_jkl~mno");
		expect(out).toContain("[redacted]");
	});

	it("redacts NAME_TOKEN/KEY/SECRET/PASSWORD=value assignments", () => {
		for (const s of [
			"FLYWHEEL_API_TOKEN=abcd1234efgh",
			"GEMINI_API_KEY: sOmEvAlUe123",
			"DB_PASSWORD=hunter2hunter2",
			"MY_SECRET=verysecretvalue",
		]) {
			const out = scrubTranscript(`她提到 ${s} 的配置`);
			expect(out).not.toContain(s);
			expect(out).toContain("[redacted]");
		}
	});
});

describe("scrubTranscript — ordinary speech passes untouched", () => {
	const passthrough = [
		"今天我们聊一下转写面板的事,一来一回感觉还不错。",
		"This is an ordinary English sentence about the transcript panel.",
		"我们 mix 一下 English and 中文 in the same sentence, no problem.",
		"你去看一下 FLY-1065 和 GEO-145 这两个 issue。",
		"链接是 https://linear.app/geoforge3d/issue/FLY-1065 这个",
		"https://discord.com/channels/123456789012345678/987654321098765432",
		"密码这个词本身不该被误伤,token 这个词也一样。",
		"数字串 1234567890 和字母串 abcdefghij 都不够长,不动。",
	];
	for (const text of passthrough) {
		it(`passes: ${text.slice(0, 30)}…`, () => {
			expect(scrubTranscript(text)).toBe(text);
		});
	}
});

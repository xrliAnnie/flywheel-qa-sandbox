# FLY-959 voice-core 已知 bug 修复 — 实施计划

Issue: FLY-959 (https://linear.app/geoforge3d/issue/FLY-959/voice-voice-core-已知-bug-修复-mic-默认设备-session-过期不重连-ask-lead-缺-schema)
日期: 2026-07-07
基于: research.md

> **For the Implement-phase runner:** 本计划按 TDD 逐任务执行(RED → GREEN → commit),
> 全部在**本分支** `flywheel-FLY-959` 上继续(三段式共享分支,不要新开 worktree)。
> 每完成一个 Task 更新 `progress.md`(`flywheel-comm progress --phase implement --cursor N/8`)。

**Goal:** 修 FLY-543 真机 QA 抓到的 4 处 voice-core converse 面 bug(mic 默认设备 /
session 过期不重连 / ask_lead 缺 schema / 默认模型 404),并用真机回归收口。

**Architecture:** 全部改动限于 `packages/voice-core`。backend 的 resume/tool 合同不变
(mock 已测),新增一个可单测的 `TalkSessionRotator` 编排 session 续期;transport 接口
`toolNames` 升级为完整 tool 声明;config 增加 `micDevice` 并换默认模型;`ProcessHandle`
加性扩展 `onStderr` 以支撑 mic 失败指引。

**Tech Stack:** TypeScript (ESM) / vitest / ffmpeg avfoundation / `@google/genai` Live API。

**File Structure(改动地图):**

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/config.ts` | 改 | 新默认模型 + `micDevice` 字段(override > env > `":default"`) |
| `src/process.ts` | 改 | `ProcessHandle` 加 `onStderr`(接口 + `NodeProcessHandle`) |
| `src/audio/MicCapture.ts` | 改 | 默认设备 `":default"`;exit 非零时带 stderr + 自救指引回调 |
| `src/backends/gemini/transport.ts` | 改 | `LiveToolDeclaration` 接口;`LiveConnectParams.toolNames` → `tools` |
| `src/backends/gemini/GeminiLiveBackend.ts` | 改 | `ASK_LEAD_DECLARATION`(完整 schema)传给 connect |
| `src/backends/gemini/genaiConnector.ts` | 改 | tools 原样传 SDK;callId→name 回填;`describeUnexpectedClose` 纯函数(404 指引) |
| `src/TalkSessionRotator.ts` | **新建** | goAway 驱动的 session 续期编排(单飞、无 handle 降级、失败显式上抛) |
| `src/cli.ts` | 改 | `runTalk` 接 rotator + `config.micDevice` + mic onError + 统一 shutdown |
| `src/__tests__/config.test.ts` | 改 | 新默认模型 + micDevice 解析 |
| `src/__tests__/fakes.ts` | 改 | `FakeProcessHandle` 加 `onStderr`/`emitStderr` |
| `src/__tests__/audio.test.ts` | 改 | MicCapture 默认设备 / 失败指引 |
| `src/__tests__/gemini-live.test.ts` | 改 | `toolNames`→`tools` 断言 + schema 穿透断言 |
| `src/__tests__/genai-connector.test.ts` | **新建** | `describeUnexpectedClose` 纯函数 |
| `src/__tests__/rotator.test.ts` | **新建** | rotator 8 场景(含 stale-expire 防护) |
| `evidence/fly-959-regression.md` | **新建** | 真机回归记录(Task 8) |

测试命令(所有 Task 通用):`pnpm --filter flywheel-voice-core test`(vitest run);
lint:仓库根 `pnpm lint`。

---

### Task 0: 前置核验 — 模型仍可用(不写代码)

- [ ] 用真 key 重跑 models.list(key 沿用 543 的借用方案,来自 `~/.zshrc` 的
  `NANOBANANA_GEMINI_API_KEY`,**值不进任何 comm/Discord 消息**):

```bash
cd packages/voice-core && GEMINI_API_KEY="$NANOBANANA_GEMINI_API_KEY" node -e '
import("@google/genai").then(async ({ GoogleGenAI }) => {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for await (const m of await client.models.list()) {
    if ((m.supportedActions ?? []).includes("bidiGenerateContent")) console.log(m.name);
  }
});'
```

Expected: 输出包含 `models/gemini-3.1-flash-live-preview`。
若不包含:停,选 list 里的 native-audio 替代并 `flywheel-comm ask` 报 Lead 再继续。

### Task 1: config — 默认模型 + micDevice

**Files:** Modify `src/config.ts`, `src/__tests__/config.test.ts`

- [ ] **RED** — `config.test.ts` 加(仿既有用例风格):

```ts
it("defaults gemini model to the live-verified gemini-3.1-flash-live-preview", () => {
	const c = resolveConfig({}, {});
	expect(c.gemini.model).toBe("gemini-3.1-flash-live-preview");
});

it("resolves micDevice: override > env > ':default'", () => {
	expect(resolveConfig({}, {}).micDevice).toBe(":default");
	expect(
		resolveConfig({}, { FLYWHEEL_VOICE_MIC_DEVICE: ":2" }).micDevice,
	).toBe(":2");
	expect(
		resolveConfig({ micDevice: ":1" }, { FLYWHEEL_VOICE_MIC_DEVICE: ":2" })
			.micDevice,
	).toBe(":1");
});
```

Run: `pnpm --filter flywheel-voice-core test` → FAIL(模型名不等 / micDevice 不存在)。

- [ ] **GREEN** — `config.ts`:
  - `const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-live-preview";`(旧名
    `gemini-live-2.5-flash-preview` 已 404,evidence/real-live-models-list.json)
  - `VoiceCoreConfig` 加字段(放 `ffmpegBin` 后):

```ts
	/** mic capture device — avfoundation input spec (converse), e.g. ":default" / ":2". */
	micDevice: string;
```

  - `resolveConfig` 返回对象加:

```ts
		micDevice: pick(
			overrides.micDevice,
			env.FLYWHEEL_VOICE_MIC_DEVICE,
			":default",
		),
```

  (`ConfigOverrides` 是 `Partial<Omit<...>>`,顶层 string 字段自动纳入,无需改。)

- [ ] Run tests → PASS。
- [ ] Commit: `fix(voice-core): FLY-959 default model gemini-3.1-flash-live-preview + micDevice config`

### Task 2: ProcessHandle.onStderr(加性接缝扩展)

**Files:** Modify `src/process.ts`, `src/__tests__/fakes.ts`

- [ ] **RED** — 先写 Task 3 会用到的断言不现实(接口层无行为),本 Task 以类型编译为
  合同:`fakes.ts` 的 `FakeProcessHandle` 加驱动后跑一次全测编译即可。改动:

`process.ts` — `ProcessHandle` 接口 `onStdout` 后加:

```ts
	onStderr(cb: (chunk: Buffer) => void): void;
```

`NodeProcessHandle` 加实现(`onStdout` 实现后):

```ts
	onStderr(cb: (chunk: Buffer) => void): void {
		this.child.stderr?.on("data", (c: Buffer) => cb(c));
	}
```

`fakes.ts` — `FakeProcessHandle` 加(镜像 stdout 三件套):

```ts
	private stderrCbs: ((c: Buffer) => void)[] = [];
	onStderr(cb: (chunk: Buffer) => void): void {
		this.stderrCbs.push(cb);
	}
	emitStderr(s: string | Buffer): void {
		const buf = Buffer.isBuffer(s) ? s : Buffer.from(s);
		for (const cb of [...this.stderrCbs]) cb(buf);
	}
```

- [ ] Run: `pnpm --filter flywheel-voice-core test` + `pnpm --filter flywheel-voice-core typecheck` → PASS(纯加性)。
- [ ] Commit: `feat(voice-core): FLY-959 ProcessHandle.onStderr (additive seam for mic diagnostics)`

### Task 3: MicCapture — 默认 `":default"` + 失败指引

**Files:** Modify `src/audio/MicCapture.ts`, `src/__tests__/audio.test.ts`

- [ ] **RED** — `audio.test.ts` 加:

```ts
it("captures from the system default input (:default) when no device given", () => {
	const runner = new FakeProcessRunner();
	const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
	mic.start(() => {});
	const spawned = runner.spawned[0];
	const i = spawned.args.indexOf("-i");
	expect(spawned.args[i + 1]).toBe(":default");
});

it("passes an explicit device through unchanged", () => {
	const runner = new FakeProcessRunner();
	const mic = new MicCapture({ ffmpegBin: "ffmpeg", device: ":2", runner });
	mic.start(() => {});
	expect(runner.spawned[0].args).toContain(":2");
});

it("reports a non-zero exit with stderr + device guidance via onError", () => {
	const runner = new FakeProcessRunner();
	const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
	const errors: VoiceError[] = [];
	mic.start(() => {}, (e) => errors.push(e));
	const h = runner.handles[0];
	h.emitStderr(": Input/output error");
	h.emitExit(1);
	expect(errors).toHaveLength(1);
	expect(errors[0].code).toBe("subprocess-failed");
	expect(errors[0].message).toContain("Input/output error");
	expect(errors[0].message).toContain("-list_devices");
	expect(errors[0].message).toContain("FLYWHEEL_VOICE_MIC_DEVICE");
});

it("stays silent when exit follows an intentional stop()", () => {
	const runner = new FakeProcessRunner();
	const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
	const errors: VoiceError[] = [];
	mic.start(() => {}, (e) => errors.push(e));
	const h = runner.handles[0];
	mic.stop();
	h.emitExit(null, "SIGTERM");
	expect(errors).toHaveLength(0);
});
```

(`FakeProcessRunner` 若尚无 `spawned`/`handles` 记录数组,按 `fakes.ts` 现状补齐——
既有测试已用它记录 spawn 调用,如字段名不同以现状为准改断言取值方式。)

Run → FAIL(默认仍 `:0`、`start` 无第二参)。

- [ ] **GREEN** — `MicCapture.ts`:
  - `MicCaptureOptions.device` 注释改:`/** avfoundation input spec, e.g. ":default" (system default input) or ":2". */`
  - 类加 `private stopped = false;`
  - `start` 改为:

```ts
	/** begin streaming; onFrame receives raw 16kHz mono s16le PCM chunks.
	 * onError fires once if ffmpeg dies while capture is still wanted. */
	start(
		onFrame: (frame: Buffer) => void,
		onError?: (err: VoiceError) => void,
	): void {
		if (this.handle)
			throw new VoiceError("backend-protocol", "mic capture already started");
		this.stopped = false;
		const device = this.opts.device ?? ":default";
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"avfoundation",
			"-i",
			device,
			"-ar",
			String(this.opts.sampleRateHz ?? 16_000),
			"-ac",
			"1",
			"-f",
			"s16le",
			"pipe:1",
		];
		const handle = this.runner.spawn(this.opts.ffmpegBin, args);
		let stderrTail = "";
		handle.onStderr((chunk) => {
			stderrTail = (stderrTail + chunk.toString()).slice(-2000);
		});
		handle.onStdout((chunk) => {
			if (!this.muted) onFrame(chunk);
		});
		handle.onExit((code, signal) => {
			if (this.stopped) return; // intentional stop()
			onError?.(
				new VoiceError(
					"subprocess-failed",
					`mic capture (ffmpeg avfoundation "${device}") exited ${
						code !== null ? `with code ${code}` : `on ${signal}`
					}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""} — list devices with \`ffmpeg -f avfoundation -list_devices true -i ""\` and set --device or FLYWHEEL_VOICE_MIC_DEVICE (e.g. ":2")`,
				),
			);
		});
		this.handle = handle;
	}
```

  - `stop()` 首行加 `this.stopped = true;`
  - 文件头注释里"(default audio device)"的误导说法一并订正。

- [ ] Run tests → PASS。
- [ ] Commit: `fix(voice-core): FLY-959 mic follows system default input (:default) + actionable failure guidance`

### Task 4: tool 声明升级(schema 穿透)

**Files:** Modify `src/backends/gemini/transport.ts`, `GeminiLiveBackend.ts`, `genaiConnector.ts`, `src/__tests__/gemini-live.test.ts`

- [ ] **RED** — `gemini-live.test.ts`:
  - 把 `expect(conn.params.toolNames).toContain("ask_lead")`(约 :263)改为:

```ts
		const askLead = conn.params.tools.find((t) => t.name === "ask_lead");
		expect(askLead).toBeDefined();
```

  - 新增用例:

```ts
	it("declares ask_lead with description + parameters schema (FLY-959 bug 3)", async () => {
		const { conn } = await openSession(); // 按本文件既有 helper 取 conn
		const tool = conn.params.tools[0];
		expect(tool.name).toBe("ask_lead");
		expect(tool.description).toMatch(/project/i);
		expect(tool.parameters).toMatchObject({
			type: "OBJECT",
			required: ["question"],
		});
		expect(
			(tool.parameters as { properties: Record<string, unknown> }).properties,
		).toHaveProperty("question");
	});
```

Run → FAIL(类型上无 `tools`)。

- [ ] **GREEN**:

`transport.ts` — 加接口、替换字段(同时更新文件头注释提及 tools 声明):

```ts
/** A full function declaration — real models need description+parameters to
 * actually call a tool (FLY-543 QA: zero-schema declarations made the model
 * fabricate answers or stall). Passed to the SDK verbatim. */
export interface LiveToolDeclaration {
	name: string;
	description: string;
	/** JSON-schema-style object ({ type: "OBJECT", properties, required }). */
	parameters: Record<string, unknown>;
}
```

`LiveConnectParams` 里 `toolNames: string[]` →

```ts
	/** declared tools (the brain is surfaced as ask_lead). */
	tools: LiveToolDeclaration[];
```

`GeminiLiveBackend.ts` — `ASK_LEAD_TOOL` 常量下加:

```ts
const ASK_LEAD_DECLARATION: LiveToolDeclaration = {
	name: ASK_LEAD_TOOL,
	description:
		"Ask the Lead (the project brain) a question about the project — its issues, status, decisions, or code. Always call this instead of guessing whenever the user asks about project matters.",
	parameters: {
		type: "OBJECT",
		properties: {
			question: {
				type: "STRING",
				description: "The user's question, in their own words.",
			},
		},
		required: ["question"],
	},
};
```

(import 处加 `type LiveToolDeclaration`;`createConversation` 里
`toolNames: [ASK_LEAD_TOOL]` → `tools: [ASK_LEAD_DECLARATION]`。)

`genaiConnector.ts` — config 的 tools 改为原样映射:

```ts
				tools: [
					{
						functionDeclarations: params.tools.map((t) => ({
							name: t.name,
							description: t.description,
							parameters: t.parameters,
						})),
					},
				],
```

同文件顺手修 `sendToolResponse` 硬编码 name(callId→name 表,防未来第二个工具错名):

```ts
			const callNames = new Map<string, string>();
```

(`connect` 闭包里、`onEvent` 声明旁)onmessage 改为:

```ts
					onmessage: (msg: any) =>
						mapMessage(msg, (e) => {
							if (e.type === "tool-call") callNames.set(e.callId, e.name);
							onEvent(e);
						}),
```

`sendToolResponse` 改为:

```ts
				sendToolResponse(callId: string, output: string) {
					session.sendToolResponse({
						functionResponses: [
							{
								id: callId,
								name: callNames.get(callId) ?? params.tools[0]?.name ?? "ask_lead",
								response: { output },
							},
						],
					});
					callNames.delete(callId);
				},
```

同时更新文件头 `⚠️ S0.2-PENDING` 注释:S0.2 已被 543 QA 真机证实(poc-converse.md),
把该段落改写为指向 evidence 的一句话,不再自称未验证。

- [ ] Run tests → PASS(mock transport 只透传 params,断言即穿透证明)。
- [ ] Commit: `fix(voice-core): FLY-959 ask_lead full JSON schema through transport (real models need it to call tools)`

### Task 5: 连接 404 自救指引(纯函数)

**Files:** Modify `src/backends/gemini/genaiConnector.ts`; Create `src/__tests__/genai-connector.test.ts`

- [ ] **RED** — 新建 `genai-connector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeUnexpectedClose } from "../backends/gemini/genaiConnector.js";

describe("describeUnexpectedClose", () => {
	it("appends model guidance when the close reason is a model-404", () => {
		const msg = describeUnexpectedClose(
			"models/gemini-live-2.5-flash-preview is not found for API version v1beta, or is not supported for bidiGenerateContent.",
			"gemini-live-2.5-flash-preview",
		);
		expect(msg).toContain("FLYWHEEL_VOICE_GEMINI_MODEL");
		expect(msg).toContain("models.list");
		expect(msg).toContain("gemini-live-2.5-flash-preview");
	});

	it("keeps plain unexpected closes unchanged", () => {
		expect(describeUnexpectedClose("going away", "m")).toBe(
			"Gemini Live connection closed unexpectedly: going away",
		);
		expect(describeUnexpectedClose(undefined, "m")).toBe(
			"Gemini Live connection closed unexpectedly",
		);
	});
});
```

Run → FAIL(函数不存在)。

- [ ] **GREEN** — `genaiConnector.ts` 加导出纯函数(SDK 无关,文件底部):

```ts
/** Human-actionable message for an unexpected ws close. A "model not found"
 * reason gets self-rescue guidance (FLY-959 bug 4: Google retires preview
 * models; the next 404 should cost the user 30 seconds, not a debug session). */
export function describeUnexpectedClose(
	reason: string | undefined,
	model: string,
): string {
	const base = `Gemini Live connection closed unexpectedly${reason ? `: ${reason}` : ""}`;
	if (
		reason &&
		/is not found for API version|not supported for bidiGenerateContent/i.test(
			reason,
		)
	) {
		return `${base} — the configured model "${model}" looks retired/renamed; set FLYWHEEL_VOICE_GEMINI_MODEL to a live model (verify with client.models.list(); snapshot: packages/voice-core/evidence/real-live-models-list.json)`;
	}
	return base;
}
```

`onclose` 回调改用它:

```ts
					onclose: (e: any) => {
						if (!intentionalClose) {
							onEvent({
								type: "error",
								message: describeUnexpectedClose(e?.reason, params.model),
							});
						}
					},
```

- [ ] Run tests → PASS。
- [ ] Commit: `feat(voice-core): FLY-959 model-404 close reasons carry self-rescue guidance`

### Task 6: TalkSessionRotator(bug 2 核心)

**Files:** Create `src/TalkSessionRotator.ts`, `src/__tests__/rotator.test.ts`

- [ ] **RED** — 新建 `rotator.test.ts`(FakeSession 直接内联,不进 fakes.ts——只此一个消费者):

```ts
import { describe, expect, it } from "vitest";
import { TalkSessionRotator } from "../TalkSessionRotator.js";
import { TypedEmitter } from "../emitter.js";
import type {
	AudioFormat,
	ConversationEventMap,
	ConversationSession,
	ResumeHandle,
	ScheduleHint,
	ToolResult,
} from "../types.js";

const PCM: AudioFormat = { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 };

class FakeSession implements ConversationSession {
	readonly sessionId: string;
	frames: Buffer[] = [];
	closed = false;
	private readonly emitter = new TypedEmitter<ConversationEventMap>();
	constructor(
		id: string,
		private readonly handleOnClose?: string,
	) {
		this.sessionId = id;
	}
	sendAudio(frame: Buffer): void {
		this.frames.push(frame);
	}
	interrupt(): void {}
	injectToolResult(_r: ToolResult, _s?: ScheduleHint): void {}
	on<E extends keyof ConversationEventMap>(
		e: E,
		h: (...a: ConversationEventMap[E]) => void,
	): () => void {
		return this.emitter.on(e, h);
	}
	async close(): Promise<ResumeHandle | undefined> {
		this.closed = true;
		return this.handleOnClose
			? { backendId: "gemini-live", payload: this.handleOnClose }
			: undefined;
	}
	expire(): void {
		this.emitter.emit("session-expiring", { inSec: 50 });
	}
}

function harness(opts?: {
	handles?: (string | undefined)[]; // per-session close() handle
	failCreateAt?: number; // 1-based create() call that rejects
}) {
	const sessions: FakeSession[] = [];
	const createArgs: (ResumeHandle | undefined)[] = [];
	const attached: string[] = [];
	const logs: string[] = [];
	const errors: unknown[] = [];
	let deferred: ((s: ConversationSession) => void) | undefined;
	const rotator = new TalkSessionRotator({
		create: (resumeHandle) => {
			createArgs.push(resumeHandle);
			if (opts?.failCreateAt === createArgs.length)
				return Promise.reject(new Error("connect refused"));
			const s = new FakeSession(
				`s${createArgs.length}`,
				opts?.handles?.[sessions.length],
			);
			sessions.push(s);
			return new Promise((resolve) => {
				deferred = undefined;
				resolve(s);
			});
		},
		attach: (s) => attached.push(s.sessionId),
		log: (l) => logs.push(l),
		onError: (e) => errors.push(e),
	});
	return { rotator, sessions, createArgs, attached, logs, errors };
}

describe("TalkSessionRotator", () => {
	it("start() opens and attaches the first session", async () => {
		const h = harness();
		await h.rotator.start();
		expect(h.attached).toEqual(["s1"]);
		expect(h.createArgs).toEqual([undefined]);
	});

	it("session-expiring closes the old session and resumes with its handle", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.sessions[0].closed).toBe(true);
		expect(h.createArgs[1]).toEqual({
			backendId: "gemini-live",
			payload: "h-1",
		});
		expect(h.attached).toEqual(["s1", "s2"]);
		expect(h.logs.some((l) => l.includes("resumed"))).toBe(true);
	});

	it("falls back to a fresh session when close() yields no handle", async () => {
		const h = harness({ handles: [undefined] });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs[1]).toBeUndefined();
		expect(h.logs.some((l) => l.includes("context lost"))).toBe(true);
	});

	it("is single-flight: double expiring triggers one rotation", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		h.sessions[0].expire();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs).toHaveLength(2); // start + one rotation
	});

	it("ignores stale expiring from a rotated-out session (Codex R1 #1)", async () => {
		const h = harness({ handles: ["h-1", "h-2"] });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r)); // s2 is live now
		h.sessions[0].expire(); // late/duplicate go-away from the OLD session
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs).toHaveLength(2); // no third create
		expect(h.sessions[1].closed).toBe(false); // s2 untouched
	});

	it("drops frames during rotation, then feeds the new session", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		h.sessions[0].expire(); // rotation begins; session detached synchronously
		h.rotator.sendAudio(Buffer.from("x"), PCM); // must not throw / not reach s1
		await new Promise((r) => setImmediate(r));
		h.rotator.sendAudio(Buffer.from("y"), PCM);
		expect(h.sessions[0].frames).toHaveLength(0);
		expect(h.sessions[1].frames).toHaveLength(1);
	});

	it("surfaces rotation failure via onError", async () => {
		const h = harness({ handles: ["h-1"], failCreateAt: 2 });
		await h.rotator.start();
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.errors).toHaveLength(1);
	});

	it("close() returns the live session's handle and stops rotation", async () => {
		const h = harness({ handles: ["h-1"] });
		await h.rotator.start();
		const handle = await h.rotator.close();
		expect(handle).toEqual({ backendId: "gemini-live", payload: "h-1" });
		h.sessions[0].expire();
		await new Promise((r) => setImmediate(r));
		expect(h.createArgs).toHaveLength(1); // no rotation after close
	});
});
```

Run → FAIL(模块不存在)。

- [ ] **GREEN** — 新建 `src/TalkSessionRotator.ts`:

```ts
/**
 * TalkSessionRotator — keeps a talk conversation alive across Gemini Live
 * session expiry (FLY-959 bug 2). On "session-expiring" (server goAway) it
 * closes the current session, takes the ResumeHandle, and opens a resumed
 * session with it. The mic and player never restart; frames arriving during
 * the sub-second swap are dropped. Scope: goAway-driven renewal ONLY —
 * unexpected disconnects (error events) still surface and are not retried.
 */
import type {
	AudioFormat,
	ConversationSession,
	ResumeHandle,
} from "./types.js";

export interface TalkSessionRotatorOptions {
	/** open a (possibly resumed) conversation — the CLI binds backend+opts here. */
	create: (resumeHandle?: ResumeHandle) => Promise<ConversationSession>;
	/** attach CLI event handlers; called for the first and every rotated session. */
	attach: (session: ConversationSession) => void;
	/** rotation status lines (the CLI writes them to stderr). */
	log?: (line: string) => void;
	/** rotation failed — the conversation is dead; the CLI decides shutdown. */
	onError?: (err: unknown) => void;
}

export class TalkSessionRotator {
	private session?: ConversationSession;
	private rotating = false;
	private closed = false;

	constructor(private readonly opts: TalkSessionRotatorOptions) {}

	/** open the first session. */
	async start(): Promise<void> {
		const first = await this.opts.create();
		this.session = first;
		this.hook(first);
	}

	/** forward one mic frame; dropped while a rotation is in flight. */
	sendAudio(frame: Buffer, format: AudioFormat): void {
		this.session?.sendAudio(frame, format);
	}

	/** close the live session (if any) and stop all future rotation. */
	async close(): Promise<ResumeHandle | undefined> {
		this.closed = true;
		const s = this.session;
		this.session = undefined;
		return s?.close();
	}

	private hook(session: ConversationSession): void {
		this.opts.attach(session);
		// session-scoped: a late/duplicate go-away from a rotated-out session
		// must never rotate (and close) its successor (Codex R1 #1).
		session.on("session-expiring", () => {
			if (this.session === session) void this.rotate(session);
		});
	}

	/** single-flight goAway renewal: close → take handle → reopen resumed. */
	private async rotate(expected: ConversationSession): Promise<void> {
		if (this.rotating || this.closed || this.session !== expected) return;
		this.rotating = true;
		const old = expected;
		this.session = undefined; // frames drop instead of hitting a dying socket
		try {
			const handle = await old.close();
			const next = await this.opts.create(handle);
			if (this.closed) {
				await next.close(); // closed mid-rotation — don't leak the new session
				return;
			}
			this.session = next;
			this.hook(next);
			this.opts.log?.(
				handle
					? "[session resumed]"
					: "[session restarted — no resume handle, context lost]",
			);
		} catch (err) {
			this.opts.onError?.(err);
		} finally {
			this.rotating = false;
		}
	}
}
```

- [ ] Run tests → PASS。`src/index.ts` 若集中导出公共 API,则同步导出
  `TalkSessionRotator`(以 index.ts 现状为准;cli 内部用相对导入,不强求)。
- [ ] Commit: `feat(voice-core): FLY-959 TalkSessionRotator — auto-renew talk sessions on goAway`

### Task 7: cli.ts runTalk 接线

**Files:** Modify `src/cli.ts`

runTalk 是交互进程循环,无单测(与现状一致);正确性由 Task 6 单测 + Task 8 真机回归
覆盖。改动后完整 `runTalk`(直接替换原函数;import 区新增
`import { TalkSessionRotator } from "./TalkSessionRotator.js";`,并把
`ConversationSession` 的 type import 保留):

```ts
async function runTalk(args: CliArgs): Promise<void> {
	const config = resolveConfig(overridesFromArgs(args));
	verifyConverseComponents(config); // fail-fast if GEMINI_API_KEY missing
	const registry = buildRegistry(config, {
		enableConverse: true,
		converse: { apiKey: process.env[config.gemini.apiKeyEnv] },
	});
	const backend = await registry.create("gemini-live");
	const brain = buildHeadlessBrain(config);
	const transcriptPath = join(
		config.transcriptDir,
		`voice-talk-${args.leadId ?? "lead"}-${Date.now()}.jsonl`,
	);
	const transcriptSink = new JsonlTranscriptSink(transcriptPath);
	const player = new StreamPlayer({ ffplayBin: config.ffplayBin });
	const mic = new MicCapture({
		ffmpegBin: config.ffmpegBin,
		device: args.device ?? config.micDevice,
	});
	const PCM: AudioFormat = {
		encoding: "pcm16",
		sampleRateHz: 16_000,
		channels: 1,
	};

	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let shuttingDown = false;
	// single shutdown path: SIGINT, mic death, and failed renewal all land here.
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		mic.stop();
		player.close();
		void rotator.close().finally(() => finish());
	};

	const attach = (session: ConversationSession): void => {
		session.on("response-audio", (chunk) => player.feed(chunk));
		session.on("response-cancelled", () => player.interrupt());
		session.on("transcript", ({ role, text, final }) => {
			if (final)
				process.stdout.write(
					`  ${role === "user" ? "you" : "lead"}: ${text}\n`,
				);
		});
		session.on("session-expiring", ({ inSec }) =>
			process.stderr.write(`  [session expiring in ~${inSec}s — renewing]\n`),
		);
		// low-noise regression marker (Codex R1 #2): objective proof the model
		// really called the tool — name+callId only, never args/question text.
		session.on("tool-call", ({ callId, name }) =>
			process.stderr.write(`  [tool-call ${name} ${callId}]\n`),
		);
		session.on("error", (err) =>
			process.stderr.write(`  [error ${err.code}] ${err.message}\n`),
		);
	};

	const rotator = new TalkSessionRotator({
		create: (resumeHandle) =>
			(
				backend.createConversation as NonNullable<
					typeof backend.createConversation
				>
			)({
				brain,
				voice: config.voice,
				systemHint: "spoken, short sentences, no markdown",
				transcriptSink,
				resumeHandle,
			}),
		attach,
		log: (line) => process.stderr.write(`  ${line}\n`),
		onError: (err) => {
			process.stderr.write(`  [fatal] session renewal failed: ${String(err)}\n`);
			process.exitCode = 1;
			shutdown();
		},
	});

	await rotator.start();
	mic.start(
		(frame) => rotator.sendAudio(frame, PCM),
		(err) => {
			process.stderr.write(`  [fatal] ${err.message}\n`);
			process.exitCode = 1;
			shutdown();
		},
	);
	process.stdout.write(
		`flywheel-voice-poc talk — backend=${backend.id}  lead=${args.leadId ?? "(none)"}\n` +
			`transcript → ${transcriptPath}\nSpeak now. Ctrl+C to quit.\n`,
	);
	process.on("SIGINT", shutdown);
	await done;
}
```

(注:`shutdown` 闭包引用 `rotator`,而 `rotator` 的 `onError` 又引用 `shutdown`——
`shutdown` 只会在 `rotator.start()` 之后被调用,`const rotator` 声明在 `shutdown`
定义之后、任何调用之前,无 TDZ 风险。HELP 文本里 `[--device :0]` 示例同步改成
`[--device :default]`。)

- [ ] Run: `pnpm --filter flywheel-voice-core test && pnpm --filter flywheel-voice-core typecheck` → PASS。
- [ ] Commit: `fix(voice-core): FLY-959 talk auto-renews expiring sessions + system-default mic + mic failure exits loud`

### Task 8: 全量验证 + 真机回归 + PR

- [ ] 全仓 `pnpm lint`(push 前必跑,memory 规则)+ `pnpm --filter flywheel-voice-core test`。
- [ ] `pnpm --filter flywheel-voice-core build` 后**真机回归**(543 教训:mock 不算数),
  4 条验收逐条做、结果记入 `evidence/fly-959-regression.md`(格式仿 poc-converse.md,
  含命令、观察输出、结论;音频类证据注明文件路径):

| # | 验收 | 操作 | 通过判据 |
|---|------|------|----------|
| R1 | 默认 mic = 系统默认 | `GEMINI_API_KEY="$NANOBANANA_GEMINI_API_KEY" node dist/cli.js talk --lead flywheel-eng-lead --project <主仓路径>`(**不带 --device**);同时 `ffmpeg -f avfoundation -list_devices true -i ""` 记录设备表与系统默认 | 说一句话出现 `you: ...` transcript;(可选强证)临时用 `FLYWHEEL_VOICE_FFMPEG` 指向包装脚本加 `-loglevel debug` 观察 `audio device '<系统默认名>' opened` |
| R2 | 跨过期自动续期 | 同一会话挂机 + 间歇说话,直到出现 `[session expiring ...]` | 出现 `[session resumed]`,**之后再问一句仍有回答**;进程不退 |
| R3 | ask_lead 真调用 | 语音问 "What is FLY-543 about?" | **必需铁证**(Codex R1 #2,543 的原始故障就是"不调工具还答得像模像样"):stderr 出现 `[tool-call ask_lead <id>]` 标记(Task 7 内置)**且**回答与项目事实相符;transcript JSONL 留档。无标记 = FAIL,答案再像也不算过 |
| R4 | 默认模型直连 | R1 即覆盖(不设 `FLYWHEEL_VOICE_GEMINI_MODEL`) | 连接成功、无 `not found` 错误 |

  预算纪律:R1-R4 合并到 1-2 次真会话里完成(543 教训:Annie 不想无谓烧 key),
  全程真 key 值不落任何文档/消息。
- [ ] 更新 `evidence/README.md` 索引(若有列表)+ 把 `progress.md` cursor 推到 8/8。
- [ ] `gh pr create`(base main,标题 `fix(voice-core): FLY-959 known bug fixes — mic default device / session renewal / ask_lead schema / model 404`,body 带 `## Linear Issue` 段链接 FLY-959,test plan 列 R1-R4 + 单测数),然后按 Runner 基线规则走
  `stage set pr_created` → Codex code review → approve gate,不自 merge。

---

## Self-Review(writing-plans 检查表)

- **Spec 覆盖**:bug 1→Task 1/3/7;bug 2→Task 6/7;bug 3→Task 4;bug 4→Task 1/5;
  真机回归验收→Task 8;exploration §4 的"不做"清单未被任何 Task 越界 ✓
- **占位符扫描**:无 TBD/TODO;所有代码块完整可粘贴;唯一的"以现状为准"点
  (fakes 记录字段名、gemini-live.test helper 名)是对既有代码的引用而非留白 ✓
- **类型一致性**:`micDevice`/`onStderr`/`LiveToolDeclaration`/`tools`/
  `TalkSessionRotatorOptions` 在各 Task 间拼写一致;`start(onFrame, onError?)` 与
  Task 7 调用一致;rotator `close()` 语义与 cli shutdown 一致 ✓

## 风险与回滚

- 全部改动限 `packages/voice-core`(POC 包,无生产消费者)——回滚 = revert 单 PR。
- R2 若真机发现 goAway 窗口内 `close()` 取不到 handle(research R2):改用"最近一次
  resumption-update 的 handle 直接开新连接、旧连接 fire-and-forget close"——改动局部
  于 `TalkSessionRotator.rotate()` 与 `GeminiLiveSession`(需暴露 latestHandle 或在
  close 前读 handle),先按主路径实现,真机失败才启用。
- preview 模型再 404:Task 5 的指引 + `FLYWHEEL_VOICE_GEMINI_MODEL` 逃生口即自救路径。

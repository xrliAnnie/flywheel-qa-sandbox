# QA Report — FLY-1153: QA-6 smoke — /gemini-advanced full chain

**Issue**: FLY-1153 (QA-6 smoke — gemini-advanced full chain, safe to close)
https://linear.app/geoforge3d/issue/FLY-1153/qa-6-smoke-gemini-advanced-full-chain-safe-to-close
**Date**: 2026-08-04
**验证对象**: `/gemini-advanced` enablement 链(FLY-1018 voice phase)@ 基线 `85cfb355`(branch `project-slot-2-FLY-1153`,与 `main` 齐平)
**环境**: QA 沙箱 `flywheel-qa-sandbox` slot 2 · v1.55.0 · node v25.6.1 · pnpm 10.13.1 · vitest 3.2.4
**性质**: 本单为 **QA 沙箱冒烟**(issue 标注 safe to close)——目的是 (a) 端到端验证 /gemini-advanced enablement 链条的测试证据,(b) 让 Runner 走完 Flywheel 全 pipeline(onboard → brainstorm gate → implement → PR → CI → approve gate → ship)。**证据交付后即可关单。**

## Verdict: ✅ PASS

**链条针对性套件 77/77 PASS + gemini-agent 全套 171/171 PASS + voice-bridge 全套 672/673(唯一失败为与本链无关的既有并行时序 flake,单文件复跑 2×17/17 PASS)。零生产代码改动(report-only)。**

---

## 1. 被测链条 (Subject)

`/gemini-advanced` 是 voice-bridge 的 deep-dispatch 注入命令(FLY-1018 route A),enablement 链条:

1. **配置解析** — `packages/voice-bridge/src/assistant/config.ts`:`huddle.assistant.advanced` 存在才启用;`DEFAULT_ADVANCED_COMMAND = "gemini-advanced"`;absent = assistant 字节不变。
2. **启动 preflight** — `packages/voice-bridge/src/assistant/advanced.ts` `loadAdvancedAgentConfig()`:deep-agent env 不完整时 fail-fast 杀 deploy(绝不留到 founder 首次使用才炸);`packages/voice-bridge/src/cli.ts` daemon boot 路径共用同一 preflight。
3. **wiring 挂载** — `packages/voice-bridge/src/assistant/wiring.ts`:把 gemini-agent 的 `delegate_task` LiveToolSpec 挂到 **独立** `/gemini-advanced` 命令上;`/gemini` 本体保持 plain、永不携带 delegate(founder contract 2026-07-11)。
4. **命令引擎共享** — `packages/voice-bridge/src/assistant/GeminiCommand.ts`:`/gemini` 与 `/gemini-advanced` 共享 merged 引擎(FLY-1159 Codex R3)。
5. **deep loop + 完成通报** — `flywheel-gemini-agent` 的 delegate/loop/registry/audit(closed 6-tool registry,scoped Bridge token,零新增 authority surface),完成后 spoken 通报 + Discord-text fallback(`createDiscordCompletionSink`)。

## 2. 隔离 (Isolation) — 零生产接触

- 纯本地 vitest 测试套;**不触真 Discord、不触真 Gemini API、不起 Bridge**。
- 未触碰生产 `~/.flywheel` 状态;QA slot 2 沙箱 worktree 内完成全部操作。
- 零生产代码改动:本 PR 仅新增 `qa-fly1153/`(本报告 + progress ledger)。

## 3. 结果 (Results)

| # | 套件 | 覆盖点 | 结果 |
|---|------|--------|------|
| 1 | voice-bridge `assistant-advanced.test.ts` | preflight fail-fast / delegate tool 构建 / spoken 通报格式(含失败路径) | **18/18 PASS** |
| 2 | voice-bridge `assistant-wiring.test.ts` | delegate 只挂 `/gemini-advanced`、`/gemini` 保持 plain 的 wiring 合同 | **30/30 PASS** |
| 3 | voice-bridge `gemini-command-and-config.test.ts` | `huddle.assistant.advanced` 配置解析 + 命令引擎共享(FLY-1159) | **18/18 PASS** |
| 4 | voice-bridge `qa-fly1159-injection.test.ts` | /gemini 与 /gemini-advanced 共享面的注入对抗回归 | **11/11 PASS** |
| 5 | gemini-agent 全套(12 文件:config/bindings/registry/delegate/loop/session/daemon/audit/bridge-client/client/truncate/full-stack-integration) | deep loop 端:配置、6-tool closed registry、delegate 生命周期、审计、Bridge client、全栈集成 | **171/171 PASS** (5.0s) |
| 6 | voice-bridge 全套(60 文件,回归面) | 整包健康度 | **672/673**(59/60 文件 PASS,详见 §4) |

针对性链条合计(#1–4):**4 文件 / 77 tests 全 PASS**(8.6s)。

## 4. 诚实标注 — 既有失败(与本链无关,未修)

voice-bridge 全套并行跑时 `src/__tests__/brain-port.test.ts` 单测 1 例失败(`superseded while queued` 时序断言,brain 轮次 supersede 队列语义)。处置(按 Lead guardrail:如实记录、不顺手修生产代码):

- **与 /gemini-advanced 链无关** — brain-port 是 assistant brain HTTP port 的排队语义测试,不在 §1 链条的任何环节上。
- **本 PR 零代码改动** → 定义上即为既有(pre-existing)行为。
- **单文件隔离复跑 2 次均 17/17 PASS** → 属 60 文件并行负载下的时序 flake(环境性),非确定性回归。

## 5. 复现 (Repro)

```bash
pnpm install
pnpm --filter "flywheel-voice-bridge^..." build
# 链条针对性套件 (77 tests)
pnpm --filter flywheel-voice-bridge exec vitest run \
  src/__tests__/assistant-advanced.test.ts \
  src/__tests__/assistant-wiring.test.ts \
  src/__tests__/gemini-command-and-config.test.ts \
  src/__tests__/qa-fly1159-injection.test.ts
# deep-agent 端全套 (171 tests)
pnpm --filter flywheel-gemini-agent test:run
# 回归面全套 (673 tests; brain-port 并行 flake 见 §4)
pnpm --filter flywheel-voice-bridge test:run
```

## 6. Pipeline 全链证据 (本单的另一半目的)

| 阶段 | 证据 |
|------|------|
| onboard → brainstorm | `flywheel-comm stage set` 逐段上报 |
| BRAINSTORM GATE | blocking gate → Lead flywheel-test-3 **APPROVED**(4 条 guardrail:既有失败如实记录不顺手修 / feature 分支+PR 带 Linear 段 / CI green 后停 approve gate、只认 verify-approval / 报告注明沙箱冒烟性质)——本报告逐条落实 |
| implement | 本报告 + progress ledger(`qa-fly1153/FLY-1153-progress.md`) |
| PR / CI / approve / ship | 见 PR 本体(CI 探针 exit 0 后开 approve_to_ship gate,verify-approval 通过才 ship) |

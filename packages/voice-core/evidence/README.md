# FLY-543 voice-core — evidence & real-machine gap

Issue: FLY-543 · phase: implement · date: 2026-07-06
基于: engineering/doc/FLY-543-pluggable-voice-skill/plan.md（r2 双面架构）

本文件如实区分 **本 implement 阶段已用客观证据验证的部分** 与 **需要 Annie 真机 /
真 key 才能补的部分**（Lead 明确要求：建成「能跑」+ evidence 里标出哪些要真机）。

> FLY-2860（2026-09-25）：converse 面（POC `talk`、对话后端、会话续期、常驻脑）与其全部证据
> 已随三套旧语音命令一起退役，相关行已从本表删除，原件见 git 历史。下文只保留 announce 面。

## ✅ 已验证（CI 可复现，无需真机）

| 验收 | 证据 | 命令 |
|------|------|------|
| A1 vitest 全绿 | 测试文件全过 | `pnpm --filter flywheel-voice-core test` |
| A1 typecheck 干净 | tsc 0 error | `pnpm --filter flywheel-voice-core typecheck` |
| A1 lint 干净 | biome 0 error | `npx @biomejs/biome check packages/voice-core/src` |
| A5 可插拔实证 | registry 按 id 解析、capability/factory 一致性 fail-fast、edge-tts announce 可建 | `registry.test.ts` / `cli-factory.test.ts` |
| A6 失败路径显式 | component-missing / subprocess-failed / timeout / cancelled 全有单测 | `config.test.ts` / `edge-tts.test.ts` / `headless-brain.test.ts` |
| A7 argv 卫生 | edge-tts 文本走 0600 `--file`；brain prompt 走 stdin；`say` 文本只经 --stdin/--file（无位置参数）；mock argv 断言无文本 | `edge-tts.test.ts` / `headless-brain.test.ts` / `cli-factory.test.ts` |
| A8 取消合同（announce） | mid-speak interrupt 杀播放+清队列+queued 全 reject cancelled | `announcer.test.ts` |
| brain S0.1 参数 | 零工具=`--tools "" --strict-mcp-config`（每轮重传）、persona=`--append-system-prompt-file`（resume 轮不重传）、stream-json+partial 只取 text_delta、session_id 捕获→`--resume` | `headless-brain.test.ts` |
| 真子进程 seam | 真 `node` 子进程验 stdin 管道 / timeout kill / abort kill / spawn 流式 | `process.test.ts` |

## ✅ 补测（QA round 3 后）

| 验收 | 证据 | 命令/文件 |
|------|------|-----------|
| A2 POC-A 播报闭环（真机播报 + 三指标 + mp3 样本） | 两条独立真机路径（CLI 全链路 + 直调核心引擎）产出可 ffprobe/afplay 核验的真实 mp3 | `poc-announce.md` |

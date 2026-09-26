# FLY-2886 语音·B·核心·大脑 — Step 0 协议实测
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886/语音b核心大脑-codex-自带后台-agent订阅与-lead-同权-记忆与上下文三层装载-口语转述关键字段一字不差-等待话术-20)
日期: 2026-09-25
基于: plan.md

## 结论

Step 0 找到一个必须先改计划的上游事实，因此按 `plan.md` §8 的停线条件，没有继续 C1/C2 生产实现：

- Codex app-server V2 realtime 能在同一临时 home 下以 `account.type=chatgpt`、`planType=pro` 启动；
- 但 `thread/realtime/appendText({role:"developer"})` 的 RPC 会先返回成功，约 146ms 后异步发出 `thread/realtime/error`：`Developer messages are not supported for realtime sessions.`，随后关闭 realtime；
- 因而计划 §5.3 的「会话中新事件用 `appendText(developer)` 静默追加」在当前协议上不可实现，不能进入生产代码；
- 独立 voice-scribe 场通过：订阅登录、有效配置中 12 个工具相关 feature 全关、MCP server 数为 0、普通结构化 turn 完成，过程中没有 command/MCP/web item。

已注册 Lead question gate `a510a57d-bcab-4ea2-988f-eaf6db2fcf37`，等待批准新的第 3 层注入合同。

## 环境与边界

- 仓库 HEAD：`b6046d2c434914bd71f37a77223248a99d39aac3`（探针开始时）。
- Codex：`codex-cli 0.157.0`；binary SHA-256 `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`。
- 每场临时 home 都只软链宿主 `auth.json`，不 login/logout；scribe 子进程不带 `OPENAI_API_KEY` / `CODEX_API_KEY`。
- app-server 实际 thread receipt 仍是 `sandbox.type=readOnly`、`networkAccess=false`。探针请求侧写 `danger-full-access` 只用于避开 Runner 内再套 Seatbelt，宿主 requirements 最终把无工具场收紧为 read-only；生产档没有改动。
- brain 场为了避开当前 Resident Runner 不允许嵌套 `sandbox-exec` 的环境限制，关闭工具，只测 auth/realtime/event 协议。带 shell 的同版本成功基线已在 `engineering/doc/FLY-2881-voice-design-review/evidence-exp/log-2.jsonl` 证明：ChatGPT Pro 后台 turn、`commandExecution`、`turn/completed` 与结果回送均成立。

## 证据文件

| 文件 | 结果 | 关键行 |
|---|---|---|
| `step0-brain.jsonl` | **STOP** | `account/read` 是 ChatGPT Pro；V2 `started`；developer append 后精确 error + closed |
| `step0-scribe.jsonl` | **PASS** | ChatGPT Pro；工具 feature 全 false；MCP=0；turn completed；`forbiddenItemTypes=[]` |
| `step0-probe.mjs` | 台架 | 两场各有 110s 硬停；日志去敏；临时 home/work 结束即删 |
| `../../FLY-2881-voice-design-review/evidence-exp/log-2.jsonl` | 已有同版本基线 | API realtime + ChatGPT 后台、真实 shell read、终态自动回送 |

## 未继续的项目

因为 developer-role 假设已被反证，以下项目没有用猜测替代证据：realtime stop/start 中后台完成、活动回合连续第二/第三个 handoff 顺序、确认语 10 次遵从率。Lead 批准替代注入合同后，应在新计划边界下重跑这些项；voice-scribe 不需重跑。

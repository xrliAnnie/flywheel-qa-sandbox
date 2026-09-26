# FLY-2886 语音·B·核心·大脑 — Step 0 协议实测
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886/语音b核心大脑-codex-自带后台-agent订阅与-lead-同权-记忆与上下文三层装载-口语转述关键字段一字不差-等待话术-20)
日期: 2026-09-25
基于: plan.md

## 结论

Step 0 找到一个必须先改计划的上游事实，因此按 `plan.md` §8 的停线条件暂停 C1/C2；Lead 随后裁定做有界 A/B/C 实验，结果已写入 `plan.md` v6：

- Codex app-server V2 realtime 能在同一临时 home 下以 `account.type=chatgpt`、`planType=pro` 启动；
- 但 `thread/realtime/appendText({role:"developer"})` 的 RPC 会先返回成功，约 146ms 后异步发出 `thread/realtime/error`：`Developer messages are not supported for realtime sessions.`，随后关闭 realtime；
- 因而计划 v5 §5.3 的「会话中新事件用 `appendText(developer)` 静默追加」在当前协议上不可实现；
- Codex 0.157.0 生成的 app-server TypeScript 协议只有 `thread/realtime/start|stop|appendAudio|appendText|appendSpeech|listVoices`；`thread/settings/update` 与 `turn/settings/update` 没有 instructions/prompt 字段，所以候选 C 不存在；
- 候选 A（user-role 静默旁注）5/5 通过 scoped 判据；候选 B（重开 realtime leg 刷 prompt）3/3 丢失上一 leg 的口令，不能保留对话连续性；故 v6 选择 A，并把「最近背景环随自然重开加载」保留为回退；
- 独立 voice-scribe 场通过：订阅登录、有效配置中 12 个工具相关 feature 全关、MCP server 数为 0、普通结构化 turn 完成，过程中没有 command/MCP/web item。

Lead question gate `a510a57d-bcab-4ea2-988f-eaf6db2fcf37` 已裁定先做上述有界实验；v6 §5.3 等待 scoped design review，复审通过前不做其依赖生产代码。

## 环境与边界

- 仓库 HEAD：`b6046d2c434914bd71f37a77223248a99d39aac3`（探针开始时）。
- Codex：`codex-cli 0.157.0`；binary SHA-256 `ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`。
- 每场临时 home 都只软链宿主 `auth.json`，不 login/logout；scribe 子进程不带 `OPENAI_API_KEY` / `CODEX_API_KEY`。
- app-server 实际 thread receipt 仍是 `sandbox.type=readOnly`、`networkAccess=false`。探针请求侧写 `danger-full-access` 只用于避开 Runner 内再套 Seatbelt，宿主 requirements 最终把无工具场收紧为 read-only；生产档没有改动。
- brain 场为了避开当前 Resident Runner 不允许嵌套 `sandbox-exec` 的环境限制，关闭工具，只测 auth/realtime/event 协议。带 shell 的同版本成功基线已在 `engineering/doc/FLY-2881-voice-design-review/evidence-exp/log-2.jsonl` 证明：ChatGPT Pro 后台 turn、`commandExecution`、`turn/completed` 与结果回送均成立。
- A/B 每次使用独立临时 home/work、无工具、thread receipt 为 read-only；没有切换账号。A 按 Lead 后续收窄回复补到 N=5，观察窗均为 4 秒。B 的 N=3 是该回复到达前按原裁定完成，未再追加；「停止前 500ms 无输出音频事件」只是隔离协议代理，台架没有 Discord 输出链和 founder 耳朵，不能证明真人听不到切口。

## A/B/C 结果

| 候选 | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | 结论 |
|---|---|---|---|---|---|---|
| A `appendText(user, [旁注,勿回应])` | PASS：无 unsolicited；只答 `4` | PASS：无 unsolicited；只答 `4` | PASS：无 unsolicited；只答 `4` | PASS：无 unsolicited；只答 `4` | PASS：无 unsolicited；只答 `4` | 5/5 scoped pass |
| B stop/start prompt refresh | 548ms；旧口令 `未知` | 647ms；旧口令误答 `真正用户问题` | 602ms；旧口令 `未知` | 未运行 | 未运行 | 0/3 continuity；新 prompt 的 `1326` 三次均出现，但模型把 `PR #1326` 改写成 `PR号：1326` |
| C live instructions/session update | 无接口 | 无接口 | 无接口 | 无接口 | 无接口 | 不运行 |

A 的 PASS 判据固定为：旁注后 4 秒内没有 assistant transcript/audio、handoff 或 realtime error；接着问 `2+2`，回答包含 `4` 且不泄露旁注里的 `FLY-2886-CONTEXT-N`、`PR #1326`、`Tadashi`、runner id。B 的 FAIL 不因新 prompt 已生效而改判：跨 leg 旧口令连续性是必需条件，三次均失败。日志中的 `refreshedPromptApplied=false` 是探针要求逐字出现 `PR #1326` 的严格字段；原始回答显示语义进入但被格式化，不能据此声称关键字段格式保真。

## 证据文件

| 文件 | 结果 | 关键行 |
|---|---|---|
| `step0-brain.jsonl` | **STOP** | `account/read` 是 ChatGPT Pro；V2 `started`；developer append 后精确 error + closed |
| `step0-scribe.jsonl` | **PASS** | ChatGPT Pro；工具 feature 全 false；MCP=0；turn completed；`forbiddenItemTypes=[]` |
| `step0-user-context-{1,2,3,4,5}.jsonl` | **PASS 5/5** | 4 秒无 unsolicited signal；后续只答 4；无旁注泄漏 |
| `step0-restart-context-{1,2,3}.jsonl` | **FAIL 3/3 continuity** | ready 548/647/602ms；上一 leg `ORBIT-N` 均未保留；新 prompt 的 1326 均出现 |
| `step0-probe.mjs` | 台架 | 每场 110s 硬停；日志去敏；临时 home/work 结束即删；A 最多 5 次、B 最多 3 次 |
| `../../FLY-2881-voice-design-review/evidence-exp/log-2.jsonl` | 已有同版本基线 | API realtime + ChatGPT 后台、真实 shell read、终态自动回送 |

## 未继续的项目

这轮只回答 §5.3 注入合同，不扩大成整套协议验收。以下项目仍没有用猜测替代证据：realtime stop/start 中后台完成、活动回合连续第二/第三个 handoff 顺序、确认语 10 次遵从率；它们在对应实现步骤和 QA 真房按 `plan.md` 的边界验证。A 的隔离台架 5/5 也不替代 QA N≥5 真人语义抽样；voice-scribe 不需重跑。

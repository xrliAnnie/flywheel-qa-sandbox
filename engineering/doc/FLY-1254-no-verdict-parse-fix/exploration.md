# FLY-1254 跨厂商审查 no_verdict 查因 + 修 — 探索

Issue: FLY-1254 (https://linear.app/geoforge3d/issue/FLY-1254/fix-跨厂商审查-no-verdict-查因-修审稿人跑完但结论解析不出)
日期: 2026-07-14
基于: 无

## 1. 问题定义

FLY-1225 round-2 实撞:cross-family 审查 lane(FLY-1188 §7.1/7.2,codex 作者 → Claude 审稿)里,Claude 审稿人跑完一整轮 review,但 `parseClaudeReviewOutput` 返回 null → job 以 `no_verdict` fail-close,一轮审查作废,runner 卡在关闭的 gate 上,最终靠整个 session 重派才恢复。

Issue 要求三件交付(一张单,不拆散):
1. no_verdict 查因(真机取证,勿猜)+ 修
2. Claude 审稿会话 resume 化(对齐 Codex companion + resume 多轮模式)
3. 每轮 30 分钟上限重审(与 FLY-1253 land 等待语义区分)

## 2. 真机取证(核心证据链)

全部证据来自生产数据,无推测成分。细节与命令输出见同文件夹 `research.md`。

### 2.1 事故 job 行(`~/.flywheel/teamlead.db` · `codex_review_job`)

| requestId | issue | round | status | failure_reason | reviewer_session_uuid | 时间(UTC) |
|---|---|---|---|---|---|---|
| `6a55414c` | FLY-1225 | 1 | failed | `gate_answered_externally` | `a4c3f2b5-…` | 16:05 建,16:11 终 |
| `5650646f` | FLY-1225 | 2 | failed | **`no_verdict`** | `a4c3f2b5-…`(同一个!) | 16:07 建,16:12:49 终 |

两轮共用同一个 reviewer session uuid —— **跨轮 resume 已经在工作**。

### 2.2 审稿人 transcript(`~/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-1225/a4c3f2b5-….jsonl`)

R2 的最终 assistant 消息**末尾带着一条格式完全合法的 verdict JSON**:

```
…(约 1400 字 prose 总结,其中含内联片段 `{p,m}` → `{p,fc,m}` 和 `{s,c}`)…

{"verdict": "APPROVED", "findings": [], "reviewedHeadSha": "5f4c1165055fe901c43965af2109ec0df5b05635"}
```

审稿人**没有失约**——verdict 在、格式对、head sha 回显正确。它违反的只是"No prose outside the JSON"这一条(R1 同样违反了,但 R1 能解析成功)。

### 2.3 确定性重放(生产解析器逐字重放)

用 `packages/teamlead/src/bridge/claude-review-runner.ts` 的真实 `parseClaudeReviewOutput`,对 transcript 里的 R1/R2 原文(包成 success 信封)重放:

```
R1: parsed=APPROVED          ← 对照组,prose 不含大括号
R2: parsed=NULL (no_verdict) ← 事故复现
R2 first-brace context: "{p,m}` → `{p,fc,m}`) — causes a harmless one-time re-enqueue"
```

## 3. 根因结论

**解析太脆(fail-closed 无宽容回落),不是坏格式。**

`extractJsonObject()`(claude-review-runner.ts:277-284)的提取策略是"文本里**第一个** `{` 到**最后一个** `}` 的切片"。R2 prose 里技术性提到指纹形状 `{p,m}`/`{p,fc,m}`/`{s,c}`,第一个 `{` 落在 prose 上,切片横跨 prose + verdict JSON,必然不是合法 JSON → `JSON.parse` 抛 → 返 null → `no_verdict`。

这是**确定性**炸弹,不是概率事件:任何一轮 review 的 prose 里只要出现一个大括号(讨论对象形状、代码片段、正则……在代码审查场景极常见),该轮 verdict 必然作废。同族隐患:fence 分支取的是**第一个** fence——若 prose 先引用了一段 fenced 代码,同样抓错目标。年轻的 lane(FLY-1188 上线至今 8 个 job)已经 1/5 真实审稿轮命中。

## 4. 修法选项

| 选项 | 内容 | 评估 |
|---|---|---|
| **A. verdict 锚定的宽容提取(推荐)** | string-aware 平衡大括号扫描,收集候选 JSON 对象,取**最后一个**含合法 verdict 字段者;信封严校验(R12-R14)与 fail-close 语义不变 | 确定性修复本事故;对现有通过样本字节兼容;真没 verdict 时仍 fail-close |
| B. prompt 硬化(structured output 约束) | 加强"最终消息只许 JSON"或要求 fence 包裹 | 模型两轮都违反了同款指令,不可依赖;fence-first 提取本身也有抓错 fence 的同族 bug。可作辅助措辞,不作主修 |
| C. CLI 层结构化输出 | claude CLI `-p` 无 JSON-schema 约束最终输出的能力(`--output-format json` 只是信封) | 能力不存在,排除 |

**选 A(主修)+ B(辅助措辞,一行)。**

安全性论证:APPROVED 的硬绑定不在解析层——coordinator 仍要求 `reviewedHeadSha` 逐字等于 server 端冻结的 head(R12 HIGH-6),错误信封仍在解析前被拒(R12-R14 不动)。"取最后一个"符合"最终答案"语义,且 contract 原文里的示例 JSON(含 `"APPROVED" | "CHANGES_REQUESTED"` 非法 JSON)天然解析不出来,不会被误取。

## 5. 交付 2 前提修正(经 Lead brainstorm gate 确认)

Issue 原文"现状每轮新起 headless 会话、每轮重读 PR 上下文"**与证据不符**:FLY-1188 已实现跨轮 resume(coordinator 持久化 `reviewer_session_uuid`,round≥2 用 `--resume`),事故当轮就在用——R2 与 R1 同 session、仅 80 秒完成(R1 约 6 分钟)、并明确记得"commit 与 round 1 逐字节相同"。Lead(Tadashi)已确认此前提修正,scope 改为修三个**真差距**:

1. **失败轮丢 findings → reround prompt 注入误导性空数组**:`buildPrompt` 从 `latestDoneCodexReviewJob`(只查 done)注入 prior findings;失败轮(含本事故 R1)不存 findings → R2 prompt 写"Your previous findings were: []"。resume 轮本就靠会话记忆,改为不注入。
2. **观测缺口**:spawner 对 stderr 是 `ignore`;`no_verdict`/`nonzero_exit` 的 raw 只在内存 outcome 里,不落库不进告警——本次取证只能翻 `~/.claude` transcript。补 stderr 捕获 + 失败时 raw/stderr 尾部落库。
3. **resume session 丢失 = 永久失败循环**:同 requestId 重试仍用同 uuid → 永远撞 "No conversation found with session ID"(已真机实测:exit 1、stderr 带该文案、秒败)。补 pattern-gated 一次性 fresh-session 回落。quota 类 nonzero_exit(见 §7)不回落,照旧 fail-close。

## 6. 交付 3:30 分钟上限重审

实测数据(xhigh / claude-opus-4-8,本仓):fresh 轮 6-10 分钟,resume 轮约 80 秒。30 分钟有 3-5 倍余量。

结论:**保留 30 分钟默认**。它的语义是"对一个活跃工作中的审稿子进程的 liveness bound"(防 CLI 挂死),与 FLY-1253/defect#7 的 flywheel-land"等外部事件被 30 分钟通用默认杀掉"是两回事——那是等待语义误用超时,这是子进程活性守卫,语义正确。补两件小事:把现有 `reviewerTimeoutMs` seam 接上 env 覆盖(现在 plugin 构造时什么都没传),文档写明两种语义的区别。

## 7. 相邻发现(不入本单 scope)

- FLY-1244/FLY-1251 三次 `nonzero_exit`(其中两次 3 秒即败)= **claude quota 限额**:transcript 实证"You've hit your session limit / weekly limit"。fail-close 行为正确;本单的 stderr/raw 落库会让这类失败以后一眼可辨,但 quota 治理本身不在 scope。
- coordinator 的 `alertLead` 未接线(告警只进 Bridge console)——plugin.ts 已标注为 FLY-927 alert funnel follow-up,维持原 follow-up 路径,不在本单动。

## 8. Lead 确认记录

BRAINSTORM GATE(2026-07-14,Tadashi/flywheel-eng-lead):两点全确认 APPROVED——①前提修正认可("issue 里『每轮新起会话』是我写错的前提,以你的证据为准"),scope 改为修三个真差距;②修法方向 OK;③30min 保留默认 + 接线 env,文档划清与 1253 的语义边界。

# FLY-3083 Lead→Runner 消息只走 Mailbox — 探索

Issue: FLY-3083 (https://linear.app/geoforge3d/issue/FLY-3083/规矩机制leadrunner-消息-所有-lead-的共用规矩还在教日常聊天用-sendmessage5-月-fly-142-的旧版和-7)
日期: 2026-09-29
基于: 无

## 1. 问题定义

founder 2026-09-29 在 FLY-3078 thread 指出:Lead→Runner 的消息现在有**两套 source of truth**。

- **机制**说:走 Flywheel 的 Mailbox(`flywheel-comm send` / `respond`)。每封信有编号、有送达记录、丢了看得见。
- **规矩**(`packages/teamlead/lead-rules-base/runner-messaging-rules.md`,所有部门 Lead 共用)说:日常聊天用 Claude Code 自带的 `SendMessage` 工具。这是 5 月 FLY-142 时代的写法,7 月 Mailbox 升级后没有更新。

后果(Honey Lemon 9-29 实测):用 `SendMessage` 发给 Runner 的十几条,CommDB `mailbox` 里一条都没有——没编号、不留底、发丢了没人知道;同一天走 `flywheel-comm send`/`respond` 的 249 条全有记录。

founder 的两个问题:
1. 我们还需要这条规矩吗?
2. 还是机制本来就能兜住,规矩里一句都不用写?

## 2. 现状审计(本沙箱代码,一手核实)

> 本沙箱快照是 v1.55.0,**没有** FLY-1547 的 v2 Mailbox 服务。这里的「Mailbox」= `flywheel-comm send` 写 CommDB `messages` 表(编号 = instruction id,`delivered_at` = 送达记录)+ 唤醒 Runner 的 Agent Team 收件箱文件。**设计对象是「`flywheel-comm send`/`respond` 是唯一 Lead 侧入口」这个不变量**,它在 v1 与 v2 Mailbox 下都成立;Mailbox→Runner 的最后一段怎么投(含 FLY-2127 的 Codex 原生 RPC)不在本单范围。

### 2.1 三处各说各话

| 位置 | 现在说什么 | 与机制的冲突 |
|---|---|---|
| `packages/teamlead/lead-rules-base/runner-messaging-rules.md` §1「Ordinary chat → `SendMessage`」+ 决策表 5 行中 4 行推荐 `SendMessage` + 「Sentinel safety net」段末「switch to `SendMessage` and try again」 | 日常消息用 `SendMessage` | `SendMessage` 只写 Agent Team 收件箱文件,**不写 CommDB**:无编号、无 `delivered_at`、不被 FLY-208 的 `[lead-instruction <id>]` 幂等协议覆盖 |
| `packages/teamlead/scripts/claude-lead.sh:1821-1830` 注释 | 「dept leads … MUST be told to use `SendMessage` MCP for ordinary DM … rather than `flywheel-comm send`(suppressed by sentinel …)」 | 这段注释描述的是 FLY-142 PR 1.4 时的过渡状态;FLY-168 之后 `send` 已经双写(CommDB + 收件箱),「被 sentinel 压掉」早已不成立 |
| `packages/teamlead/src/bridge/hook-payload.ts:335` | 「Reply to the Runner via `flywheel-comm send` (NOT SendMessage)」 | 这一处和机制一致——它是三处里唯一说对的 |

连带受影响的共用规矩(都把 `SendMessage` 当「正常 Runner 消息路径」):

- `stuck-runner-remanage.md:40`:「via your normal Runner messaging path (`SendMessage` — see runner-messaging rules)」
- `runner-reengage-rules.md:25`:「(`SendMessage` / `flywheel-comm send`)」
- `runner-patrol-rules.md:93`:「mailbox mode (prod default): `SendMessage` (MCP teammate API) or `flywheel-comm send`」

这些文件**同时**注入 Claude Lead(`claude-lead.sh` `--append-system-prompt-file`)和 Codex full-access Lead(`lead-rules-bundle.sh` → `baseInstructions`),所以 Tadashi、Aunt Cass、Mufasa 和其他项目 Lead 读到的是同一份。

### 2.2 机制现状:什么都没拦

- `SendMessage` 是 Claude Code 内建工具,`tool_input = {to, message, summary?}`(本机工具 schema 核实,`to` 必填)。Lead 的团队里每个 Runner 以 `runner-<execId 前 8 位>` 为名注册(`deriveRunnerMailboxIdentity`,`packages/agent-team-transport/src/path-helpers.ts:163`),所以 `SendMessage to:"runner-xxxxxxxx"` 直接写 `<CLAUDE_CONFIG_DIR>/teams/<leadId>/inboxes/runner-xxxxxxxx.json`,Runner 的 poller 照常读到——**消息能到,只是 Flywheel 不知道**。
- 现有的两个 Lead 侧 hook 都不管这件事:`flywheel-restart-guard.py`(PreToolUse, matcher Bash, FLY-913)和 `discord-reply-enforcer.py`(Stop)。
- Bridge 侧的 misroute patrol(`gate-poller.ts:1186`)只扫 `team-lead.json` 这个黑洞收件箱(Runner→Lead 方向,FLY-208),不看 Lead→Runner。

### 2.3 `flywheel-comm send` 已经是完整的 Mailbox 入口

`packages/flywheel-comm/src/commands/send.ts`:
1. `insertInstruction` 写 CommDB(编号 = 返回的 id,留底)。
2. `clearDeclaredState` 清 park 标记(FLY-626)。
3. 按目标 Runner 的 `sessions.vendor` 选传输(claude-code / codex / none),`wakeRunnerMailbox` 写收件箱,内容带 `[lead-instruction <id>]` 前缀(FLY-208 幂等)。
4. 唤醒成功 → `markInstructionDelivered`(`delivered_at`);失败 → **只在 stderr 打 WARN/ERROR**,stdout 仍只打 id,exit 0。

第 4 点就是 Tadashi 派单补充里「Mailbox 自己卡住时 Lead 怎么发现」的现状:能发现,但只靠 Lead 去看 stderr。

### 2.4 为什么 9-29 Lead 会改用 SendMessage

FLY-3071(cos-lead inbox tick 抛错拖垮投递通道)让 `send` 的行长期 QUEUED,Lead 拿 `SendMessage`(Claude Runner)/ `codex queue --remote`(Codex Runner)当旁路。旁路能到但不留底,正是 founder 反对的「两套真相」。设计要回答:只走 Mailbox 之后,通道卡住时 Lead 怎么发现、怎么兜底——**不能靠改走旁路**。

### 2.5 Codex Lead 的入口

Codex Lead 没有 `SendMessage` 工具;它给 Runner 发消息只能走 Bash → `flywheel-comm send`/`respond`,所以「一条路」对它天然成立。它的旁路是 `codex queue --remote`(直接 steer Codex Runner),这属于 Mailbox→Runner 最后一段,FLY-2127 在改,本单不重复。Codex CLI 0.159 已有 hooks 机制(`--dangerously-bypass-hook-trust` 可见),将来若要拦 `codex queue` 可做,记为 follow-up。

## 3. 回答 founder 的两个问题

**Q1 还需要这条规矩吗?** 需要,但只剩一句:「给 Runner 发消息用 `flywheel-comm send`(普通消息)/ `respond`(答 gate)」。理由:Lead 是 LLM,工具菜单里 `SendMessage` 永远在(内建工具删不掉),一句正向指引能省掉每次被拦再改的一个回合。规矩里所有教「用 SendMessage 发给 Runner」的段落删掉。

**Q2 机制能不能全兜住?** 能兜住「不留底」这个后果:加一个 Lead 侧 PreToolUse hook,`SendMessage` 的 `to` 是 Runner 名字就当场拦下、把正确的 `flywheel-comm send` 命令喂回给 Lead。拦住之后规矩只是「省一个回合」的提示,不再是正确性的依赖。

## 4. 方案空间

### 4.1 拦截点

| 方案 | 说明 | 判定 |
|---|---|---|
| **A. Lead 侧 PreToolUse hook(matcher `SendMessage`)** | `to` 匹配 `^runner-[0-9a-f]{8}$` → deny,`permissionDecisionReason` 里给出可直接复制的 `flywheel-comm send --to <exec-id> …` 命令;其他 `to` 放行 | **采纳**。物理拦截,零 Bridge 改动,和 FLY-913 restart-guard 同一套安装/测试模式 |
| B. Bridge 侧巡检 Lead→Runner 收件箱文件,发现无 CommDB 编号的条目就补录 | 像 FLY-208 misroute patrol 的镜像 | 拒。事后补录不是「一条路」,而是把第二条路合法化;还要分辨 `send` 写的和 `SendMessage` 写的(靠 `[lead-instruction` 前缀,脆) |
| C. 只改规矩,不加机制 | 最省 | 拒。founder 明确要「优先让机制兜住」;9-29 的事故证明规矩挡不住临时兜底的冲动 |
| D. 去掉 Runner 在 Lead 团队里的成员注册,让 `SendMessage to:"runner-*"` 根本发不到 | 釜底抽薪 | 拒。`send` 自己的唤醒写的就是这个收件箱(`wakeRunnerMailbox`),Runner 的 poller 也靠成员身份;拆了等于拆 Mailbox v1 的传输层 |

### 4.2 拦下之后:deny-only 还是自动转写进 Mailbox?

| 方案 | 说明 | 判定 |
|---|---|---|
| **deny-only + 给出替代命令** | hook 不产生副作用;Lead 下一回合自己跑 `flywheel-comm send`,stdout 拿到 id | **采纳**(默认) |
| 自动转写:hook 里 shell out `flywheel-comm send` 再 deny | 省一个回合 | 拒(记为可选 follow-up)。① Lead transcript 里显示「被拒」但消息其实发出去了,审计混淆;LLM 重试一次就重复投递(新 id,幂等协议不覆盖);② hook 里带副作用的外部调用(node 启动 + SQLite 写)遇到超时/失败要再设计一套记账;③ Codex Lead 没有这条路,做了也不对称 |
| `updatedInput` 改写 `to` | — | 不适用:问题不在收件人,在传输工具本身;PreToolUse 不能换工具 |

### 4.3 通道卡住时怎么发现、怎么兜底(Tadashi 补充)

- **发现**:`flywheel-comm send --json` 增加 `delivered`/`wake_error`/`skipped_reason` 字段;非 JSON 模式 stdout 仍只打 id(字节兼容),stderr 的 WARN 保留。Lead 规矩写明:`delivered:false` 或 stderr 有 WARN = 通道问题,不是消息问题。
- **兜底**:CommDB 行已经写了(留底不丢),Lead 的动作是 ① 报 infra(`lead-alert.sh`/Discord alerts,FLY-3071 这类)② 走 `stuck-runner-remanage.md` 的 re-manage 阶梯(terminal 直读 / restart),**不是**换 `SendMessage`。hook 的 deny reason 里同样写这句。
- 真正的 QUEUED 状态可见性(v2 Mailbox 的 mailbox id 状态查询)属于 FLY-1547/FLY-3071 的范围,本沙箱没有 v2;设计只保证 `send` 的即时返回不再吞掉失败。

### 4.4 安装范围:全局 `~/.claude/settings.json` 还是 Lead 工作区 `settings.local.json`

- 全局(FLY-913 模式):一个安装脚本 + Lead 启动收敛 + 现成的 jq-merge 测试矩阵;也覆盖 founder 自己的 Claude 会话和 Runner 会话——它们本来就不该 `SendMessage to:"runner-*"`(全仓 grep:Runner 提示词里只有「不要 `SendMessage to:"team-lead"`」,没有任何 Runner→Runner 用法)。
- 局部:范围更紧,但要新造一套 settings.local.json 的 hook 合并逻辑(现有 lock 只写一个布尔键)。
- **采纳全局**,理由是「一条路」是全机不变量,和 restart-guard 同理;附 env 开关 `FLYWHEEL_RUNNER_MSG_GUARD=0`(发送方进程 env)作 QA/回滚旁路。

## 5. 边界

- 不动 Runner→Lead 方向(FLY-208 已有 team-lead 黑洞巡检)。
- 不动 Mailbox→Runner 最后一段(FLY-2127)。
- 不动 `respond` 的 gate 语义与 wake 矩阵。
- 不做「自动转写」。
- 不拦 Codex Lead 的 `codex queue --remote`(follow-up)。

## 6. 下一步

research.md:核实 hook 协议细节、`send` 输出契约、规矩文件的完整改写清单、测试接线;plan.md:分块实施计划。

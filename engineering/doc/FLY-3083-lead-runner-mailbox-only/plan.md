# FLY-3083 Lead→Runner 消息只走 Mailbox — 实施计划

Issue: FLY-3083 (https://linear.app/geoforge3d/issue/FLY-3083/规矩机制leadrunner-消息-所有-lead-的共用规矩还在教日常聊天用-sendmessage5-月-fly-142-的旧版和-7)
日期: 2026-09-29
基于: exploration.md, research.md

## 0. 一句话

给 Lead 装一个 PreToolUse hook:`SendMessage` 的收件人是 Runner(`runner-xxxxxxxx`)就当场拦下,把正确的 `flywheel-comm send` 命令喂回去;规矩、启动脚本注释、hook 提示三处统一成「给 Runner 发消息只有 `flywheel-comm send`/`respond` 一条路」;`send` 不再吞掉投递失败。

## 1. 目标与非目标

**目标(对应 issue「要的效果」1-4)**
1. Lead 侧入口唯一:`flywheel-comm send`(普通消息)/ `respond`(gate 答复)。Claude Lead 与 Codex Lead 同一份规矩。
2. 机制兜住:`SendMessage to:"runner-*"` 被 hook 硬拦(deny + 替代命令);规矩只剩一句正向指引。
3. `runner-messaging-rules.md`、`claude-lead.sh` 注释、`hook-payload.ts` 提示三处一致。
4. 回归测试:喂一条 `SendMessage to:"runner-…"`,断言被拦下且 reason 含可执行的 `flywheel-comm send` 命令。

**非目标**
- Runner→Lead 方向(FLY-208 已覆盖)。
- Mailbox→Runner 最后一段投递(FLY-2127 / FLY-1547 / FLY-3071)。
- 自动转写(hook 代发)——见 §6 拒绝理由。
- Codex Lead 的 `codex queue --remote` 旁路拦截——follow-up。
- 不改 `respond` 语义、不改 wake 矩阵内容。

## 2. 架构

```mermaid
flowchart LR
  L[Lead LLM] -->|SendMessage to runner-xxxxxxxx| H{PreToolUse hook<br/>flywheel-runner-msg-guard.py}
  H -->|to 匹配 ^runner-[0-9a-f]{8}$| D[deny + reason:<br/>flywheel-comm send --to runner-xxxxxxxx …]
  H -->|其他收件人 / 非 SendMessage / stdin 坏| A[放行 exit 0]
  D --> L
  L -->|Bash: flywheel-comm send| S[send.ts]
  S -->|1 insertInstruction| DB[(CommDB messages<br/>id + delivered_at)]
  S -->|2 wakeRunnerMailbox 按 vendor| MB[Runner 收件箱 / Codex 邮箱]
  S -->|3 stdout id / --json delivered| L
```

单一真相:`deriveRunnerMailboxIdentity` 决定 Runner 名字形状;`send` 是唯一写 Mailbox 的入口;规矩文本只有一份并同时注入 Claude / Codex Lead。

## 3. 分块实施(每块可独立提交、独立回滚)

### Chunk 1 — `flywheel-comm send`:短名解析 + 投递结果外露(`packages/flywheel-comm`)

**CommDB(`db.ts`)** 新增:
```ts
/** FLY-3083: resolve a Runner mailbox short name ("runner-<8hex>") or an execId
 *  prefix to the full execution_id. Fail-closed: 0 or >1 matches → throws. */
resolveExecutionId(ref: string, opts?: { leadId?: string }): string
```
- 全长 UUID(36 位)→ 原样返回(不查库,字节兼容)。
- `runner-<8hex>` 或裸 8-hex 前缀 → `SELECT execution_id FROM sessions WHERE execution_id LIKE ? || '%'`(参数化,前缀先校验 `^[0-9a-f]{8}$`,防 `%`/`_` 注入);有 `leadId` 时加 `AND lead_id = ?`。
- 0 命中 → `Error("no session for runner ref …")`;>1 → `Error("ambiguous runner ref … (N sessions)")`。

**`send.ts`**:
- `toAgent` 先经 `db.resolveExecutionId(args.toAgent, { leadId: args.fromAgent })`;解析失败直接抛(CommDB 不写任何行——没有确定收件人不留底)。
- 返回类型改为 `SendResult`:
  ```ts
  export interface SendResult {
    instructionId: string;
    executionId: string;         // 解析后的全长 id
    delivered: boolean;          // wake.ok
    skippedReason?: "backend_commdb" | "no_session_lead" | "no_transport";
    wakeError?: string;
  }
  ```
  `vendor === "none"` → `delivered:false, skippedReason:"no_transport"`(现有 loud stderr 保留)。
- **stderr 行为不变**(现有 warn/error 原文保留)。

**`index.ts:runSend`**:
- 非 `--json`:stdout 仍只打 `instructionId`(字节兼容);
- `--json`:`{"instruction_id", "execution_id", "delivered", "skipped_reason"?, "wake_error"?}`。
- 解析错误 → 现有顶层错误路径(非零退出 + stderr)。

**测试(`src/__tests__/send-mailbox.test.ts` 扩展 + 新 `db-resolve-execution-id.test.ts`)**:
- 短名 `runner-6b1920df` 发送 → 收件箱与 CommDB 均落到全长 id;`delivered:true`。
- 唤醒失败(注入 transportFactory 抛错)→ `delivered:false, wakeError` 且 CommDB 行存在、`delivered_at` NULL。
- 0 命中 / 2 命中(注册两个同前缀 session)→ 抛错且 `messages` 无新行。
- 非法前缀(`runner-zz`,含 `%`)→ 抛错。
- 全长 id 路径与现有测试逐字节相同行为。

### Chunk 2 — hook 本体 `scripts/hooks/flywheel-runner-msg-guard.py`

镜像 `flywheel-restart-guard.py` 的骨架(stdlib only,`deny()` 同 JSON 形状):

```
judgment 路径(fail-open,exit 0 无输出):
  stdin 非 JSON / 非 dict / tool_name != "SendMessage" / tool_input 非 dict / to 非 str
  env FLYWHEEL_RUNNER_MSG_GUARD == "0"(QA/回滚开关)
判定:
  to.strip() 匹配 RUNNER_RE = ^runner-[0-9a-f]{8}$   → HIT
  (可选加固:去掉尾部 " [ref]" 后再匹配)
HIT → deny(reason);reason 内容:
  🚫 Lead→Runner 消息只走 Mailbox(FLY-3083)。SendMessage 给 Runner 不留底、无编号、投递失败没人知道。
  请改用(可直接复制):
    node "$FLYWHEEL_COMM_CLI" send --from "$FLYWHEEL_LEAD_ID" --to <to 原样> "<message 首 200 字,转义引号>"
  (答 gate 用 flywheel-comm respond;命令与 id 在收件箱信封里)
  若 send 打印 delivered=false / stderr 有 WARN:这是投递通道故障,不是消息问题 —— 报 infra alert 并走 re-manage 阶梯,不要换 SendMessage。
```
- `message` 若不是字符串(协议对象 shutdown_request 等)→ 仍 deny(Runner 不走 Agent Team 协议),reason 里省略正文。
- 命令模板用 env 里的 `FLYWHEEL_COMM_CLI`/`FLYWHEEL_LEAD_ID` 实值填充;缺失时退回 `flywheel-comm send --from <your-lead-id> --to …` 文字。
- 审计:追加一行 JSON 到 `${FLYWHEEL_RUNNER_MSG_GUARD_LOG:-~/.flywheel/logs/runner-msg-guard.log}`(best-effort,失败不改判定)。**不发 alert**(这不是安全事件,是纠偏)。
- 无 bypass 语法:唯一旁路是 env `FLYWHEEL_RUNNER_MSG_GUARD=0`(发送方进程 env,QA/回滚用)。

**测试 `scripts/hooks/test-runner-msg-guard.py`**(镜像 test-flywheel-restart-guard.py):
- must-deny:`to:"runner-42afa86c"`;`to:" runner-42afa86c "`;`to:"runner-42afa86c [3fa9c1]"`;message 为协议对象。
- must-allow:`to:"team-lead"`、`"main"`、`"flywheel-eng-lead"`、`"runner-42afa86c-extra"`、`"Runner-42AFA86C"`(大小写不同不是 Runner 名——`deriveRunnerMailboxIdentity` 只产小写)、tool_name `Bash`、坏 stdin、空对象、env 开关 `=0`。
- deny 输出 schema:`hookEventName/permissionDecision/permissionDecisionReason` 三键;reason 含 `flywheel-comm` 与 `--to runner-42afa86c` 与 `respond`。
- 审计:log 路径不可写时仍 deny。

### Chunk 3 — 安装脚本 + Lead 启动收敛

- `scripts/hooks/install-runner-msg-guard.sh`:逐字复制 `install-restart-guard.sh`,替换脚本名、`CMD`、matcher `"SendMessage"`;`--uninstall` 同形。
- `scripts/hooks/test-runner-msg-guard-install.sh`:复制 `test-restart-guard-install.sh` 矩阵(幂等、只删自己、保留兄弟 hook 含真实生产 PreToolUse 形状、bad JSON 不动文件、fake HOME 端到端)。
- `claude-lead.sh`:紧跟 `install_restart_guard_hook` 新增 `install_runner_msg_guard_hook()`(同形:DRY_RUN 跳过、installer 缺失 WARN、失败非致命)并在 FLY-913 调用点之后调用(所有角色,全局不变量)。
- `.github/workflows/ci.yml`:FLY-913 那步追加两行(`python3 scripts/hooks/test-runner-msg-guard.py`、`bash scripts/hooks/test-runner-msg-guard-install.sh`)。
- `doc/engineer/implementation/runner-msg-guard.md`:一页运维说明(装/卸/开关/日志),镜像 `restart-guard.md`。

### Chunk 4 — 规矩与注释三处统一

按 research.md §5 清单逐条改:
- `runner-messaging-rules.md` 重写 §1 为:
  > ## Lead → Runner:只有一条路 — `flywheel-comm send`(普通消息)/ `flywheel-comm respond`(gate 答复)
  > `SendMessage to:"runner-*"` 会被 `flywheel-runner-msg-guard` PreToolUse hook 拒绝并回给你正确命令(FLY-3083)。它不写 CommDB:无编号、无送达记录、丢了没人知道。
  > `--to` 接受 Runner 队名 `runner-xxxxxxxx` 或全长 execId。`send --json` 的 `delivered:false` / stderr WARN = 投递通道故障(如 FLY-3071),CommDB 行已留底;动作是报 infra alert + `stuck-runner-remanage` 阶梯,**不是换旁路**。
  wake 矩阵/决策表/sentinel 段按清单去 `SendMessage`,保留 `respond` 各行与 FLY-369 关键字(`parked`/`respond`/`wake`/`marker`)。
- `stuck-runner-remanage.md:40`、`runner-reengage-rules.md:25`、`runner-patrol-rules.md:93` 三处改为只提 `flywheel-comm send`。
- `claude-lead.sh:1821-1830` 注释改写(保留 commdb 条件加载与其注释,`lead-rules-bundle.test.ts:214` 断言不动)。
- `hook-payload.ts:335` 不改(已正确,且被逐字断言)。
- `lead-rules-base/README.md` 若有该文件条目描述,同步措辞。

**测试**:
- 新 `packages/teamlead/src/__tests__/fly3083-mailbox-only-rules.test.ts`:
  - 四个规矩文件中,每一行含 `SendMessage` 的都必须同时含 `denied|拒绝|will be denied|hook`(即只允许「会被拦」的表述),否则 fail;
  - `runner-messaging-rules.md` 含 `flywheel-comm send`、`respond`、`delivered`、`FLY-3083`;
  - `claude-lead.sh` 的 1821 段不再含 `MUST be told to use \`SendMessage\``,且含 `runner-msg-guard`;
  - `claude-lead.sh` 含 `install_runner_msg_guard_hook` 且其调用点在 `install_restart_guard_hook` 调用之后。
- 现有 `fly369-patrol-rule.test.ts`、`lead-rules-bundle.test.ts`、`misroute-render.test.ts` 必须原样通过(不改这些测试)。

### Chunk 5 — 文档与版本

- `doc/VERSION` 与 CLAUDE.md 里程碑行按 ship 时空号补;本单为 patch 级(hook + 规矩 + send 输出增强,默认行为字节兼容)。
- 本文件夹 progress.md 持续更新;design HTML 见 §9。

## 4. 回滚边界

| 层 | 回滚动作 | 影响 |
|---|---|---|
| hook | `bash scripts/hooks/install-runner-msg-guard.sh --uninstall` 或发送方 env `FLYWHEEL_RUNNER_MSG_GUARD=0` | 立即回到「不拦」;规矩文本仍正确 |
| send 增强 | revert Chunk 1 | 非 JSON stdout 本就字节兼容;`--json` 多出的字段消费方为零(grep 确认)|
| 规矩 | revert Chunk 4 | 文本回到两套真相,但 hook 仍拦——机制独立于规矩 |

无迁移:CommDB schema 不变(只加查询),settings.json 只加一个 PreToolUse 条目。

## 5. 负向守卫(明确不做的事在测试里钉死)

- hook 对非 `SendMessage` 工具零输出(不能变成第二个 restart-guard)。
- hook 对 `to:"team-lead"` 放行(Runner→Lead 黑洞由 FLY-208 巡检负责,不是本 hook 的事)。
- `send` 在收件人解析失败时**不写** CommDB。
- 前缀查询参数化且前缀先正则校验。

## 6. 取舍与被拒方案

| 方案 | 判定 | 原因 |
|---|---|---|
| hook 自动转写(代跑 `flywheel-comm send` 再 deny) | 拒(follow-up 可选) | transcript 显示「被拒」但消息已发,LLM 重试即重复投递(新 id,幂等前缀不覆盖);hook 内副作用要另设记账;Codex Lead 无此路径不对称 |
| Bridge 侧巡检 Lead→Runner 收件箱补录 | 拒 | 事后合法化第二条路;分辨来源靠前缀,脆 |
| 只改规矩 | 拒 | founder 明确要机制;9-29 事故证明规矩挡不住 |
| 拆 Runner 团队成员登记 | 拒 | `send` 自己的唤醒也走这个收件箱 |
| hook 装 Lead 工作区 `settings.local.json` | 拒 | 要新造合并逻辑;全局是全机不变量,和 FLY-913 一致;全仓无其他 `to:"runner-*"` 用法可误伤 |
| hook 用 sqlite 自查 execId | 拒 | 第二份 CommDB 读逻辑;改为 `send --to` 接受短名 |

## 7. 风险

1. **Lead 反复被拦**:LLM 可能连续两次 `SendMessage`。reason 里给可复制命令,规矩正向指引一句;观察生产 log 计数,若高频再考虑自动转写 follow-up。
2. **通道真卡住时的诱惑**:hook reason + 规矩都写「报 infra + re-manage,不换旁路」;FLY-3071 已 QA 待合入。
3. **v2 Mailbox 差异**:生产 `send` 写 v2 mailbox 服务;本计划对 `send` 的改动限于「解析短名 + 外露结果」,与 v1/v2 无关。实现时以生产分支的 `send.ts` 为准合并。
4. **全局 hook 影响 founder 会话**:只拦 `to` 恰为 Runner 名的调用,founder 正常不会这样发;`=0` 开关可关。

## 8. 验证与 QA 交接

- 本机只跑相关测试:`python3 scripts/hooks/test-runner-msg-guard.py`;`bash scripts/hooks/test-runner-msg-guard-install.sh`;`pnpm --filter flywheel-comm test -- send`;`pnpm --filter flywheel-teamlead test -- fly3083 fly369-patrol-rule lead-rules-bundle misroute-render`。全量交 CI。
- QA 真机(slot):① Lead 对 Runner 用 `SendMessage` → 看到 deny reason,Runner 收件箱**没有**新条目;② Lead 照 reason 跑 `send --to runner-xxxxxxxx` → Runner 收到 `[lead-instruction <id>]`,CommDB 有行且 `delivered_at` 非空;③ `send --json` 对 vendor=none 的 session 返回 `delivered:false`;④ 卸载后 SendMessage 恢复放行(回滚证据)。

## 9. Founder 设计 HTML

`engineering/doc/FLY-3083-lead-runner-mailbox-only/founder-design.html`(Apple-light、Mermaid 本地 SVG、逐节评论层、`【页面意见汇总】FLY-3083`)。随设计产物一起提交、`publish-report --publish-only` 发布并 `ask --report` 报 Lead。

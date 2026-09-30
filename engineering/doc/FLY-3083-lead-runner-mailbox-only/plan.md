# FLY-3083 Lead→Runner 消息只走 Mailbox — 实施计划

Issue: FLY-3083 (https://linear.app/geoforge3d/issue/FLY-3083/规矩机制leadrunner-消息-所有-lead-的共用规矩还在教日常聊天用-sendmessage5-月-fly-142-的旧版和-7)
日期: 2026-09-29
基于: exploration.md, research.md

> 修订记录:v2(Codex R1,5 HIGH / 2 MEDIUM 全部采纳)— 广播拦截、结果语义分支表、CoS 覆盖的共享契约、shlex 安全命令生成、`send()` 签名兼容、Lead-local 安装、告警 kind 四面对齐、部署/回滚顺序。v3(Codex R2,2 HIGH / 2 MEDIUM / 1 LOW 全部采纳)— 广播在 Flywheel Lead 会话一律拒(去掉有竞态的名单豁免)、告警完整调用合同 + per-Runner episode signature + strict-delivery 结果分支、installer 加入同一 workspace 锁协议、「疑似停滞」分支去掉不存在的 `/health` 投递面并写清证据与边界、测试路径/CI 接线修正。v4(Codex R3,2 HIGH / 1 MEDIUM / 1 LOW 全部采纳)— 告警脚本路径改为显式注入的 `FLYWHEEL_LEAD_ALERT_SCRIPT`(`FLYWHEEL_ROOT` 其实不进 Claude pane 也不过 Codex 白名单)、`duplicate` 定义为「已 claim、投递未知」、signature 加 episode 锚点(anchor instruction id)、告警测试进 CI。R2 已从 Claude Code 源码确认:Lead-local settings 的 hook 在 `--permission-mode bypassPermissions` 下仍生效(deny 早于权限流程);`to:"*"` 是 SendMessage 唯一的多收件人形态。

## 0. 一句话

给每个能带 Runner 的 Lead(cos + dept,Claude 后端)装一个 PreToolUse hook:`SendMessage` 的收件人是 Runner 队名或广播 `*` 就当场拦下,把 shell 安全、完整正文的 `flywheel-comm send` 命令喂回去;所有 Lead(Claude/Codex × cos/dept × mailbox/commdb)共用一份「Runner 通道契约」;`send` 外露传输结果并写清语义;通道故障有明确的发现与升级动作,不再靠旁路。

## 1. 目标与非目标

**目标(对应 issue「要的效果」1-4)**
1. Lead 侧入口唯一:`flywheel-comm send`(普通消息)/ `respond`(gate 答复)。契约对**所有能与 Runner 通信的 Lead** 生效(覆盖矩阵见 §3.4)。
2. 机制兜住:`SendMessage to:"runner-*"` 与 `SendMessage to:"*"`(广播;Flywheel Lead 会话里**一律**拒,不看团队名单)被 hook 硬拦(deny + 替代命令)。
3. `runner-messaging-rules.md`、`claude-lead.sh` 注释、`hook-payload.ts` 提示三处一致。
4. 回归测试:喂一条 `SendMessage to:"runner-…"`/`to:"*"`,断言被拦下且 reason 里的命令经 stub CLI round-trip 后 argv/正文逐字节正确。

**非目标**
- Runner→Lead 方向(FLY-208 已覆盖)。
- Mailbox→Runner 最后一段投递(FLY-2127)与 v2 信箱排队状态接口(FLY-1547 / FLY-3071)。
- 自动转写(hook 代发)——§6。
- **机制**拦截 Codex Lead 的 `codex queue --remote` / `codex resume` steering 旁路——契约文本明令禁止,机制拦截 follow-up(Codex CLI 0.159 已有 hooks)。本单**不宣称** Codex Lead 的旁路已被机制封死。
- 修 `install-restart-guard.sh` 自身的 `CLAUDE_CONFIG_DIR` 缺陷(R1 #6 顺带发现,另开 follow-up)。

## 2. 架构

```mermaid
flowchart LR
  L[Lead LLM] -->|SendMessage to runner-xxxxxxxx 或 *| H{PreToolUse hook<br/>flywheel-runner-msg-guard.py}
  H -->|命中| D[deny + reason:<br/>shlex 安全的完整 send 命令]
  H -->|其他收件人 / 非 SendMessage / stdin 坏 / 非 Flywheel Lead 会话| A[放行 exit 0]
  D --> L
  L -->|Bash: flywheel-comm send| S[send.ts]
  S -->|1 resolveExecutionId 短名→全长| DB[(CommDB sessions)]
  S -->|2 insertInstruction| M[(CommDB messages<br/>id + delivered_at)]
  S -->|3 wakeRunnerMailbox 按 vendor| MB[Runner 收件箱 / Codex 邮箱]
  S -->|4 stdout id · --json transport_write| L
```

单一真相:`deriveRunnerMailboxIdentity` 决定 Runner 队名;`send` 是唯一写 Mailbox 的入口;「Runner 通道契约」一份文本注入所有 Runner-capable Lead。

## 3. 分块实施

部署顺序**必须** Chunk 1 → 2 → 3(hook 的替代命令依赖新 `send` 语法);回滚顺序相反。Chunk 4/5 独立。

### Chunk 1 — `flywheel-comm send`:短名解析 + 传输结果外露(`packages/flywheel-comm`)

**CommDB(`db.ts`)** 新增:
```ts
/** FLY-3083: resolve a Runner mailbox short name ("runner-<8hex>", exact
 *  match of deriveRunnerMailboxIdentity's shape) to the full execution_id.
 *  ANY other string (UUID, "exec-123", "runner-e1", …) is returned verbatim —
 *  the existing opaque-id contract is untouched. Fail-closed on 0 or >1 hits. */
resolveExecutionId(ref: string, opts?: { leadId?: string }): string
```
- 仅当 `ref` 精确匹配 `^runner-([0-9a-f]{8})$` 时查库:`SELECT execution_id FROM sessions WHERE execution_id LIKE ? ESCAPE '\'`,参数 = `<8hex>%`(前缀已由正则限定为 hex,无 `%`/`_`);有 `leadId` 时加 `AND lead_id = ?`。
- 0 命中 → `Error("no session for runner ref …")`;>1 → `Error("ambiguous runner ref … (N sessions)")`;**不**按最新 session 猜。
- 其他任何字符串原样返回(不查库)——`commands.test.ts`/`cli.test.ts`/`e2e-workflows.test.ts` 的 `exec-123`/`exec-w2`、`declare-state.test.ts` 的 `runner-e1` 行为逐字节不变。

**`send.ts`**:
- 新增 `sendDetailed(args): Promise<SendResult>`;**现有 `send(args): Promise<string>` 保留**,实现为 `(await sendDetailed(args)).instructionId`——`commands.test.ts:135-145`、`send-backend-routing.test.ts` 等直接消费返回 id 的调用方零改动。
- `sendDetailed` 先 `db.resolveExecutionId(args.toAgent, { leadId: args.fromAgent })`;解析抛错 → 直接抛,**不写** CommDB。
- ```ts
  export interface SendResult {
    instructionId: string;
    executionId: string;                       // 解析后的收件人
    transportWrite: "ok" | "skipped" | "error"; // 见 §3.3 语义表
    skippedReason?: "backend_commdb" | "no_session_lead" | "no_transport";
    wakeError?: string;
    /** @deprecated alias: transportWrite === "ok". NOT a consumption ack. */
    delivered: boolean;
  }
  ```
  `vendor === "none"` → `skipped/no_transport`;`wake.skippedReason` 直传;`wake.error` → `error`。
- stderr 现有 warn/error 行**原文保留**。

**`index.ts:runSend`**:
- 非 `--json`:stdout 仍只打 `instructionId`(字节兼容);
- `--json`:在现有 `{"instruction_id"}` 上**追加** `execution_id, transport_write, skipped_reason?, wake_error?, delivered`(`cli.test.ts:358-369`、`e2e-workflows.test.ts:94-107` 只读 `instruction_id`,追加字段兼容)。
- 解析错误 → 现有顶层错误路径(非零退出 + stderr)。

**测试(显式清单)**:
- 新 `src/__tests__/db-resolve-execution-id.test.ts`:短名命中 / 0 命中 / 2 命中(两 session 同前缀)/ leadId 过滤 / 非短名(UUID、`exec-123`、`runner-e1`、`runner-42AFA86C`、`runner-42afa86c-x`)原样返回不查库。
- `send-mailbox.test.ts` 扩展:短名发送落到全长 id 的收件箱与 CommDB;`transportWrite:"ok"`;沿用现有 **ENOTDIR fixture**(`:195`,`CLAUDE_CONFIG_DIR` 指向文件)得 `transportWrite:"error"` + CommDB 行存在 + `delivered_at` NULL;`FLYWHEEL_COMM_BACKEND=commdb` → `skipped/backend_commdb`;vendor none → `skipped/no_transport`;解析失败 → `messages` 无新行。不扩大生产 API(不给 `SendArgs` 加 transportFactory)。
- 回归原样通过:`commands.test.ts`、`cli.test.ts`、`e2e-workflows.test.ts`、`declare-state.test.ts`、`send-backend-routing.test.ts`。

### Chunk 2 — hook 本体 `scripts/hooks/flywheel-runner-msg-guard.py`

镜像 `flywheel-restart-guard.py` 骨架(stdlib only;`deny()` JSON 同形)。

**判定(顺序固定)**
```
judgment 路径(fail-open,exit 0 无输出):
  stdin 非 JSON / 非 dict / tool_name != "SendMessage" / tool_input 非 dict / to 非 str
  env FLYWHEEL_RUNNER_MSG_GUARD == "0"(QA/回滚开关)
  env FLYWHEEL_LEAD_ID 未设(不是 Flywheel Lead 会话 → 本 hook 不管)
normalize(to):
  strip → 去掉尾部 ref 后缀 `\s+\[[0-9a-f]+\]$` → 得 name(判定与命令**都用** name)
命中 A:name 匹配 RUNNER_RE = ^runner-[0-9a-f]{8}$
命中 B:name == "*"(广播;本机 SendMessageTool 对 to:"*" 枚举团队成员逐个写收件箱,Runner 是成员 → 等同直发)
  → Flywheel Lead 会话(FLYWHEEL_LEAD_ID 已设)里**一律 deny,不读团队名单**。
  R2 证明名单豁免有 check-then-use 竞态:hook 读名单时无 Runner → dispatcher 登记新 Runner(team-bootstrap.ts 的文件锁不覆盖原生工具的发送过程)→ 原生广播写进新 Runner 收件箱、CommDB 无记录。
  非 Runner 队友要联系就逐个点名 SendMessage(不受影响);非 Flywheel 会话(无 FLYWHEEL_LEAD_ID)广播照常放行。
```
`to:"*"` 是 SendMessage 唯一的多收件人形态(R2 核对 `SendMessageTool.ts`:`to` 为单 string,仅精确 `"*"` 走 handleBroadcast,含 `@` 的地址被拒,`uds:`/`bridge:` 为单目标)——hook 不需要覆盖其他形态。

**deny reason 生成(R1 #4)**
- 命令用 argv 列表构造后 `shlex.join`(每个数据参数整体引用,`$`/`$(…)`/反引号/引号/换行全部保真):
  `node <FLYWHEEL_COMM_CLI> send --from <FLYWHEEL_LEAD_ID> --to <name> -- <完整 message>`
  (`--` 已核实:`node:util.parseArgs` 之后的参数全进 positionals,含以 `--` 开头的正文。)
- **正文完整保留,不截断**。仅当正文 > 4000 字符时,命令中改用占位 `'<在此粘贴原文>'` 并在 reason 里明说「正文过长,请自行粘贴」——占位命令绝不标为可直接运行。
- `message` 为协议对象(shutdown/plan_approval)→ deny,reason 说明「Runner 不走 Agent Team 协议消息」,**不给命令**。
- 广播 → deny,reason:「逐个 Runner 用 send;非 Runner 队友仍可 SendMessage」,给的是模板(`--to <runner-队名>`),不伪造收件人。
- env `FLYWHEEL_COMM_CLI`/`FLYWHEEL_LEAD_ID` 缺失时命令退回 `flywheel-comm send --from <your-lead-id> --to … -- …` 字面。
- reason 末段固定文案:answer gate 用 `respond`;`send --json` 的 `transport_write` 语义见契约;通道故障走 §3.3 分支,**不要换 SendMessage**。
- 审计:追加一行 JSON 到 `${FLYWHEEL_RUNNER_MSG_GUARD_LOG:-<FLYWHEEL_STATE_DIR|~/.flywheel>/logs/runner-msg-guard.log}`(best-effort,失败不改判定);**不发 alert**。
- 无 bypass 语法;唯一旁路 = env `FLYWHEEL_RUNNER_MSG_GUARD=0`。

**测试 `scripts/hooks/test-runner-msg-guard.py`**
- must-deny:`runner-42afa86c`;` runner-42afa86c `;`runner-42afa86c [3fa9c1]`;`*`(不论团队文件存在/缺失/坏 JSON/无 Runner 成员——四个 fixture 都 deny);协议对象 message。
- must-allow:`team-lead`、`main`、`flywheel-eng-lead`、`runner-42afa86c-extra`、`Runner-42AFA86C`(队名只产小写)、tool_name `Bash`、坏 stdin、空对象、`FLYWHEEL_RUNNER_MSG_GUARD=0`、未设 `FLYWHEEL_LEAD_ID`(含 `*`)。
- 负向:hook 源码中不得出现读团队 `config.json` 的代码(grep-zero,防止豁免被悄悄加回)。
- **命令 round-trip**:用 stub `FLYWHEEL_COMM_CLI`(把 argv 以 JSON 打到文件)执行 reason 里抽出的命令(`bash -c`),断言 argv == `[send,--from,<lead>,--to,runner-42afa86c,--,<原文>]`,覆盖正文:`$VAR`、`$(printf X)`、反引号、单双引号混合、多行、以 `--` 开头、含 `[ref]` 时 `--to` 已归一化、>4000 字符时为占位且 reason 含「过长」。
- deny 输出 schema 三键;审计路径不可写仍 deny。

### Chunk 3 — 安装:Lead-local settings + 既有 workspace 锁(R1 #6/#7)

- **位置**:`<LEAD_WORKSPACE>/.claude/settings.local.json`(Lead 进程 `cd "$LEAD_WORKSPACE"` 后启动,项目级 local settings 的 hooks 与 user settings 合并生效)。不再写全局 `~/.claude/settings.json`——既避开 `CLAUDE_CONFIG_DIR` profile 落错(R1 #6),又不与 restart-guard / reply-enforcer 争用同一全局文件(R1 #7);每个 workspace 只有 `claude-lead.sh` 一个写者,且已有 mkdir 自旋锁(`claude-lead.sh:1562-1608`)。
- **hook 脚本稳定路径**:`<FLYWHEEL_STATE_DIR|~/.flywheel>/bin/flywheel-runner-msg-guard.py`,cp 走 `mktemp + mv`(原子替换,另一会话不会读到半成品)。
- `scripts/hooks/install-runner-msg-guard.sh [--settings <path>] [--uninstall] [--lock-held]`:jq-merge `hooks.PreToolUse` 一条 `{matcher:"SendMessage", hooks:[{type:"command", command:"python3 <stable-path>"}]}`;jq 1.6 输出非空判有效;只删自己的 command、保留兄弟、空组丢弃;mktemp+mv;bad JSON 不动文件 exit 2。`--settings` 缺省 = `${LEAD_WORKSPACE:?}/.claude/settings.local.json`。
- **锁协议(R2 #3)**:installer 的 read→merge→rename 全程必须持有 `<settings>.flywheel-lock`(mkdir 自旋锁,与 `claude-lead.sh:1571-1605` 同名、同 60s 陈旧判定、同 10s 超时→exit 3 不写)。standalone 运行默认自取锁;launcher 已持锁时以 `--lock-held` 调用(内部约定,installer 断言锁目录存在,否则拒绝)以免自死锁。**launcher 与 ops 的 install/converge/uninstall 全部走这一套协议**,不存在无锁写者。
- `--uninstall` 只移除**本 workspace 文件**里的条目;稳定路径脚本可能被其他 Lead 引用,不删(文档写明)。
- `claude-lead.sh`:在现有 settings.local.json 锁块内(MCP 预置之后、释放锁之前)调用 `installer --settings "$_SETTINGS_LOCAL_JSON" --lock-held`;仅 cos + dept(`IS_COMPANION_ROLE`/`IS_EXTERNAL_ROLE` 跳过);DRY_RUN 只 log 计划路径;失败非致命 WARN。
- 安装/卸载/收敛三者用**同一**解析出的路径。
- `.github/workflows/ci.yml`:FLY-913 那步追加 `python3 scripts/hooks/test-runner-msg-guard.py`、`bash scripts/hooks/test-runner-msg-guard-install.sh`、`bash packages/teamlead/scripts/__tests__/fly3083-guard-install-plan.test.sh`(现有 CI 不自动扫描该目录,必须显式列出)。
- `doc/engineer/implementation/runner-msg-guard.md`:装/卸/开关/日志/为什么是 Lead-local。

**测试 `scripts/hooks/test-runner-msg-guard-install.sh`**:jq 矩阵(幂等、只删自己、保留真实生产形状的兄弟 hook、bad JSON 不动文件);fake workspace 端到端 install/converge/uninstall;路径含空格;`--settings` 指向自定义文件时默认文件不被触碰;**锁矩阵**:锁被他人持有时 standalone 等待/超时不写、`--lock-held` 无锁目录时拒绝、受控交错(installer 读旧快照期间由测试模拟 launcher 在锁内写入 `enableAllProjectMcpServers` 与一个兄弟 hook → 最终文件同时保留三者)、并发 install+uninstall 收敛到确定状态;**不**碰真实用户 settings。新 `packages/teamlead/scripts/__tests__/fly3083-guard-install-plan.test.sh`:DRY_RUN 的 launch plan 日志含目标 settings 路径与角色跳过逻辑(companion/external 不装)。

### Chunk 4 — 规矩:一份共享契约 + 三处统一(R1 #3)

**新文件 `lead-rules-base/runner-channel-contract.md`(≤25 行,backend-independent,不含 mailbox 运维细节)**:
> ## Runner 通道契约(FLY-3083)
> 1. 给 Runner 发消息**只有** `flywheel-comm send --from <你的 lead id> --to <runner 队名或 execId> -- <正文>`;答 gate 用 `flywheel-comm respond`(命令在收件箱信封里)。
> 2. 禁止的旁路(它们不留 CommDB 账、无编号、丢了没人知道):`SendMessage to:"runner-*"`、`SendMessage to:"*"`(广播)、直接写收件箱文件、`codex queue --remote` / `codex resume` 直接 steer Codex Runner。Claude Lead 的前两条被 `flywheel-runner-msg-guard` hook 拦下;其余靠本契约。
> 3. `send --json` 的 `transport_write`:`ok` = 写进 Runner 传输层(**不是**消费确认);`skipped` + `backend_commdb` = 回滚模式正常(Runner 从 CommDB 读);`skipped` + `no_transport` = 该 Runner 后端无传输(antigravity/kimi,走 pr_handoff);`error` = 即时传输失败。
> 4. 通道故障处理见分支表(§3.3);**任何分支都不换旁路**。

**注入**:
- `claude-lead.sh`:紧邻 `founder-only-authority.md` 的 universal 块,cos + dept 均加载(companion/external 跳过),**不受** `FLYWHEEL_COMM_BACKEND` 影响。
- `lead-rules-bundle.sh`:cos 与 dept 分支均 `_lrb_emit "${base}/runner-channel-contract.md" 0`(mailbox 与 commdb 都发);companion 不发。
- `lead-rules-bundle.test.ts` 三个期望列表相应插入该文件(dept/mailbox、dept/commdb、cos);`README.md` 表格加行。

**按 research.md §5 清单改写**:`runner-messaging-rules.md`(dept/mailbox 运维文档,保留 wake 矩阵与 FLY-369 关键字;§1 改为指向契约的 mailbox 细节;决策表/sentinel 段去 `SendMessage`;新增「§通道故障分支表」)、`stuck-runner-remanage.md:40`、`runner-reengage-rules.md:25`、`runner-patrol-rules.md:93`、`claude-lead.sh:1821-1830` 注释(保留 commdb 条件加载)。`hook-payload.ts:335` 不改。

**测试** 新 `packages/teamlead/src/__tests__/fly3083-mailbox-only-rules.test.ts`:
- 五个规矩文件中含 `SendMessage` 的每一行必须同时含 `denied|拦|禁止|hook`;
- 契约文件含 `flywheel-comm send`、`respond`、`transport_write`、`codex queue`、`FLY-3083`;
- `claude-lead.sh` 1821 段不含 `MUST be told to use \`SendMessage\``;含 `runner-channel-contract.md` 且在 cos/dept 共同路径;含 `install-runner-msg-guard.sh` 且位于 settings.local 锁块内(锁 `mkdir` 与 `rmdir` 之间)。
- 现有 `fly369-patrol-rule.test.ts`、`misroute-render.test.ts` 原样通过;`lead-rules-bundle.test.ts` 仅更新期望列表。

### Chunk 5 — 告警 kind:`mailbox_channel_fault`(四面对齐 + 可执行调用合同)

- 新 kind **一个**:`mailbox_channel_fault`,subkind ∈ `transport_error | suspected_stall`。四面同步:`scripts/lead-alert.sh`(帮助与 case 白名单)、`LeadAlertNotifier.ts ALERT_EVENT_TYPES`、`kind-contract.ts`(owner `claude`,arc `human_by_design`——与 restart_guard_bypass 同类:人来修通道)、`infra-event-router.ts`;`packages/teamlead/src/bridge/__tests__/kind-contract.test.ts` 加**显式**断言:shell 白名单含该 kind、union 含该 kind、contract 条目 owner/arc 如上、router 分支覆盖(不能只靠 union 新增成员通过既有 drift guard)。
- **完整调用模板(R2 #2;进契约文件与 runner-messaging-rules.md,Lead 照抄)**:
  ```bash
  bash "${FLYWHEEL_LEAD_ALERT_SCRIPT:?FLYWHEEL_LEAD_ALERT_SCRIPT 未注入(Lead 启动缺陷)— 改在 issue thread 明文报告}" \
    --lead "$FLYWHEEL_LEAD_ID" --project "${FLYWHEEL_PROJECT_NAME:-$PROJECT_NAME}" \
    --kind mailbox_channel_fault --severity severe --strict-delivery \
    --signature "mailbox:<execution_id>:<subkind>:<anchor_instruction_id>" \
    --title "Mailbox channel fault (<subkind>) runner <runner 队名> issue <FLY-xxx>" \
    --body "subkind=<subkind>\nanchor_instruction_id=<episode 首条 id>\ninstruction_id=<本次 id>\nexecution_id=<execution_id>\nsent_at=<send 时间>\nevidence=<一行证据>"
  ```
- **脚本路径的端到端提供(R3 #1)**:`FLYWHEEL_ROOT` 只是 launcher 内 export(`claude-lead.sh:203`),**不在** tmux `env_args`(`:1151-1192`)里,也**不在** Codex `FULL_ACCESS_ENV_ALLOWLIST`(`codex-lead-runtime.ts:363-413`)里——R3 实跑 `buildFullAccessEnv` 证实被过滤。因此新增**一个非敏感 env** `FLYWHEEL_LEAD_ALERT_SCRIPT` = 绝对路径 `<flywheel 根>/scripts/lead-alert.sh`(launcher 端 `realpath`,文件不存在则 log WARN 且不注入,让契约的 `:?` 守卫兜底):
  - Claude:`claude-lead.sh` 由 `$SCRIPT_DIR/../../../scripts/lead-alert.sh` 解析,加入 `env_args`(companion/external 与 `_cz_comm_cli` 同样置空);
  - Codex:`codex-lead.sh` full-access 分支(`:146-147` 旁,紧邻 `FLYWHEEL_LEAD_ID/FLYWHEEL_PROJECT_NAME` 的 export)由其 `SCRIPT_DIR` 解析并 export;`FULL_ACCESS_ENV_ALLOWLIST` 增加该名(非敏感,不放宽其他过滤);`run-codex-infra-bot-tui.sh` 等 Runner-capable Codex launcher 经 `codex-lead.sh` 得到它,不各自硬编码。
  - 测试:`fly3083-guard-install-plan.test.sh` 从 DRY_RUN launch plan 断言 Claude `env_args` 含 `FLYWHEEL_LEAD_ALERT_SCRIPT=<存在的文件>`;新 `codex-lead-runtime` 单测断言白名单含该名且 `buildFullAccessEnv`/`buildTuiDaemonEnv` 原样透传;`codex-lead-args.test.sh` 断言 full-access 分支 export;两侧都用 stub 脚本按模板调用一次证明可达。契约文本**不再**声称「已注入 pane」之外的任何环境事实。
- **episode signature(R3 #3)** = `mailbox:<execution_id>:<subkind>:<anchor_instruction_id>`。`anchor_instruction_id` = 本次故障 episode 的**第一条**受影响 instruction id;同一未恢复 episode 内的重试沿用同一锚点(去重不刷屏);恢复后再次出现同类故障用新的锚点(新 event_id,不会被旧 claim 吞掉——`lead-alert.sh` 的去重只看 project|lead|kind|signature,不看 body/claim age)。锚点写进 `--body` 与 issue 证据,便于对账。
- **strict-delivery 结果分支**(`lead-alert.sh --strict-delivery` 最后一行;R3 #2):`sent`/`queued_transient` = 已升级;**`duplicate` = 该 signature 已被 claim,投递状态未知**(首发可能 403/缺 token/进程中断后 claim 仍在;脚本 `:333-335` 明说 strict caller 不得视为已投递)——仅当 Lead 手头有该 episode 此前的 `sent`/`queued_transient` 结果或 issue-thread 上报凭据时才按已升级处理,否则执行 issue-thread 兜底并如实写「告警投递状态未知」;`dead_lettered`/`config_error`/其他 = **未升级**,Lead 必须改走 issue thread 明文向 founder 报告通道故障。契约不改变共享 `lead-alert.sh` 的去重语义。
- 触发方仅为 Lead(手动照模板),本单不加自动探测。
- **测试** `scripts/__tests__/lead-alert-mailbox-fault.test.sh`(沿用 `lead-alert-fly927.test.sh` 的隔离方式:fake curl 于前置 PATH、隔离 `FLYWHEEL_*` 目录、不碰 `~/.flywheel`):同一 Lead 两个 Runner / 两个 subkind → 四个不同 event_id 全部进入发送路径;同一 episode(同锚点)重复 → `duplicate`;**episode A 成功上报 → 同 Runner/subkind 的 episode B(新锚点)可再次发送**;**首发 403 → `dead_lettered`,修好发送器后重试 → `duplicate` 且无 POST**(钉死「duplicate ≠ 已上报」);仅预置 claim、无成功/排队凭据的 duplicate 同样不得被解释为已升级;缺 `--lead/--project/--title` → exit 1;未知 kind 仍 `config_error`。**CI**:加入 `.github/workflows/ci.yml` FLY-927 那步(`:252-256`,现有 step 逐条列举 shell 测试,不会自动扫描)。

### 3.3 通道故障分支表(R1 #2;进契约与 runner-messaging-rules.md)

| `send` 结果 | 含义 | Lead 动作 |
|---|---|---|
| `transport_write:"ok"` | 已留底 + 写进传输层;**消费未知** | 正常。消费证据 = Runner 的回执(`flywheel-comm ask --report` / 终端可见 `[lead-instruction <id>]`)。 |
| `ok` 但 **10 分钟**内无回执 **且** Bridge 对该 Runner 报 `runner_idle_detected`/stuck(FLY-92/369)或终端 capture 无变化 | **疑似**消费/投递停滞(FLY-3071 形态)——这是**调查触发器,不是确诊**:指令可能已消费但 Runner 在等外部条件、或没产生回执 | 收集证据:instruction id、CommDB 该行的 `created_at`/`delivered_at`、最后一次终端 capture、Bridge idle 事件时间;按 Chunk 5 模板报 `subkind=suspected_stall`;**不**凭空套 re-manage 阶梯,**不**重启 Runner,**不**换旁路。**本快照没有投递进度探针**:Bridge `/health` 只返回 `ok/shuttingDown/uptime/sessions_count`,仅证明 Bridge 进程可响应,不能排除 Mailbox 故障(不得写成「查 /health 投递面」)。生产 v2 若有 mailbox 状态查询(FLY-1547),以「QUEUED > 10 分钟」作为直接证据——须在生产基线核实,本轮不宣称已验证。 |
| `skipped/backend_commdb` | 回滚模式,Runner 从 CommDB 读 | 正常,无动作。 |
| `skipped/no_transport` | 后端无传输(antigravity/kimi) | 正常;该 Runner 走 pr_handoff,不期待唤醒。 |
| `skipped/no_session_lead` | session 行缺 lead_id(登记异常) | 按 Chunk 5 模板报 `subkind=transport_error`;查 `sessions` 登记。 |
| `error` + `wake_error` | 即时传输失败(收件箱不可写等) | CommDB 行已留底;按 Chunk 5 模板报 `subkind=transport_error`;修通道后**重发同一内容**(新 id,Runner 幂等协议按 id 去重不覆盖,故只在确认未送达时重发)。 |

### 3.4 覆盖矩阵(R1 #3)

| Lead 后端 | 角色 | 通道模式 | 契约文本 | hook 机制 | 备注 |
|---|---|---|---|---|---|
| Claude | dept | mailbox | ✅ 契约 + runner-messaging-rules | ✅ | 主路径 |
| Claude | dept | commdb | ✅ 契约(runner-messaging 仍按现状跳过) | ✅ | 回滚模式 |
| Claude | cos | mailbox/commdb | ✅ 契约(新) | ✅ | R1 #3 补上的缺口 |
| Codex | dept/cos | mailbox/commdb | ✅ 契约 + (dept/mailbox) runner-messaging | — 无 SendMessage 工具;`codex queue` 旁路仅契约禁止 | 机制拦截 follow-up |
| companion / external | — | — | 不注入(不带 Runner) | 不装 | 与现状一致 |

## 4. 回滚边界

| 层 | 回滚动作 | 影响 |
|---|---|---|
| hook | `install-runner-msg-guard.sh --settings <path> --uninstall` 或发送方 env `FLYWHEEL_RUNNER_MSG_GUARD=0` | 立即回到「不拦」 |
| send 增强 | revert Chunk 1(**须先卸 hook**,否则 reason 里的短名/`--` 命令对旧 send 无效) | 非 JSON stdout 本就兼容 |
| 契约/规矩 | revert Chunk 4 + bundle 测试期望 | 文本回旧,hook 仍拦 |
| alert kind + env | revert Chunk 5 四面与 `FLYWHEEL_LEAD_ALERT_SCRIPT` 注入 | 契约里的告警命令走 `:?` 守卫 → Lead 改 issue-thread 明文报告(仅影响升级动作) |

无 schema 迁移;settings 只加一条 PreToolUse 条目(Lead-local)。

## 5. 负向守卫(测试钉死)

- hook 对非 `SendMessage` 零输出;对 `to:"team-lead"` 放行;未设 `FLYWHEEL_LEAD_ID` 时零输出。
- `resolveExecutionId` 对非短名**不查库**;`send` 解析失败**不写** CommDB。
- 前缀参数化查询,前缀正则限定 hex。
- installer 不碰 `--settings` 之外的任何文件;companion/external 不装。
- reason 命令经 stub CLI round-trip 逐字节相等,不以关键字包含代替。

## 6. 取舍与被拒方案

| 方案 | 判定 | 原因 |
|---|---|---|
| hook 自动转写(代跑 send 再 deny) | 拒(follow-up 可选) | transcript「被拒」但已发,LLM 重试即重复;hook 内副作用要另设记账;Codex Lead 无此路径不对称 |
| Bridge 巡检收件箱补录 | 拒 | 合法化第二条路 |
| 只改规矩 | 拒 | founder 要机制;9-29 证明规矩挡不住 |
| 拆 Runner 团队登记 | 拒 | `send` 的唤醒也走该收件箱 |
| 全局 `~/.claude/settings.json`(v1 方案) | 拒(R1 #6/#7) | `CLAUDE_CONFIG_DIR` profile 落错;与其他全局写者无共享锁 |
| hook 自查 sqlite 解析 execId | 拒 | 第二份读逻辑;改为 `send --to` 接受短名 |
| 广播按团队名单豁免(v2 方案) | 拒(R2 #1) | hook 读名单与原生工具发送之间有登记新 Runner 的竞态,R2 用原生 handleBroadcast 函数体复现;改为 Flywheel Lead 会话一律拒,非 Runner 队友逐个点名 |
| 只在 launcher 调用点加锁(v2 方案) | 拒(R2 #3) | standalone installer 仍是无锁写者;改为所有入口同一锁协议 |
| 把 `delivered:true` 当通道健康 | 拒(R1 #2) | 它只是传输层写成功;消费停滞用回执缺失 + Bridge idle 信号判定 |

## 7. 风险

1. Lead 连续撞护栏多花回合 → reason 命令可直接运行;契约一句正向指引;观察审计 log 频率。
2. 通道真卡住的诱惑 → 契约/hook reason 都写「不换旁路」+ 分支表给出具体动作与告警 kind。
3. Flywheel Lead 会话广播一律被拦 → 只影响「群发给全队」这一种用法;需要联系非 Runner 队友时逐个点名,零功能损失。
4. 生产 v2 信箱与本沙箱差异 → Chunk 1 改动限于解析 + 外露;分支表的 v2 判定明确写为「以 FLY-1547 状态接口为准,否则用 idle 信号」;实现者合并到生产分支时按 §3.3 校准,不得删分支。
5. 本沙箱基线:`test-flywheel-restart-guard.py` 有 1 个既有失败(T8 真实 lead-alert HTTP 200 路径),与本单无关;vitest 需先 `pnpm install --frozen-lockfile`(不带 `--filter`)。

## 8. 验证与 QA 交接

- 本机只跑相关测试:`python3 scripts/hooks/test-runner-msg-guard.py`;`bash scripts/hooks/test-runner-msg-guard-install.sh`;`bash packages/teamlead/scripts/__tests__/fly3083-guard-install-plan.test.sh`;`pnpm --filter flywheel-comm exec vitest run src/__tests__/db-resolve-execution-id.test.ts src/__tests__/send-mailbox.test.ts src/__tests__/send-backend-routing.test.ts src/__tests__/commands.test.ts src/__tests__/cli.test.ts src/__tests__/e2e-workflows.test.ts src/__tests__/declare-state.test.ts`;`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly3083-mailbox-only-rules.test.ts src/__tests__/fly369-patrol-rule.test.ts src/__tests__/lead-rules-bundle.test.ts src/__tests__/misroute-render.test.ts src/bridge/__tests__/kind-contract.test.ts`(每个文件单独确认被选中,不靠多文件命令的静默通过);`bash scripts/__tests__/lead-alert-mailbox-fault.test.sh`;`bash scripts/__tests__/lead-alert-fly927.test.sh`;`bash packages/teamlead/scripts/__tests__/codex-lead-args.test.sh`;`pnpm --filter flywheel-teamlead exec vitest run <codex-lead-runtime 白名单单测文件>`。全量交 CI。
- QA 真机(slot,Claude dept Lead + cos Lead 各一):
  1. Lead `SendMessage to:"runner-…"` → deny reason;Runner 收件箱文件**无**新条目;
  2. Lead `SendMessage to:"*"` → deny(团队里有没有 Runner 都拦);收件箱无新条目;
  3. Lead 照 reason 命令跑 → Runner 收到 `[lead-instruction <id>]`,CommDB 有行、`delivered_at` 非空,`--json` 显示 `transport_write:"ok"`;
  4. 故障注入:① **消费端暂停**(`kill -STOP` Runner 进程 → 10 分钟无回执 + Bridge idle → Lead 按分支表报 `mailbox_channel_fault/suspected_stall`,不重启、不换旁路;报告措辞必须是「疑似」)② **对照组**:指令已消费但 Runner 在等外部条件、无后续输出 → Lead 的报告不得越过证据宣称通道故障 ③ `FLYWHEEL_COMM_BACKEND=commdb` → `skipped/backend_commdb` 无告警 ④ vendor=none session → `skipped/no_transport` ⑤ 收件箱路径置为文件 → `error` + `transport_error` 告警(fake 通道验证 event_id 按 Runner 区分)。**Bridge 投递循环本身停滞**(真 FLY-3071 形态)本沙箱无法注入,标注为 v2 生产基线 / FLY-3071 的验收项,本单不宣称已验;
  5. Codex Lead(infra-bot TUI)用 `flywheel-comm send` → CommDB 有行;契约文本在其 `baseInstructions` 中可见;
  6. 卸载 / `=0` 开关 → SendMessage 恢复放行(回滚证据);`jq .hooks.PreToolUse` 证明条目只在 Lead workspace 文件里;standalone `install-runner-msg-guard.sh` 与 Lead 启动并发一次,`enableAllProjectMcpServers` 与条目均在。

## 9. Founder 设计 HTML

`engineering/doc/FLY-3083-lead-runner-mailbox-only/founder-design.html`(模板 + `build-founder-html.sh` 内联 `diagrams/*.svg`;Apple-light、Mermaid 本地 SVG、逐节评论层、`【页面意见汇总】FLY-3083`)。随设计产物提交、`publish-report --publish-only` 发布并 `ask --report` 报 Lead。

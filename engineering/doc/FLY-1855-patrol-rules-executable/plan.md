# FLY-1855 patrol_tick 六步规矩可执行化 — 实施计划

Issue: FLY-1855 (https://linear.app/geoforge3d/issue/FLY-1855/规矩机制-patrol-tick-六步实际只有两步被执行-无命令-范围冲突-无产出物-无读不懂出口)
日期: 2026-08-18
基于: 无

---

## 1. 问题与目标

Annie 2026-08-17 发现:Honey Lemon 的 patrol_tick 巡检六步只做了前两步,且**这个失效模式对每一个 Lead 都成立**。自查证实规律:

> **给了可直接执行命令的两步(§0 步 1/2),100% 被执行;没给命令的四步(步 3–6),0% 被执行。**

四个可定位缺陷(issue 原文,本计划逐条对应):

| # | 缺陷 | 本计划的修法 |
|---|------|------------|
| ① | 抽象名词无法解析成动作(「TURN belt」「engine node table」在库里找不到同名对象) | 每步落到唯一精确命令;账本类查询收口进一个 CI 测试的只读快照脚本(§4) |
| ② | 范围冲突:tick 措辞「你名下」与规矩第 5 步的全局语义相反 | 范围合同写死:**检测=整机,处置=名下**;本 PR 按 Lead 裁定保留 tick v1, v2 只作未来独立提案(§5) |
| ③ | 无产出物 ⇒ 做 2 步和做 6 步从外部看一样 | 产出物合同:每 tick 一份六步报告文件,逐步 `OK/FINDING/UNAVAILABLE`(§6) |
| ④ | 「读不懂」只能静默跳过 | UNAVAILABLE 出口:报告留痕;structural 首现建单,transient 连续 2 tick 才建单(§7) |

**实测代价锚点**:2026-08-17 全仓 GitHub 1h49m 零活动(21:21→23:10 UTC,四条 PR 全停),落在「名下」框之外,六步巡检没发现,最终 founder 本人发现——巡检存在的目的正是「founder 不该当人肉看门狗」。

## 2. 审计事实(本设计的地基,全部在生产上只读验证过)

- tick 正文由 `packages/teamlead/src/bridge/hook-payload.ts` `formatPatrolTick()`(约 :249)渲染,founder-fixed 两句模板,第二句就是「按 Bridge 的账,你名下有 N 个未终结 runner」——缺陷②的直接来源。FLY-1687 founder 裁定:tick 本体**零预判零指令**,「收到 tick 做什么」全部在 Lead 侧 `packages/teamlead/lead-rules-base/runner-patrol-rules.md` §0。
- roster 为空的 Lead **零 tick**(`patrol-tick.ts` roster.length===0 → continue);非 spawning Lead 零 tick。本计划不改这两个门(见 §9 边界)。
- 账本真身分布在**两个库**,且表空间巨大(teamlead.db 有 40+ 张 `workflow_*` 表)——执行者不可能猜对,必须写死:
  - `~/.flywheel/teamlead.db`(全局,Bridge StateStore):`workflow_run`、`workflow_run_node`(= 规矩里的「engine node table」)、`workflow_activation_turn`、`dead_letter_alerts`、`sessions`。
  - `~/.flywheel/comm/<project>/comm.db`(每项目):`three_stage_turn`(= 「TURN belt」)、`turn_wake_outbox`、`mailbox`(FLY-1573 投递账)、`turn_source_history`、`comm.sessions`(含 `tmux_window/lead_id`,与 teamlead.db 的 `main.sessions` 不是同表)。
- 两库均可 `sqlite3 "file:<path>?mode=ro"` 只读直查(WAL 下安全)。2026-08-18 的初始探针仅证明下列表/列可读、**不证明 finding predicate 已校准**;正式 Codex review R1 随后用派生 candidate 数推翻了「能返回行即可」的过强表述:
  - 步 3 初始探针:`SELECT r.issue_id, n.node_id, n.attempt, n.state, substr(n.execution_id,1,8) FROM workflow_run_node n JOIN workflow_run r ON r.run_id=n.run_id WHERE n.state='running'` ✅(能返回本 runner,但也带入 103 条 terminated-run stale rows;实现不得直接使用)
  - 步 3:`SELECT issue_id, holder_exec_id, phase, epoch FROM three_stage_turn` ✅
  - 步 4:`mailbox` runner 收件 `QUEUED/LEASED` 计数 ✅(LEASED=306——证明**必须加时间窗过滤**,裸计数会淹没 Lead);`turn_wake_outbox` pending/sent ✅(=2);`dead_letter_alerts` ✅(=144,同理需窗口)
- Discord 独立信源的具体工具:Lead 的 Discord MCP server 暴露 `reply / react / edit_message / download_attachment / fetch_messages`——步 5 的 Discord 检查用 **`fetch_messages`**(读真 Discord,不是 Bridge 账面)。
- 规矩文件经 `packages/teamlead/scripts/lead-rules-bundle.sh`(:365,§0 顺位)进入所有 non-cos dept Lead(mailbox + commdb 两路;Claude 与 Codex Lead 共用 role-aware bundle)。
- 全局脚本安装精包先例:FLY-1482 的 `~/.flywheel/bin/flywheel-cmux-sync`(leaf symlink 解析回仓库 source tree)。快照脚本复用该分发形态。

## 3. 设计总览

```mermaid
flowchart LR
    subgraph Bridge
        T["patrol_tick 模板 v1<br/>(本 PR 逐字节不改)"]
    end
    subgraph Lead 侧
        R["runner-patrol-rules.md §0 重写<br/>六步=六条精确命令<br/>+范围合同+产出物合同+UNAVAILABLE出口"]
        S["flywheel-patrol-snapshot<br/>只读事实收集脚本(步1–5)<br/>全 pane 证据 + fail-visible UNAVAILABLE"]
        P["报告文件(每tick一份)<br/>~/.flywheel/patrol-reports/&lt;leadId&gt;/..."]
    end
    Q["工程队列<br/>[patrol-unavailable] Linear issue"]
    T --> R
    R --> S
    S --> P
    R -->|"structural 首现 / transient 连续 2 tick"| Q
```

改动面共五块,全部在本仓:

| 块 | 文件 | 性质 |
|---|------|------|
| A | `packages/teamlead/lead-rules-base/runner-patrol-rules.md` §0 全文重写 | 规矩(核心交付) |
| B | `packages/teamlead/src/bridge/hook-payload.ts` `formatPatrolTick` 模板 v2 | **待 founder 认可的独立后续;本 PR 不改** |
| C | 新 `scripts/lead-patrol-snapshot.sh` + installer symlink `~/.flywheel/bin/flywheel-patrol-snapshot` + `scripts/__tests__/lead-patrol-snapshot.test.sh`(进 ci.yml 字面枚举) | 新脚本(账本/外部系统只读,只写报告产物) |
| D | 扩展 `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts`:§0 合同锚点(每步含命令、产出物合同、UNAVAILABLE 出口、范围合同) | 守卫测试 |
| E | `scripts/test-deploy.sh` `qa_slot_start_lead()` + `packages/teamlead/scripts/claude-lead.sh` child env allowlist + generalized shell contract | QA slot DB/state 隔离,防止巡检误触生产 state |

## 4. 快照脚本 `flywheel-patrol-snapshot`(块 C)

**定位**:对账本与外部系统保持只读的事实收集器,收步 1/3/4/5 的事实,并把**预填的六步报告骨架原子写入产出目录**;步 2(pane 判读)与步 6(处置)仍由 Lead 定稿。规矩文件里每一步只写**一条命令**,账本 SQL 的唯一可执行真相收口在脚本里(避免 .md 与脚本两处 SQL 漂移;schema 改名时 CI 跑真库 RED,而不是 .md 静默腐烂)。脚本对 teamlead/comm/GitHub 是 read-only;唯一写副作用是本条 tick 的报告底稿。

契约:

- 调用:`flywheel-patrol-snapshot --project <name> [--lead <leadId>] [--tick-seq <n>]`(leadId 优先取参数,否则取 `FLYWHEEL_LEAD_ID`;两者都无则 usage error)。当前 v1 正常不传 `--tick-seq`,生成 `tickNA`。
- 路径解析必须与现有 runtime env 对齐:StateStore 复用 `resolveStateDbPath` 的真实顺序——`FLYWHEEL_STATE_DB_PATH` → `TEAMLEAD_DB_PATH` → **固定** `$HOME/.flywheel/teamlead.db`(第三项不读 `FLYWHEEL_STATE_DIR`);projects registry 才取 `FLYWHEEL_PROJECTS_FILE` → `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/projects.json`;CommDB 对显式 `FLYWHEEL_COMM_DB` 仅在其路径归属当前 `<project>` 时采用,否则固定取 state dir 下 `comm/<project>/comm.db`。测试覆盖显式 slot 路径,并加 `FLYWHEEL_STATE_DIR` 已设但两项 DB override 均未设时仍读固定默认库的反例,避免 Lead/Runner 两套 env 名造成读错生产库。
- QA slot 不能靠调用者碰巧补 DB env:`qa_slot_start_lead()` 生成的 launch manifest 必须固定带 `TEAMLEAD_DB_PATH=${SLOT_DIR}/teamlead.db` 与 `FLYWHEEL_STATE_DIR=<该 slot state dir>`;`claude-lead.sh` 还必须把非空 `TEAMLEAD_DB_PATH` 显式加入 child `env -i` allowlist(它已经转发 `FLYWHEEL_STATE_DIR`,但当前不转发 DB override)。两层 contract test 同时断言,使巡检只读 QA fixture、报告只写 slot sandbox;生产未设 override 时的默认路径合同保持不变。
- 步 1:执行 `TMUX= tmux list-windows -a` 原样附上(供 Lead 与名册对账)。同时用
  `TMUX= tmux list-panes -a -F ...` 固定本 tick 的**整机 Runner pane 清单**:
  这里的整机边界是默认共享 socket 上、**session name 以 `runner-` 开头且
  window name 以 Linear identifier 开头**的全部 pane。`zsh` scaffold、`cmux-*` 镜像与 FLY-1663 私有 Lead socket
  不是 Runner pane,不进入停摆判定;它们仍保留在 window roster 供发现无主/错名窗口。
  Runner pane 不得抽样、不得按 Lead 或前 N 个截断。清单里任何 pane 未进入步 2 都是
  `UNAVAILABLE(structural: pane_capture_incomplete)`,不能用已查的 pane 代替全量。
- **步 2 founder 增量硬合同**(Lead instruction
  `4d22ba25-7f1e-450f-b1d7-6a1ac8859c36`,2026-08-19):对上一步的每个 pane 执行
  `TMUX= tmux capture-pane -p -S - -t <pane_id>` 全 scrollback 直读;不是只读
  `tail -40`,也不是抽查。报告不落原始 pane 文本(可能含 secret),而对每个 pane
  落一行 `PANE_EVIDENCE`:pane id/target、整份 capture 的 SHA-256 + 行数/字节数、
  最后非空状态行的 SHA-256、`last_change_epoch`、finding flags、处置字段。SHA 比较
  是对同一 pane 最后状态行的逐字节比较:状态 hash 变化就把
  `last_change_epoch=本 tick`;未变就继承上一报告;连续 ≥3600 秒未变必须标
  `STALLED_60M`。每次运行先读同一 Lead 上一份已发布报告,不得用 Bridge 活动时间
  代替 pane 文本比较。
- 全 capture grep 两类配额横幅:`You've hit your session limit` /
  `You've hit your usage limit`(兼容现有 `Claude usage limit reached`);最近 live 区
  命中才标 `LIMIT_LIVE`,仅历史 scrollback 命中标 `LIMIT_HISTORY` 供复核,不得被
  「not your usage limit」误触发。`LIMIT_LIVE` 必须直读 banner 的 reset 时刻;reset
  已过就对**名下** Runner 当场走 waking channel,跨界只上报。无法解析 reset 时刻
  是 `UNAVAILABLE(structural: limit_reset_unparseable)`,不是跳过。
- 最近 live 区命中 `Press Enter to confirm` / `Press Enter to continue` / 已知
  resume-menu 形状时标 `INTERACTIVE_MENU`;名下 pane 按对应手册执行一次有界解卡
  (仅手册明确允许 Enter 才 `tmux send-keys ... Enter`),随后重新 capture 验证;
  未知菜单必须 `UNAVAILABLE(structural: menu_unrecognized)` 并入工程队列,禁止盲按。
- 无 finding 的 `PANE_EVIDENCE` 由脚本直接写
  `action=none result=clear`;有 finding / capture failure 的行初始
  `action=REQUIRED result=UNSET`,Lead 必须逐行改成
  `wake_sent | menu_repaired | cross_boundary_reported |
  unavailable:<稳定token>` 并补稳定 `result`。报告头的 `pane_count=N`、
  `PANE_EVIDENCE` 行数、步 1 清单行数必须相等;完成门同时拒绝残留
  `action=REQUIRED`。这让「哪个 pane 查了、发现什么、处置了什么」成为硬产物,
  禁止「大概没问题」。2026-08-19 实测取数命令
  `tmux list-panes -a -F '#{session_name}|#{window_name}'` 按上述双条件得到 20 个
  Runner pane;`jq '[.[].leads[] | select(.canSpawnRunners == true)] | length' projects.json`
  得 9 个 spawning Lead,故当前上界约 180 次 full-scrollback capture/h。20 条 clear
  evidence 由脚本自动定稿,Lead 只人工处置 finding/UNAVAILABLE 行。报告不存原文。每次 capture 有 5s 有界墙钟,
  超时即 fail-visible UNAVAILABLE,不通过抽样降成本。
- **整机 owner index**:collector 从同一 projects registry 枚举每个合法 `projectName`,
  对 state dir 下 `comm/<project>/comm.db`(当前项目优先采用已校验归属的显式
  `FLYWHEEL_COMM_DB`)逐库只读查询 `comm.sessions(status='running')` 的 allowlist
  `tmux_window/execution_id/lead_id/project_name`,构建 machine-wide target index。
  target 精确唯一命中当前 `LEAD_ID` = `owned`;唯一命中其他 Lead/项目 =
  `cross-boundary`;零命中 = `unknown` finding;多重命中 =
  `UNAVAILABLE(structural: session_target_ambiguous)`。**合法 cross-boundary pane 本身
  不是 finding**,只有它的 limit/stall/menu 等实况异常才需上报;同一 tick 的跨界
  finding 合并为一条 roundtable report,各 evidence 共享该 receipt,避免逐 pane 刷屏。
  任一实际列出的 Runner pane 都不能因 owner index 不全而静默省略。
- **project 过滤(Claude cross-review R1 HIGH-1)**:teamlead.db 是**全局**库、comm.db 是**每项目**库——所有账本 join 必须带 `workflow_run.project_name = <project>` 过滤,否则跨项目错配会批量铸假 finding(生产实测:running nodes = flywheel 124 / tidal-echo 1,tidal-echo 的 Lead 不过滤会每 tick 铸 124 条假「running node 无 TURN 行」)。「整机」维度只适用于 tmux 窗口清单与 `dead_letter_alerts`。
- 步 3 的**活性集合先收窄再对账**(正式 Codex review R1 HIGH):`workflow_run_node(state='running')` 不是活性账,生产上 124 行中 103 行属于 `workflow_run.status='terminated'`;直接使用会每 tick 铸约 188 条假 candidate。脚本只取 `workflow_run.project_name=<project> AND workflow_run.status='active' AND workflow_run_node.state='running'`,并把 `sessions.status='running'` 作为独立活性证据。三类候选限定在这个 active issue/execution 集合内:active **issue** 无 TURN 行 / active issue 的 TURN holder 不在同 issue 的 live running execution 集 / active live execution 的 `turn_wait_ledger.no_turn_streak >= 3`;active node 缺 live session 另记账本分歧。2026-08-18 PDT 修订后在生产只读库校准:flywheel active running nodes=11、live=10、active-without-live-session=1、active issues without TURN=0、TURN holder not live=1、live wait streak high=0(由约 188 条噪音降到 2 条可判候选);tidal-echo 的 1 条 active node 仍被 project filter 隔离。实现后在同一组 count-only query 上复测并写进 PR。
- 步 4(全部带时间窗 + 活性范围):`mailbox` 只投影仍在 `sessions.status='running'` 集合里的 runner 收件——`QUEUED` 超 30min,或 `LEASED` 已过 claim 且 `created_at` 在最近 24h;已终结 execution 的陈年 lease 不再每 tick 重报。`turn_wake_outbox` 只看 active execution 的 `pending/sent` 超 15min未 ack;`dead_letter_alerts` 只看最近 24h 且 `state='pending'`的未结算行(此表全局,不过滤 project,发现按归属路由);`accepted` 是已有真实投递 receipt 的终态,不得重报。保留现行「Runner reports/PRs vs verdict claims」半步:对 active run 的 `workflow_node_pr_binding.head_sha` 与有效 git-head `workflow_claims.subject_digest`(`codex_approved`/`qa_passed`/`founder_approved`)做一致性候选检查。2026-08-18 PDT 修订 predicate 的生产 count-only 校准:live mailbox old queued=0、live recent expired lease=0、active unacked wake >15m=1、active bound-node head/claim mismatch=0;2026-08-19 复核的 recent deadletters=4 全是 `accepted`,加终态过滤后 pending=0。候选量从裸 expired lease 约 302 条降至 1 条。**时间戳格式逐表标注**(R1 LOW-11):`mailbox.*`/`dead_letter_alerts.*` 为 TEXT ISO、`turn_wake_outbox.*` 为 INTEGER 毫秒——TEXT 窗口用 `julianday(...)` 解析而非将含 `T/Z` 的 ISO 值与 SQLite `datetime()` 字符串裸比较,INTEGER 则用 epoch 毫秒;混用会静默空转。CI fixture 两种格式都要覆盖,并断言陈年 expired lease 不出现、recent accepted dead-letter 不出现、recent pending dead-letter 出现。
- **报告列 allowlist(正式 Codex review R1 MEDIUM)**:任何查询都禁止 `SELECT *`。`mailbox` 只输出截断后的 `id/to_agent` + `state/created_at/claim_expires_at`;`turn_wake_outbox` 只输出截断后的 `wake_id/execution_id` + `issue_id/state/created_at`;`dead_letter_alerts` 只输出截断后的 `id/recipient` + `source_kind/lead_id/project_name/dead_count/state/created_at`;verdict 对账只输出 issue/node/attempt/predicate 与 head digest 的前 8 位。永不读取/输出 `content`、`delivery_content`、`envelope_json`、`summary`、`claim_token`、capability/token/evidence 原文。CI 向每张表灌 sentinel secret,断言报告里零命中。
- 步 5(GitHub 半自动,**巡检面一律 REST**,R1 LOW-7:`gh pr list` 走 GraphQL,不用):`GH_REPO=<projectRepo> gh api 'repos/{owner}/{repo}/pulls?state=open&per_page=50'` + 同样带 `GH_REPO` 的 `gh api 'repos/{owner}/{repo}/actions/runs?per_page=5'`,只投影 PR number/draft/head8/updated_at 与 run id/status/created_at,打印**整仓最近活动时刻**。`gh api` **没有 `-R` flag**;这里用官方支持的 `GH_REPO` placeholder 解析,不依赖 cwd。Lead 对单个可疑 PR 的人工 `gh pr view --json` 下钻允许 GraphQL,它不属于周期巡检面、也不计入 FLY-1624 Bridge 预算。Discord 部分不进脚本(MCP 工具只在 Lead 会话里),骨架里留占位行指到 `fetch_messages`,并给**可执行的地址解析 + 可判定的选取规则**(R1 LOW-10):按 tick 名册 identifier 最多取 2 个、最近活动优先;先从与快照同一个 projects registry 用已 export 的 `PROJECT_NAME + LEAD_ID` 解析 `chatChannel`(不得假设未 export 的 `$CHAT_CHANNEL`),再用 `GET /api/chat-threads?issueId=<identifier>&channelId=<chatChannel>` 只从 Bridge 取 Discord `threadId` 地址,最后用 Discord MCP `fetch_messages` 读真消息/archive 状态。Bridge 只当地址簿,不采信其 `chat_threads` 作为状态真相。tick 只在名册非空时发出,故选取输入恒非空。
- 输出与落盘:先在报告目录同级临时文件生成 markdown 骨架,含逐步机器可读状态行 `STEP <n>: OK-CANDIDATE | FINDING-CANDIDATE | UNAVAILABLE(<原因>) | LEAD-JUDGMENT-REQUIRED`,再 `mv` 原子发布为本次报告路径;stdout 回显同一骨架并打印 `REPORT_PATH=<绝对路径>`。步 1(名册对账)、5(Discord + 「账面应有活动」判断)、6(处置)初始一律为 `LEAD-JUDGMENT-REQUIRED`;步 2 按全量 pane capture 预填 `OK-CANDIDATE/FINDING-CANDIDATE/UNAVAILABLE`,步 3/4 根据有界 predicate 预填 candidate。因此只要命令启动成功,即使 Lead 后续少做,也留下六行候选/未判定状态与逐 pane `action=REQUIRED`,不会把「有事实」误写成「已健康」。
- **fail-visible 不 fail-silent + 瞬态/结构分类**(R1 MEDIUM-5):sqlite 打开即设 `.timeout 3000`,失败做一次有界重试;仍失败 → 该步输出 `UNAVAILABLE(transient: <稳定token>)`(如 `sqlite_busy`;R2 LOW-1:原因必须归一为稳定 token 而非原始错误文本,否则「连续 2 tick」比对与 Linear 标题搜重会在易变字符串上碎裂,CI 断言 token 集)或 `UNAVAILABLE(structural: <原因>)`(表/列不存在、库打不开、gh 报错),继续收其余步。事实源故障仍以 0 退出并产报告;**用法错误或报告目录/临时文件/原子发布失败必须非零退出**,因为此时连 UNAVAILABLE 都无法形成持久产物,不得谎报成功。§7 的建单出口只对 structural 首现触发;transient 连续 2 个 tick 复现才升格建单——避免自愈性抖动铸工程 issue(告警噪音纪律)。
- 只读纪律:sqlite 一律 `file:...?mode=ro` URI + 有界 `LIMIT`;gh 固定两条 REST 调用(60min 节拍 × Lead 数,配额可忽略;不碰 FLY-1624 管的 Bridge GraphQL 预算)。
- 多仓项目 v1 只查项目主仓;从 projects.json 的真实字段 `projectRepo` 取 `owner/repo` slug(`projectRoot` 只用于本地仓路径),用 `GH_REPO=<projectRepo>` 解析 REST placeholders,不依赖 Lead 当前 cwd;见 §9。
- **安装接线**(R1 MEDIUM-4 + 正式 review LOW):新链接 `~/.flywheel/bin/flywheel-patrol-snapshot` 加入 `converge-flywheel-bin.sh` 的 **strict regime**。该路径会在缺失时通过 `strict_publish_link ... created` 原子创建,并同时提供 source sanity/shebang/exec 校验、漂移修复与 FLY-1389 temp/worktree-root 拒绝;不另造手工/一次性 installer。strict helper 现有 `cmux alert-chain` 专用人类文案需抽象成按名字区分的通用「managed executable」文案,但 `meta-alert.sh` 的既有 title/body 保持逐字节不变,不能让 snapshot 链路冒充 cmux 告警。`strict_alert(name,title,body,signature)` 必须使用显式入参完成改写且保留 caller 提供的详细 `body`(只替换其中 `alert-chain` 类词,不得用泛化模板覆盖),禁止隐式读取 caller 的 `link/src` locals。管理名单、`symlink_source_for`、strict name 与全部 trusted fake-repo steady-state fixtures/hermetic 正反测试必须同 PR 落地。当前会进入 strict symlink lane 的 trusted fixture 精确只有:`converge-fly1389.test.sh`、`fly1577-alert-arrival.test.sh`、`fly1577-cmux-bin-closure.test.sh`;三者的 fake source + healthy-link seed 都要补齐。`converge-flywheel-bin.test.sh` 与 `packaged-seams.test.sh` 的相关 fixture 显式为 temp/worktree shape,按现有 guard 跳过 symlink lane,不为本改动伪造 source。

CI(`scripts/__tests__/lead-patrol-snapshot.test.sh`,遵循目录现有命名法,R1 MEDIUM-3):用**真代码**建库(StateStore dist 建 teamlead.db、flywheel-comm dist 建 comm.db),灌最小 fixture,跑脚本断言:报告文件确实原子落盘且含六段、active/live 边界内三类步 3 finding 各有阳性对照、terminated run/terminal session 不得泄入、**双项目 fixture 证 project 过滤**、陈年 expired lease 不出现而 live recent expired lease 出现、recent accepted dead-letter 不出现而 recent pending dead-letter 出现、两种时间戳格式窗口阳性、secret sentinel 零输出、故意删表后对应步 `UNAVAILABLE(structural)` 而其余步照常、全空库输出 all-clear 骨架。schema 漂移由「真代码建库」天然抓住。**CI 接线**:放入 `script-tests-2` 的独立无条件 step(预计 <5s,同步更新该 job 的 step-seconds 注释),在尾部 FLY-1870 tripwire 之前;同时更新 `ci.yml` 字面枚举和 `scripts/__tests__/ci-structure.test.sh` 的 `expected_shard_tests["script-tests-2"]` 精确有序列表。该 shard 已执行 `pnpm build` 且安装 sqlite3,无需 suite 内重复 build。

## 5. tick 模板 v2(块 B,**本 PR 不启用**;保留为待 founder 认可的独立提案)

现行(founder-fixed,FLY-1687):

```
[patrol_tick] 巡检时间到。
按 Bridge 的账,你名下有 N 个未终结 runner(此名册是待核声明,不是结论):
- <identifier> [<exec8>] (<role>, <status>)
```

v2 独立草案(改两句话 + 首行带 tick 序号,仍零预判零指令;deny-list `check|verify|suggest|inspect|建议|怀疑|该查` 全不触):

```
[patrol_tick #<seq>] 巡检时间到。范围合同:检测=整机,处置=名下;六步与产出物合同见 runner-patrol-rules.md §0。
按 Bridge 的账,你名下有 N 个未终结 runner(此名册只是 Bridge 的待核声明,不是巡检边界,也不是结论):
- <identifier> [<exec8>] (<role>, <status>)
```

- **`#<seq>` 是本条 tick 的 lead_events 序号**(R1 MEDIUM-6):现行正文不带任何可锚定 id,报告与 tick 无法 1:1 对上。future v2 若获认可,seq 与措辞必须作为**同一份逐字提案**批准;`formatPatrolTick` 入参已有 `seq`,零新数据。founder design HTML §4 的 after box 必须与上面草案逐字一致并解释该序号用途,不能展示 A、实现 B。
- 「范围合同/文件指针」是**范围声明与导航**,不是预判或按-runner 指令;FLY-1687 的不变量(Bridge 不做预检/健康判断/逐 runner 指令)原样保留,渲染阴性对照(deny-list 断言)原样保留。
- **当前授权分支(Lead ruling `0e86df21-300c-4ce0-9cd8-dec4ff38a312`)**:`formatPatrolTick` 与 render/parity 测试保持 v1 **逐字节不动**。本 PR 只落规矩侧范围合同,报告名使用 `tickNA` + UTC 时间窗锚定。v2 留在 design HTML 等 founder 明确认可后由独立小改启用;PR 描述必须明说「v2 待 founder 认可,本 PR 未启用」。

## 6. 产出物合同(块 A 核心之一,治缺陷③)

- 每条 tick 必产一份报告:`~/.flywheel/patrol-reports/<leadId>/<UTC 时间戳>-tickNA.md`;当前 v1 正文无 seq,故以文件名 UTC 时间戳 ↔ tick `scheduled_at` 的时间窗锚定。future v2 获认可后才切换为 `-tick<seq>.md` 直接 join。
- 格式:六行 `STEP <n>: OK | FINDING | UNAVAILABLE(<原因>)`,每行后跟证据/判断;
  步 2 另有 `pane_count=N` 与恰好 N 行 `PANE_EVIDENCE ... action=... result=...`。
  `pane_count=` 头行无条件存在:tmux 整体不可用或确实零 Runner pane 时也写
  `pane_count=0`,让合法 UNAVAILABLE 仍能走确定性的完成门,不产生空整数 shell 错误。
  「全部健康」也要写全六行和全部 pane 的 `action=none result=clear`。快照脚本在
  采集结束时原子落盘候选骨架;Lead 打开 stdout 最后一行指向的 `REPORT_PATH`,
  定稿步 1/2/5/6、步 3/4 candidate 与每个 pane 的处置字段,不得删掉任一步/任一 pane。
- 报告的意义:**做 2 步和做 6 步从此在文件系统上可区分、可事后取证**。默认不发 Discord;有 FINDING 或 UNAVAILABLE 时按现行 reporting rules 上报(全部健康只留档,不制造告警噪音——FLY-1612/1687 的噪音纪律)。
- 报告锚定 tick:当前为 UTC 时间窗近似配对;future v2 后可升级成 seq 直接 join。Bridge 机器核「每条已结算 tick 是否有对应报告文件、含六行 STEP、且零残留 `LEAD-JUDGMENT-REQUIRED` / `*-CANDIDATE`」是 follow-up(§9),不在本单,不得把当前 v1 说成已有 1:1 key;**自动落下的骨架本身不是巡检完成证据**。

## 7. UNAVAILABLE 出口(治缺陷④)

- 任一步无法执行(命令报错 / 对象不存在 / 无法解析该步要求什么):报告记 `UNAVAILABLE(<原因>)`。建单口径分两类(R1 MEDIUM-5):**structural 首次出现**当场建 Linear issue;**transient**(SQLITE_BUSY/锁类,脚本已重试仍失败)只记报告,连续 2 个 tick 复现才升格建单。issue 精确标题 `[patrol-unavailable] step <n>: <稳定原因>`,以 `team=FLY + project=Flywheel + label=Flywheel` 自动进 Tadashi 队列。当前生产 projects registry 的 `flywheel.linear` 为 null,故不得用只在带 binding fixture 中成功的 `projectName=flywheel`。建前必须用 `GET /api/linear/issues?project=Flywheel&labels=Flywheel` 拉取非 terminal issues 并在本地 `jq` 做**精确标题**搜重;route 本身没有 `search`/`team` query。已有同标题 open issue 则在报告记录其 identifier 并禁止重复建单。**跳过而不留痕 = 违反合同**(写进规矩原文)。
- 新增第 0 步(自检):打开自己上一份报告;若上次有 UNAVAILABLE 而没建 issue,先补。这把「规矩只在事后生效永远发现不了它没生效」的缺陷类闭掉一半(另一半靠 follow-up 机器核)。

## 8. `runner-patrol-rules.md` §0 重写全文草案(块 A,核心交付;实现时可微调措辞,合同条款不可减)

> **范围合同**:检测范围=**整机**(全部 runner 窗口 + 项目仓库的外部真相);处置权限=**只覆盖你名下 runner**。tick 名册只是 Bridge 对「你名下」的待核声明,是步 1/3 的对账输入,**不是巡检边界**。跨界发现(别家 Lead 的 runner、无主窗口、全仓停摆)走步 6 上报,不越权处置。
>
> **产出物合同**:每条 tick 必产一份六步报告文件(路径与格式见上 §6;快照脚本会打印骨架与目标路径)。
>
> **UNAVAILABLE 出口**:见上 §7;跳过不留痕=违约。
>
> `[patrol_tick]` 仍是**纯闹钟**;Bridge roster 是**待核声明**。所有判断必须来自下列**独立信源**,不采信 Bridge 单方转述。
>
> **第 0 步(自检)**:run: `PATROL_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/patrol-reports/${LEAD_ID:?LEAD_ID required}"; PREVIOUS_REPORT="$(find "$PATROL_DIR" -maxdepth 1 -type f -name '*-tick*.md' -print 2>/dev/null | sort | tail -1)"; test -z "$PREVIOUS_REPORT" || sed -n '1,260p' "$PREVIOUS_REPORT"`;若上一份有 UNAVAILABLE 欠单,按步 6 补。**必须先完成这次上一报告自检,再启动新快照**;否则新骨架会变成“上一份”而使自检永远只读到本 tick。然后 run: `SNAPSHOT_OUTPUT="$(~/.flywheel/bin/flywheel-patrol-snapshot --project "${PROJECT_NAME:?PROJECT_NAME required}" --lead "${LEAD_ID:?LEAD_ID required}")"; SNAPSHOT_RC=$?; printf '%s\n' "$SNAPSHOT_OUTPUT"; test "$SNAPSHOT_RC" -eq 0 || exit "$SNAPSHOT_RC"; REPORT_PATH="$(printf '%s\n' "$SNAPSHOT_OUTPUT" | sed -n 's/^REPORT_PATH=//p' | tail -1)"; test -n "$REPORT_PATH" && test -f "$REPORT_PATH"`。即使原子发布失败也先回显已采事实,再保留非零;后续步骤共用这一份 `REPORT_PATH`,不得重复启动快照制造多份报告。
>
> 1. **名册核对(ground truth)** — run: `awk '/^## STEP 1$/{show=1; next} /^## STEP 2$/{show=0} show' "$REPORT_PATH"`。该段由快照内部的 `TMUX= tmux list-windows -a` 与 `TMUX= tmux list-panes -a -F '<pane_id>\t<session_name>\t<session:window_id>\t<window_name>\t<command>\t<dead>'` 生成;与 tick 名册对账。**整机 Runner pane 清单**精确定义为默认共享 socket 上、session name 以 `runner-` 开头**且**window name 以 Linear identifier 开头的所有 pane;不按 Lead 过滤、不取前 N 个。私有 Lead socket 与 `zsh`/`cmux-*` 等非 Runner scaffolds 不进停摆判断,但 window roster 仍用来发现无主/错名窗口;CI 必须用同 window name 的 `cmux-*` 镜像作阴性对照。若步 2 的 live pane 与快照名册不一致,立即 re-run: `TMUX= tmux list-windows -a`,并在报告注明采用快照时刻还是复核时刻读数。
> 2. **pane 实况** — run: `awk '/^## STEP 2$/{show=1; next} /^## STEP 3$/{show=0} show' "$REPORT_PATH"`。快照必须对步 1 的**每一个** Runner pane 运行一次 5s 有界 `TMUX= tmux capture-pane -p -S - -t <pane_id>`;零抽样、零 Lead 范围裁剪、零 `tail -40`。脚本不落原文,只落 `PANE_EVIDENCE pane=<id> target=<session:window_id> owner=owned|cross-boundary|unknown exec=<execution-id|none> capture_sha256=<sha> lines=<n> bytes=<n> state_sha256=<sha> last_change_epoch=<epoch> findings=<csv|none> action=<none|REQUIRED> result=<clear|UNSET>`。`target` 用 projects registry 枚举的所有项目只读 CommDB 的 `comm.sessions.tmux_window` 构建 machine-wide index,并精确映射 `execution_id/lead_id/project_name`:唯一命中当前 Lead = owned;唯一命中其他 Lead/项目 = cross-boundary(正常态不算 finding);零命中 = unknown finding;多重命中 = `UNAVAILABLE(structural: session_target_ambiguous)`。清单 pane 数、无条件存在的 `pane_count` 与 evidence 行数必须相等,任何 capture 失败或漏行都把步 2 定为 `UNAVAILABLE(structural: pane_capture_incomplete)`。
>
>   逐 pane 判据与处置命令:
>   - 整份 scrollback grep `You've hit your session limit|You've hit your usage limit|Claude usage limit reached`,但排除 `not your usage limit`;只在最近 live 区仍命中为 `LIMIT_LIVE`,仅历史命中为 `LIMIT_HISTORY`。`LIMIT_LIVE` 直读 reset 时刻;若 reset 已过且 `owner=owned`,run: `flywheel-comm send --project "$PROJECT_NAME" --from "$LEAD_ID" --to "$EXEC_ID" "patrol: usage/session limit reset has passed; resume now"`,再完整 capture 验证并落 `action=wake_sent result=<verified>`;跨界只在步 6 上报并落 `action=cross_boundary_reported`;reset 无法解析为 `UNAVAILABLE(structural: limit_reset_unparseable)`。
>   - 取最后非空状态行做逐字节 SHA-256。同 target 的 hash 有变化则 `last_change_epoch=本 tick`;没变化则继承上一报告;`now-last_change_epoch >= 3600` 标 `STALLED_60M`。名下 run: `flywheel-comm send --project "$PROJECT_NAME" --from "$LEAD_ID" --to "$EXEC_ID" "patrol: pane state has been unchanged for 60 minutes; report status and continue"`,再完整 capture 验证;跨界只上报。
>   - 最近 live 区命中 `Press Enter to confirm|Press Enter to continue` 或手册列出的 resume-menu 才标 `INTERACTIVE_MENU`;名下且手册明确允许 Enter 时 run: `TMUX= tmux send-keys -t "$PANE_ID" Enter`,随后完整 capture 验证并落 `action=menu_repaired`。未知菜单标 `UNAVAILABLE(structural: menu_unrecognized)`,禁止盲按;跨界禁止按键。
>   - clear 行由脚本封口为 `action=none result=clear`;任何 finding/UNAVAILABLE 初始为 `action=REQUIRED result=UNSET`,Lead 必须逐行填完。collector 只采集/判读,不自行发送消息或按键;Lead 只对 `owner=owned` 执行上面唯一命令。**“大概没问题”不是证据。**
> 3. **交接账(TURN belt = comm.db `three_stage_turn`;engine node table = teamlead.db `workflow_run_node`)** — run: `awk '/^## STEP 3$/{show=1; next} /^## STEP 4$/{show=0} show' "$REPORT_PATH"`(只读联查,按本项目 + active run/live session 过滤)。active running node 无 TURN 行 / active issue 的 TURN holder 不在 live execution 集 / active execution no_turn_streak 异常 → finding;历史 terminal 行不得重报。
> 4. **投递账 + verdict/receipt 一致性** — run: `awk '/^## STEP 4$/{show=1; next} /^## STEP 5$/{show=0} show' "$REPORT_PATH"`。该段只看 live runner 的 `mailbox` 超窗未结算、active `turn_wake_outbox` 未 ack、近 24h 且 `state='pending'` 的 `dead_letter_alerts`(已 `accepted` 的禁止重报),以及 active PR binding head 与有效 verdict claim subject 是否一致;只输出 allowlist 元数据,不得输出消息正文、envelope、summary、token 或 evidence 原文。有行 = 可能有没送到的唤醒/死信或 verdict 漂移,对照步 2/5 判。
> 5. **外部真相(整仓维度)** — run: `awk '/^## STEP 5$/{show=1; next} /^## STEP 6$/{show=0} show' "$REPORT_PATH"`。周期 patrol 采集面由 `GH_REPO=<projectRepo> gh api 'repos/{owner}/{repo}/pulls?state=open&per_page=50'` 和 `.../actions/runs?per_page=5` 的 REST 投影生成;看**整仓最近活动时刻**;全部 open PR 长时间零活动(如 >60min 且账面应有活动)是 finding(2026-08-17 全仓 1h49m 停摆类)。单个可疑 PR 的人工下钻可再 run: `gh pr view <n> --repo <projectRepo> --json state,mergeable,headRefOid,statusCheckRollup`;此人工操作不属于周期 patrol REST 预算。Discord 最多检 2 个 tick 名册 identifier、最近活动优先;先 run: `PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/projects.json}"; CHAT_CHANNEL_ID="$(jq -er --arg project "$PROJECT_NAME" --arg lead "$LEAD_ID" 'first(.[] | select(.projectName == $project) | .leads[] | select(.agentId == $lead) | .chatChannel)' "$PROJECTS_FILE")"`。每个 identifier 再 run(只解地址,secret header 只走 stdin): `IDENTIFIER='<FLY-XX>'; THREAD_JSON="$(printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS "${BRIDGE_URL:?BRIDGE_URL required}/api/chat-threads?issueId=$IDENTIFIER&channelId=$CHAT_CHANNEL_ID")"; THREAD_ID="$(printf '%s' "$THREAD_JSON" | jq -r '.threadId // empty')"; test -n "$THREAD_ID"`,最后 run(读外部真相): Discord MCP `fetch_messages(chat_id=$THREAD_ID, limit=20)`。核最新消息/archive 状态;Bridge 只当 thread 地址簿,不采信 `chat_threads` 转述作为状态真相。
> 6. **处置** — run(报告):打开 `"$REPORT_PATH"`,将六行候选逐项定稿为 `OK | FINDING | UNAVAILABLE(<稳定原因>)` 并写下证据;名下 finding 只能按步 2 的唯一命令或相应 emergency procedure 有界修复并留证。run(跨界配置):`PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/projects.json}"; TADASHI_BOT_ID="$(jq -er 'first(.[] | select(.projectName == "flywheel") | .leads[] | select(.agentId == "flywheel-eng-lead") | .botUserId)' "$PROJECTS_FILE")"; ROUNDTABLE_FILE="${FLYWHEEL_ROUNDTABLE_CONFIG_FILE:-$HOME/.flywheel/roundtable.json}"; ROUNDTABLE_CHANNEL_ID="${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}"; test -n "$ROUNDTABLE_CHANNEL_ID" || ROUNDTABLE_CHANNEL_ID="$(jq -er '.channelId | select(type == "string" and length > 0)' "$ROUNDTABLE_FILE")"; test -n "$ROUNDTABLE_CHANNEL_ID"`。这是现有 Claude Lead runtime 的权威解析顺序(env 显式值优先,否则 shared non-token `roundtable.json`;QA 可覆写 config file);解析失败则报告 `UNAVAILABLE(structural: roundtable_channel_unresolved)`,禁止猜 numeric ID。将同一 tick 的所有跨界 finding 聚合成一条 Discord MCP `reply(chat_id=$ROUNDTABLE_CHANNEL_ID, message="<@$TADASHI_BOT_ID> [patrol cross-boundary] <findings>; report: $REPORT_PATH")`,由 Tadashi 统一路由;每条相关 evidence 写同一 receipt。run(UNAVAILABLE 搜重,secret header 只走 stdin): `TITLE='[patrol-unavailable] step <n>: <稳定原因>'; DEDUP_JSON="$(printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS "$BRIDGE_URL/api/linear/issues?project=Flywheel&labels=Flywheel&state=triage,backlog,unstarted,started&limit=250&slim=true")"; DEDUP_RC=$?; TRUNCATED="$(printf '%s' "$DEDUP_JSON" | jq -r '.truncated // false')"; PARSE_RC=$?`。若 `DEDUP_RC != 0`、`PARSE_RC != 0`、`TRUNCATED` 不是 `true|false` 或为 `true`,报告追加 `UNAVAILABLE(transient: dedupe_unverified)`,**禁止建单**;否则 `EXISTING="$(printf '%s' "$DEDUP_JSON" | jq -r --arg title "$TITLE" '.issues[] | select(.title == $title) | .identifier' | head -1)"`,非空则把 identifier 记入报告且禁止重复建单;只有空且满足 structural 首现或 transient 连续 2 tick 时 run(建单): `PAYLOAD="$(jq -n --arg title "$TITLE" --arg description "patrol report: $REPORT_PATH" '{title:$title, description:$description, team:"FLY", project:"Flywheel", labels:["Flywheel"]}')"; printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS -X POST -H 'Content-Type: application/json' "$BRIDGE_URL/api/linear/create-issue" -d "$PAYLOAD"`。全仓停摆走同一条配置解析 + Tadashi mention 命令。run(完成门):`FINAL_STEP_COUNT="$(grep -Ec '^STEP [1-6]: (OK|FINDING|UNAVAILABLE\([^)]*\))$' "$REPORT_PATH")"; PANE_COUNT="$(sed -n 's/^pane_count=//p' "$REPORT_PATH" | tail -1)"; EVIDENCE_COUNT="$(grep -c '^PANE_EVIDENCE ' "$REPORT_PATH")"; case "$PANE_COUNT" in ''|*[!0-9]*) false;; esac && test "$FINAL_STEP_COUNT" -eq 6 && test "$PANE_COUNT" -eq "$EVIDENCE_COUNT" && ! grep -Eq 'LEAD-JUDGMENT-REQUIRED|-CANDIDATE$|action=REQUIRED|result=UNSET' "$REPORT_PATH"`。门失败就是本 tick 未完成,必须修报告或标 UNAVAILABLE,禁止用文字声称「大概完成」;无法理解这里任一命令本身也必须记 UNAVAILABLE,禁止静默跳过。

(§0 现有尾注「`runner_terminal_list` 只是内部起点、不采信 Bridge 单方转述、Lead 不得自建 timer」保留。)

## 9. 边界与不做什么(诚实边界)

- **不改** roster-empty 零 tick 门与非 spawning Lead 零 tick 门(FLY-1687 原设计;全机零 runner 时无人巡检,merged-PR 收尾停摆由 Bridge runner-ship probe 等既有机制兜)。
- **不做** Bridge 侧自动六步执行/自动判读(FLY-271/368 领域;LeadWatchdog 误报风暴史 FLY-193/218/220 是前车之鉴——pane 判读留给 Lead)。
- **不做** Bridge 侧「报告完整性机器核查」rider——作为 follow-up issue 由 Lead 随 PR 建(标题建议:`patrol 报告完整性 Bridge 核查`);验收必须是六行已定稿且零残留 `LEAD-JUDGMENT-REQUIRED` / `*-CANDIDATE`,骨架本身不算完成。本单先让违规**可取证**,再让它**可机器抓**。当前 v1 只能时间窗关联,future v2 后再升 seq join。
- 多 Lead 同时整机检测会重复发现同一跨界异常:相位已错开(`patrolTickOffsetMs`),队列端靠建单前搜重去重;v1 接受此冗余。
- 多仓项目 v1 只查主仓;插件 fork/skills 仓的外部真相留 follow-up。
- 报告文件留档不设自动清理(每 Lead 每天 ≤24 个小文件);满一个月后由日常清理单收编。
- Founder 增量里的「每个 pane」在本计划操作化为**每个 canonical Runner pane**:
  默认共享 socket 上 `runner-*` session + identifier window。`cmux-*` 是同一 Runner 的
  显示镜像,纳入会把同一状态重复 hash/处置;Lead 私有 socket 与 scaffold 不是 Runner。
  这不是按 Lead/项目/数量抽样,20 个 canonical Runner pane 仍全读。§11 验收使用同一口径;
  若 founder 明确要求镜像/Lead/scaffold 也逐 pane 读,那是扩大事实源种类的独立变更,不得
  在当前命令里含糊混入。
- **写路径边界**(R1 LOW-8 + 正式 review纠正):`~/.flywheel/patrol-reports/` 对 Claude Lead 可写;**所有 Codex Lead 形态(含 full-access 与 write-capable)都把 writable roots 钉在 projectRoot**,写不进该目录。生产当前所有 Codex-backed Lead 都 `canSpawnRunners=false`,收不到 tick;未来启用 spawning Codex dept Lead 前必须先按 backend 解析报告落点,否则禁止给它发 tick。
- 规矩/脚本生效方式:merge + 生产 `git pull` + installer symlink;规矩 bundle 在 Lead 启动时装载 → 需一次 Lead 重启波次(随下一次例行 restart-services 即可,不必专门重启)。

## 10. 已否决方案

| 方案 | 否决原因 |
|------|---------|
| 六步指令写进 tick 正文 | 违反 FLY-1687 founder 裁定(tick 零指令);规矩双写必漂移 |
| .md 里直接写全部 SQL,不建脚本 | 8+ 条多行 SQL 靠 Lead 逐条复制,schema 改名后 .md 静默腐烂;.md 与任何脚本双写 SQL 必漂移——收口成一个 CI 跑真库的脚本,规矩里每步只剩一条命令 |
| 全自动化六步(Bridge 执行+判断) | FLY-368 领域;pane 判读自动化=误报风暴前科;本单是规矩机制单 |
| 每 tick 报告发 Discord | 60min × N Lead 的 all-healthy 刷屏;告警噪音纪律(FLY-1612/1687)。报告落盘,FINDING/UNAVAILABLE 才上报 |
| UNAVAILABLE 只报给 Lead 的上级线不建单 | 「自动进入工程队列」要求结构化落点;口头上报会再次静默蒸发 |

## 11. 实施顺序(TDD)与验收

1. **RED**:扩展 `fly369-patrol-rule.test.ts`——断言 §0 含:范围合同锚点、产出物合同锚点、UNAVAILABLE 出口锚点、六步每步一条可执行命令(fenced/`run:` 标记)、Discord `threadId` 精确解址 route + `fetch_messages`、跨界 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` → shared `roundtable.json` 权威解析 + registry-derived Tadashi mention + `reply`、无 hardcoded roundtable numeric ID、无「裸抽象名词步骤」;另断言 founder 增量的 `list-panes -a`、`runner-*` session + identifier window 双条件、`capture-pane -p -S -`、limit/reset、`STALLED_60M`、`INTERACTIVE_MENU`、逐 pane action 完成门。**既有锚点显式清算**(R1 MEDIUM-2,FLY-1687 交付过「既有锚点不动」,本单是有意替换,不是漂移):保留的 founder 不变量锚——`纯闹钟`、`独立信源`、`待核声明`、`不采信 Bridge 单方转述`、`Lead 不得自建 timer`;有意改写的锚——裸 `"TURN belt"` / `"engine node table"` 字面(§0 重写改为「名词 = 具体表名」的对照写法,锚点断言同步改为断言表名与命令存在);实现 PR 里逐条列出改了哪些断言、为什么。现文件即 RED。
2. **RED**:`lead-patrol-snapshot.test.sh`(§4 的 CI 契约,真代码建库 + 双项目阳性对照)+ 加进 `ci.yml` 字面枚举。pane fixture 必须证明:列出的每个 Runner pane 都以 `-S -` 捕获、同 window name 的 `cmux-*` 镜像被排除、secret 原文不落报告、全 capture/状态 hash 与计数落盘、上一报告状态 hash 连续 1h 触发 `STALLED_60M`、limit 与 interactive menu 各有阳性、漏 capture 使步 2 UNAVAILABLE、逐 pane `action=REQUIRED` 使完成门失败。双项目 CommDB fixture 还要证明正常外项目 pane 映射为 `cross-boundary` 但不产生 finding、unknown/重复 target 才 fail-visible,跨界异常聚合一次而非逐 pane刷屏;完成门对 candidate、缺失/非数字 `pane_count` 都干净判否。
3. **GREEN**:写 `scripts/lead-patrol-snapshot.sh` + converge strict symlink;重写 §0;给 `qa_slot_start_lead()` 注入 slot-isolated DB/state env;修正 `strict_alert` 在 patrol 分支丢详细 caller body/隐式依赖 caller locals 的问题并加回归断言。按 Lead ruling `0e86df21-300c-4ce0-9cd8-dec4ff38a312` 走 fallback 分支:`formatPatrolTick` 与 render/parity 测试 v1 字节不动,报告用 `tickNA`/时间窗锚定。只有未来拿到 founder 对**逐字 v2(含 `#<seq>`)**的记录化认可后,独立 PR 才改 block B。
4. 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell harness。
5. 真机验收(实现节点/QA 节点):在生产库上跑一次快照脚本(只读),六段齐全;人为断一张表路径跑出 UNAVAILABLE 阳性;一次真 tick 走完六步产出报告文件。
6. Follow-up issues 随 PR 建:Bridge 报告完整性核查 rider;多仓步 5 覆盖。

**founder 增量验收清单(四项全为本单 blocking)**:

- [ ] 默认共享 socket 上每一条「session name 以 `runner-` 开头**且**window name 以 Linear identifier 开头」的 Runner pane 都有且只有一行 `PANE_EVIDENCE`;同名 `cmux-*` 镜像不重复计算,零 Runner 抽查。
- [ ] limit live banner 的 reset 已过会当场 `wake_sent`;无法解析会显式 UNAVAILABLE。
- [ ] 同 pane 最后状态行逐字 hash 连续 ≥1h 会 `STALLED_60M`,并 `wake_sent` 或跨界上报。
- [ ] `Press Enter to confirm` 类菜单按手册有界解卡并复核;每个 pane 都落「查了什么/发现什么/处置什么」,完成门拒绝 `action=REQUIRED`。

## 12. 风险

| 风险 | 缓解 |
|------|------|
| tick 模板 v2 需 founder 认可 | Lead 已裁定本 PR 保留 v1(`0e86df21-300c-4ce0-9cd8-dec4ff38a312`);缺陷②先由规矩侧范围合同压制,报告使用 tickNA/时间窗匹配。design HTML 的 v2(含 seq)只是未来独立提案,本 PR 不启用 |
| 快照脚本读 1.7GB 生产 teamlead.db 的负载 | 全部查询走既有主键/状态列 + `LIMIT`;只读 URI;60min 节拍单次运行,可忽略 |
| 全量 scrollback capture 随 pane 数/历史长度增长 | 2026-08-19 实测 20 Runner pane × 9 spawning Lead = 约 180 capture/h(取数命令见 §4);每 pane 5s 墙钟上限,clear evidence 自动封口,Lead 只处理异常行;报告只存 hash/count、不存原文;任何超时 fail-visible,不以抽样降级 |
| QA Lead 误读/误写生产 state | `qa_slot_start_lead()` launch manifest 强制注入 slot-local `TEAMLEAD_DB_PATH` 与 `FLYWHEEL_STATE_DIR`,且 `claude-lead.sh` 把非空 DB override 穿过 `env -i`;两层 shell contract test 禁止 `$HOME/.flywheel` 泄入 |
| 阈值(30min/15min/24h/60min)误标 | 实现时以真库分布校准并写进测试;报告里标 `*-CANDIDATE`,判定权在 Lead |
| Lead 不跑脚本、报告造假 | 本单先做到「可取证」;机器核查 rider 是显式 follow-up。造假与漏做从「不可发现」变为「可审计违约」 |

## 13. 设计评审记录

2026-08-18 的独立上下文 Claude 交叉评审是早期质量输入,不替代当前 Runner Contract 要求的正式 Codex design gate。

- **Round 1**:CHANGES REQUESTED — 1 HIGH(跨库 join 缺 project 过滤,生产实测 tidal-echo Lead 会每 tick 铸 124 条假 finding)+ 5 MEDIUM(FLY-1687 守卫锚点清算、CI 接线、installer 接线、SQLITE_BUSY 瞬态分类、报告↔tick join key)+ 5 LOW。11 条全部采纳并折入本计划(§4/§5/§6/§7/§8/§9/§11/§12)。设计判断 (a)–(e) 全 AGREE(带条件,条件已折入)。
- **Round 2**:**APPROVED**。R1 全部 11 条确认折入(reviewer 逐条独立复核,含代码级验证:`StuckEscalationEnvelopeLike.seq` 在 envelope 上「零新数据」为真;`[patrol_tick #<seq>]` 无消费者破坏;`turn_wake_outbox.created_at` 毫秒标注正确)。附 3 条非阻塞 LOW 建议,已折入 §4(transient 稳定 token、installer 同 PR 落地、删不可达 n/a 分支)。设计判断 (a)–(e) 全 AGREE。

- **实现节点授权裁定**(Lead reply `0e86df21-300c-4ce0-9cd8-dec4ff38a312`,2026-08-18 PDT):founder 尚未认可 v2,本 PR 必须保留 v1 正文;只落规矩侧范围合同、快照脚本、tickNA/时间窗报告与 UNAVAILABLE 出口。v2 作为独立提案等 founder 点头后再启用。
- **正式 Codex Round 1**(request `2f27d93b-1165-49d2-8d4d-2ab1257230cf`):CHANGES REQUESTED。2 HIGH 指出 active/liveness 未界定会在生产每 tick 铸约 188 条假 candidate,且 founder HTML v2 漏 `#<seq>` 与 plan 不一致;另有 step4 陈年 lease、secret projection、CI exact inventory、verdict crosscheck、Codex 写边界等 finding。全部按本轮实测收敛进 §4–§13;v2 HIGH 通过「HTML 补齐未来逐字提案 + 当前 PR 明确 v1-only」闭合。修订后必须开新 design gate/request 复审。
- **正式 Codex 复审通道**(gate `4ad779fc-fc8d-4f06-91db-cf72e104bc6f`):2026-08-19 前两个 request 因 reviewer 账号 weekly limit 非零失败;founder 切换 reviewer profile 后 request `0c29298b-5938-4cb5-aa82-1b153b1613e8` 于 Round 4 返回 **APPROVED**。7 条 MEDIUM/LOW advisory 全部采纳:搜重失败/截断 fail-close、后续机器核要求零未定稿 token、StateStore 默认路径对齐 runtime、bearer stdin、founder HTML 状态、tmux 时点分歧复核、发布失败仍回显事实。设计门已通过,进入 TDD。
- **Founder 增量正式复审**(gate `ce69f39a-d15d-4a8e-9940-a8e18e1bb5ab`,request `c5bd81f9-2311-4452-b4b9-961c44078903`):**CHANGES REQUESTED**。blocking HIGH `step2-founder-increment-missing-from-normative-draft` 指出 §4/§11 已写 founder 四项硬合同,但 §8 仍保留旧的「仅名下 + tail -40」,且完成门只查六行。已将 §8 改成默认共享 socket 全 Runner pane 清单、逐 pane `capture-pane -p -S -`、exact state hash/60min、limit reset wake、手册化 menu 解卡与 evidence/action 完成门。并采纳全部 non-blocking advisory:自检改为新快照前读 `*-tick*.md`;dedupe `jq -r` + `triage`;周期 REST/人工 `gh pr view` 边界;roundtable 从 env 解析并 fail-visible;QA slot DB/state 隔离;`strict_alert` 保留详细 body 且不依赖 caller locals;全量 capture 成本/范围显式化。修订后开新 design gate/request,不得复用本轮 question。
- **Founder 增量正式复审 Round 2**(gate `80c7baf1-445f-4762-a43a-1173bec5f492`,request `826084ef-0951-4751-bd4c-db981ee035af`):**CHANGES REQUESTED**。2 HIGH 证实:(1) `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 不在 Claude Lead body 且不是 roundtable 单值权威源;(2) machine-wide pane 用单项目 CommDB 映射会把所有外项目 Runner 铸成 unknown 假 finding。已改用 runtime 已有的 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` → shared `roundtable.json` 权威解析,并从 projects registry 枚举全部项目 `comm.sessions` 构建 machine-wide owner index;合法跨项目 pane 本身不告警,异常聚合一次上报。其余 advisory 全采纳:Runner pane 用 `runner-*` session + identifier window 双条件并加 cmux 阴性 fixture;成本重测为 20×9=180/h;QA DB override 穿过 `claude-lead.sh env -i`;§11 口径对齐并记录 canonical Runner pane 操作化;表名写成 `comm.sessions`;candidate regex 修正;`pane_count=0` 无条件产出且空/非数字干净判否。修订后再开新 gate/request。

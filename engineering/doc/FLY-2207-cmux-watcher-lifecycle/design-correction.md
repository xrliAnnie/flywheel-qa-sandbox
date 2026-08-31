# FLY-2207 设计修正附录(design-correction)— 第 4 病:cmux tab 生命周期

Issue: FLY-2207 (https://linear.app/geoforge3d/issue/FLY-2207/可见性watcher-cmux-watcher-进程生命周期三病查询超时累积死死了无人发现复活被-fly-913-误伤8-31)
日期: 2026-08-31
基于: plan.md(R3,codex-approved 3 轮,blob 0ff5370d)

> 本附录承载 plan 过审并绑定 design_review gate **之后**到达的范围增补
> (lead-instruction fdf37f7d-2c95-4bb4-8c95-1bc2146725b6,founder 19:15 抓的第 4 病)。
> 按流程以 design-correction 增量修正:**不改 plan.md 本体、不动 gate blob 绑定、
> 不回滚分支**;T6–T8 与 plan 的 T1–T5 同属 FLY-2207 implement 范围。

## 1. 第 4 病:cmux tab 的生命周期无人管(founder 实录 + 审计实锤)

两个 founder 面症状:

- **① 关单不收 tab**:issue 关掉/ship 后其 cmux tab 永不清理
  (实例:FLY-2162/2119/2071 挂两周;Lead 今天手清 5 个)。
- **② 重启波打断活工人 tab**:19:12 重启波扫掉 viewer/镜像 tmux 窗后,
  FLY-2178/2204/2205 三个**本体存活**的 runner 的 tab 变「暂不存在,等待重连」孤儿。

审计发现这不是「缺清理逻辑」——清理/自愈引擎一直在跑,而是**三条腿各断一条**:

### 1a. 清理链:freshness fence 的喂食断了 6 天,全舰零清理

- 事件清理有双保险 fence:`node_cleanup_freshness_allows`
  (flywheel-cmux-sync.sh:1325)要求存在一份**比清理 marker 更新**的 complete
  分类快照(`~/.flywheel/state/cmux-cleanup-snapshot`),否则永远等待:
  日志尾部整排「Node-presence fence waiting for a newer complete classification:
  FLY-2077-… / FLY-560-… / issue-…」即此。
- **实锤:该快照 mtime 停在 2026-08-25 17:20**(header epoch 1787703608)。
  自 8-25 起产生的一切清理 marker 都过不了 fence → **6 天全舰零清理**,
  与「tab 挂两周 + 手清 5 个」完全吻合。
- 快照唯一写点在 `reconcile_node_presence()` 尾部
  (`node_write_cleanup_snapshot || true`,:1788)——`|| true` 使其失败**静默**;
  且函数入口硬门 `RUNNER_EXPECTED_STATE==ok && RUNNER_NODE_TMUX_STATE==ok`
  依赖 Bridge loopback roster API 与 tmux 清点,任一长期不健康即整段 return 0,
  快照同样停更。8-26 前后恰有成簇的「runner roster API unavailable /
  node inventory unavailable」死信(见 1c)。停更的精确断点归 implement 段
  在此锚点上取证;设计上按「快照管线必须可观测」修(见 §2 T7)。

### 1b. 重连链:strict heal 对「无当代 receipt」一律拒绝,活工人也不例外

- 重启波扫掉 viewer/镜像窗后,workspace 的底层 tmux attach 目标消失,
  cmux 显示「暂不存在,等待重连」。
- watcher 有周期性 strict-view healing,但对**没有当代(current-generation)
  receipt** 的同名 workspace 一律保守拒绝:今天死信里成排的
  「cmux attach heal refused: Periodic strict-view healing preserved an
  unreceipted same-title workspace」(sync.sh:5435)。重启波恰恰会让 receipt
  过代 → **越是重启后越没人敢修**,Lead 只能两层手补
  (tmux link-window + cmux new-workspace)。

### 1c. 告警链:watcher 的全部告警结构性死信(no-token)——「管清理的那条腿」的断法

- `~/.flywheel/alert-deadletter/` 里 cmux_cleanup 死信累计 **1059 封**
  (今天 26 封),**queueReason 全部是 `no-token`**。
- 根因:lead-alert.sh 只会用 **env 间接引用**解析 bot token
  (`${!SENDER_TOKEN_ENV}` / `${!alertBotTokenEnv}`,lead-alert.sh:400-430);
  Lead 的 launchd wrapper 靠启动时 `source ~/.flywheel/.env`(0600)获得这些
  变量(claude-lead.sh 文档即此契约),而 **watcher 的 launchd 环境只有
  PATH + FLYWHEEL_CMUX_SUPERVISED=1**(plist EnvironmentVariables),
  autostart 从未 source secrets → watcher 发出的每一封告警必然 no-token 死信。
- 所以清理引擎的 fail-closed 拒绝记录(「unledgered workspace preserved」
  「attach heal refused」「roster API unavailable」…)从来没人看见 ——
  1a/1b 两条断腿因此隐形。**回答 Lead 的问题:cmux_cleanup 整天 dead-letter
  不是"清理腿"本身,而是清理腿的"可观测性腿";但它一断,前两条腿断了也无人知。**

## 2. 修法增补(T6–T8,并入 implement 范围)

### T6 watcher 告警腿修复(前置,其余两条的可观测性依赖它)

文件:`scripts/flywheel-cmux-autostart.sh`

1. supervised 分支在 `exec sync --watch` 前,按 Lead wrapper 的**既有机制**
   `source ~/.flywheel/.env`(仅 0600 且属主本人时;文件缺失/权限不符 →
   log 一行 ERROR 后照常启动 —— 告警腿降级不能反过来挡住 watcher 本体)。
   不在 plist 里放任何 secret;FLY-927 D2 的 fail-closed 语义
   (SENDER_TOKEN_ENV 设而不可解析 = 死信)不变。
2. 负向护栏:只动 supervised 分支;source 前后不覆盖已存在的同名变量语义
   (与 Lead wrapper 相同的直接 source);不新增告警 kind。
3. 测试:autostart 测试夹具加 case —— stub lead-alert 捕获环境,断言
   supervised 启动后 token env 可解析;env 文件缺失时 watcher 仍正常 exec。

### T7 关单自动收 tab(修 1a)

文件:`scripts/flywheel-cmux-sync.sh`

1. **快照管线修复**:以 8-25 17:20 断点为锚取证并修复停更根因;
   合同化为两条可测不变量:
   a. 每个 roster 健康且完成的 reconcile 轮,快照 mtime 必须推进
      (`node_write_cleanup_snapshot` 失败不再被 `|| true` 静默 ——
      失败经 `_alert_cmux_cleanup` 发声,复用既有 kind);
   b. 同一清理 marker 被 fence 连续阻挡 > 24h → 经(T6 修复后的)既有
      cmux_cleanup 告警发声一次(per-marker 去重)。fence 的保守语义本身不变。
2. **终态驱动**:closed/shipped issue 的 workspace 走既有
   `fetch_recent_terminal_runner_roster` → terminal 分类 → 既有清理路径;
   本附录不新造清理器,只把断粮的喂食链修通。
3. 验收:关单后其 tab 在 ≤2 个 conservative-cleanup 周期(≈10min)内收走;
   hermetic 测试用隔离 env(plan T5.4 的缝隙枚举)+ 伪造 terminal roster 断言。

### T8 重启波后自动重建 viewer 窗 + tab 重连(修 1b)

文件:`scripts/flywheel-cmux-sync.sh`

1. strict-view healing 增加一条**正身份优先**分支:同名 workspace 虽无当代
   receipt,但能以**精确证据**绑定到一个存活 execution
   (node registry 在册 ∧ 全局 tmux 存在恰一个携带该 execution 精确
   `@flywheel_exec_id` option 的窗口)→ 执行既有 ensure/view 重建原语:
   重建 viewer 窗(tmux link-window 族)+ 以当代 generation 重铸 receipt +
   重连 workspace surface —— 即把 Lead 的两层手补代码化,且仅在正身份成立时。
2. 每 workspace 每 generation episode 至多自动重建一次(复用既有 episode
   记账形态);二次失败 → 经既有 cmux_cleanup 告警发声。无精确身份的同名
   workspace 维持既有 fail-closed(拒绝 + 发声)。
3. 验收:重启波(隔离台架内模拟扫窗)后,存活 runner 的 tab 在 ≤1 个
   scan 周期内自动重连,founder 无感;无身份孤儿仍不被自动动。

### 与 plan T1–T5 的关系

- T6 是 T7/T8 可观测性的前置,也独立修复 patrol(plan T3)升级链之外的
  shell 侧告警投递(两者互补,不重叠:plan T3 走 Bridge 内 sink,
  T6 修 watcher 自身 shell 告警)。
- T7/T8 都是「修既有引擎的断腿」,不新增清理器/守护层/告警 kind,
  与 plan「只删不加」基调一致。
- 实施顺序:T6 → T7/T8(并行)→ 汇入 plan T5 的 hermetic QA 面。
- 回滚边界:三者各自独立可 revert;T8 的重建分支带
  `FLYWHEEL_CMUX_REBIND_DISABLED` env 杀开关(登记 truth.ts),
  设置后回到纯 fail-closed 现状。

## 3. 验收增补(并入 plan §5 对照表)

| 验收(lead-instruction fdf37f7d) | 证据 |
|---|---|
| 关单自动收 tab | T7.3(≤2 个 conservative-cleanup 周期) |
| 重启后自动重建 viewer 窗 + tab 重连,founder 无感 | T8.3(≤1 个 scan 周期;无身份孤儿不动) |
| cmux_cleanup dead-letter 归因 | §1c 已闭合(launchd env 无 token;T6 修复)+ T7.1a 让快照管线失败可见 |

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

文件:`scripts/flywheel-cmux-autostart.sh`(或 lead-alert.sh 的受信自载通用化,二选一见下)

1. **最小投影,不整包继承**(Codex R4 #5):裸 `source ~/.flywheel/.env` 不
   export、还会覆盖继承值;`set -a` 又会把全部 secrets 注入长命 watcher 及其
   所有 tmux/cmux/curl 子进程。改为二选一(implement 时按代码现状取更小者):
   a. 复用/通用化 lead-alert.sh 既有的隔离受信 env 自载(现仅 `--lead system`
      生效)使 watcher 的告警调用路径可走同一自载 —— secrets 只进短命的
      lead-alert 进程;或
   b. autostart supervised 分支**只 export 本告警路由需要的变量**
      (unified channel、sender selector、被选中 token),已继承的同名变量
      **优先保留**,不整包 source。
2. 安全校验与降级:env 文件缺失 / 非常规文件 / symlink / 属主或权限
   (0600)不符 / 解析失败 → log 一行 ERROR 后**照常 exec watcher**
   (告警腿降级绝不挡住 watcher 本体)。不在 plist 里放任何 secret;
   FLY-927 D2 fail-closed 语义(SENDER_TOKEN_ENV 设而不可解析 = 死信)不变。
3. 测试(Codex R4 #5 的证据面):env 文件用**裸非 export 赋值**写成;
   断言经 supervised 启动后一次真实(stub 传输)告警不再 no-token 死信;
   已继承的同名变量覆盖被保留;缺失/不安全/symlink 各得 ERROR 且 watcher
   照常 exec;**无关 secret 不出现在 watcher stub 的环境里**(最小投影证明)。

### T7 关单自动收 tab(修 1a)

文件:`scripts/flywheel-cmux-sync.sh`

1. **快照管线修复**(Codex R4 #4 对齐实现):以 8-25 17:20 断点为锚取证并
   修复停更根因;合同化为两条可测不变量:
   a. 每个 roster 健康且完成的 reconcile 轮,必须产出**原子替换的、结构合法的
      complete 快照**,其 `(snapshot_epoch, round_epoch, round_sequence)` 按
      fence 的比较序**严格推进** —— 断言对象是 header 与 fence 判定,
      mtime 仅作诊断;`node_write_cleanup_snapshot` 失败不再被 `|| true`
      静默,失败经 `_alert_cmux_cleanup` 发声(复用既有 kind);
   b. **快照断供 episode 告警**(替代 R4 前的 per-marker 方案,避免风暴且
      不受 `_alert_cmux_cleanup` 64 签名/代上限影响):fence 存在被阻挡
      marker 且快照持续未推进 > 24h → 发**一条** episode 告警(载最老
      marker 年龄 + 被阻挡计数),以持久记账去重,仅在快照有效推进后
      重新武装。fence 的保守语义本身不变。
2. **终态驱动 —— 权威边界显式化**(Codex R4 #3):现状因果链是
   pane-died/window-unlinked 事件与 conservative 扫描铸 marker,
   terminal roster 只喂节点摘要、**不铸 marker**;且 `process_pending_cleanups`
   在源 pane 仍活时会撤销 marker。修法两腿并走:
   a. 主腿:修通快照后,既有事件/conservative marker 路径即恢复对
      「pane 已死」的关单 tab 的清理(2162 族的主形态);
   b. 显式桥 —— **完整的 terminal teardown 事务,不是只铸 marker**
      (Codex R5 #1:普通 marker 会被 `process_pending_cleanups` 的
      pane-alive 撤销;`cleanup_workspace_for` 也不杀活的源 window,
      additive 扫描还会把 tab 建回来):
      对连续 N 轮(默认 3)complete terminal 观测、且 complete active
      roster 证明该 exec 已不在活册的 execution:
      ① 持久记账精确 terminal episode;
      ② mutation-time 重验全套(terminal 证据、tmux generation、
      session/window id、精确 `@flywheel_exec_id` option、pane 存活态、
      mirror title、唯一 workspace 所有权);
      ③ 执行**精确的 guarded 源 window teardown**(或调用既有精确 close
      authority)并**验证源 window 已消失**;
      ④ 之后才进入普通 marker/close-request 路径收 workspace。
      崩溃重放:teardown 与 marker 投递之间以 episode 记账续跑;
      hook 丢失时由 conservative 扫描兜底。
      —— 这是一条新的、有界的 teardown authority,明说不藏。
3. 验收:关单后其 tab 在 ≤2 个 conservative-cleanup 周期(≈10min)内收走;
   hermetic 测试用隔离 env(plan T5.4 的缝隙枚举),触发链用**真实机理**
   (杀死 fixture 源 pane / lingering pane + terminal 行)而非仅伪造 roster 应答;
   显式桥的 QA 四断言(Codex R5 #1):terminal 行不被「pane alive」撤销、
   源 window 确实消失、workspace 收走、下一个 additive 扫描不再建回。

### T8 重启波后自动重建 viewer 窗 + tab 重连(修 1b)

文件:`scripts/flywheel-cmux-sync.sh` + 活跃 flag 注册表(kill 开关登记,
truth.ts 只是文档面,注册/漂移测试随注册表走;Codex R4 #2)

1. **双侧正身份,缺一不修**(Codex R4 #1:仅源侧身份会把 founder 手开的
   同名 tab 误当成 Flywheel 的):
   - **源侧 —— 全 title 唯一候选**(Codex R5 #3:registry 的 last_mirror
     不唯一,同名重试可产生两行各自有效的候选,选谁都是猜):以 workspace
     title 为界要求**恰一个**当前候选 —— complete active roster 中恰一个
     execution ∧ registry 中恰一行 `last_mirror` 等于该 title ∧ 全局 tmux
     恰一个携带该 execution 精确 `@flywheel_exec_id` option 的存活窗口;
     mutation-time guard 里**重算**该候选计数;两个活 exec 映射同 title →
     拒绝 + 既有 kind 发声(负向测试钉死);
   - **workspace 侧**(所有权,任一成立):
     (i) 首选:既有 birth-record/UUID 收养路径(`adopt_birth_candidate` +
     `_birth_adoption_guard`)对该精确 ref 的收养证据成立;
     (ii) 备选(重启波毁掉 birth 证据时):存在**唯一**的过代 committed
     receipt,其存储的 workspace UUID 与当前精确 ref/UUID 仍匹配,且无
     任何当代/过代竞争主张。
   - 两侧齐备才修;否则维持既有 fail-closed(拒绝 + 发声)。founder 手开的
     同名 workspace 没有 birth/receipt 证据,天然落在拒绝侧。
2. **崩溃安全的重建事务 —— 三账本显式组合**(Codex R4 #2 + R5 #2:
   `create_or_replace_view_session` 的 WAL 只覆盖 tmux viewer 构建段、
   返回前即删,receipt 走 ledger、attach 走 attach-heal state,三者天然
   分账):把 viewer 构建 WAL、UUID receipt ledger、attach-heal state
   **显式组合成幂等重放协议**,以持久的 rebind-episode 记账贯穿:
   ① **首个 mutation 之前**先持久写入全 key intent;
   ② 恢复遗留构建 WAL → 证明双侧权威 → 经 WAL 协议建/验 viewer 窗 →
   收养/prepare 精确 UUID 绑定的 receipt → guarded attach → 验证 surface →
   持久记成败 → 清/压 episode;
   ③ 崩溃重放按 episode + 各账本推进到下一未完成步,不重复已 commit 步。
   **每次 tmux/cmux mutation 前即时重验**:cmux generation + 精确 ref +
   workspace UUID/title + 源侧唯一候选重算;tmux generation + 精确源
   session/window id + exec id + pane 存活。
3. **尝试语义**(消除 R4 自相矛盾 + R5 #2 的 intent 消费时点):持久 key =
   (cmux generation, workspace UUID/ref, tmux generation, exec id);
   区分两种失败:**未发生任何 mutation 的前置失败 = retryable**
   (intent 不消费,下一轮可重试);**已发生 mutation 后的失败 =
   terminally latched**(发声既有 kind + fail-closed,直到 key 任一分量
   变化才重新武装);成功/失败先持久落账再清/压分支。
   kill 开关 `FLYWHEEL_CMUX_REBIND_DISABLED`(活跃 flag 注册表登记 +
   注册/漂移测试),设置后回到纯 fail-closed 现状。
4. 验收与负向测试(Codex R4 #1/#2 + R5 #2/#3):重启波(隔离台架内模拟
   扫窗)后,存活 runner 的 tab 在 ≤1 个 scan 周期内自动重连,founder 无感;
   负向全覆盖:founder 同名 workspace 不被接管、重复 ref、重复 exec-id 窗、
   **两个活 exec 映射同一 mirror title(必须拒绝)**、过期 registry 行、
   window id 被换、cmux/tmux 任一侧换代翻转、kill 开关生效;
   崩溃注入覆盖**全部账本边界**:构建 WAL 删除点、receipt prepare/commit、
   attach 发送、发送后验证、episode 记账持久化 —— 不只
   create_or_replace_view_session 内部的边界。

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

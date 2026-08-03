# FLY-1605 cmux workspace 名字显示成原始命令 — 探索

Issue: FLY-1605 (https://linear.app/geoforge3d/issue/FLY-1605/cmuxfounder-直令-workspace-名字显示成原始命令1621-两条-spawn-路径缺-rename-调用-刷新现存名字)
日期: 2026-08-02
基于: 无

## 1. Founder 症状

「他现在显示全部都是错的,非常的 annoying」— cmux 侧栏大量 workspace 显示成整条启动命令
`env -u TMUX tmux attach -t '=cmux-...'`,不是可读名。issue 建立时读 session JSON 数出 21 个
workspace、16 个 title = 原始 attach 命令,只有 3 个正确(LEARN-219-runner-…、FLY-1597-runner-…、
personal-assistant-belle-lead)。

## 2. Issue 假设 vs 实证审计(假设被推翻)

Issue 的推断是「两条 spawn 路径(Lead / DAG design 节点)缺 rename 调用」。**代码 + 日志 + 真机实验
审计推翻了这个假设**:

- 全仓 grep:生产代码里唯一调用 `cmux new-workspace` 的位置是
  `scripts/flywheel-cmux-sync.sh` 的 `create_workspace_for_window`(常驻 watcher)。Lead 和
  design 节点的 workspace **都**经这一条路创建 — 不存在「各自 spawn 路径漏调 rename」的第二/第三条
  create 代码路径。v2 launcher(`packages/v2-host/src/tmux-runner-launcher.ts`)只投递
  create 事件(FLY-1550 ③),不直接建 workspace。
- `create_workspace_for_window` 自 FLY-1550 起 **同时**调用 `rename-workspace` 和
  `rename-tab`(Codex R1 MEDIUM-4:tab 标题才是 founder 验收面)。调用本身不缺。

真正的病灶是下面两个(见 research.md 的完整证据链):

### 根因 A:watcher 的 mutator lease 因时区切换自失效 → 每个新 create 被回滚 → 无名 workspace 死循环

- lease 的 incarnation 用 `ps -o lstart=`(**本地时区渲染的进程启动时间字符串**)绑定进程身份。
- 昨夜机器时区从 PDT 切到 MDT(founder 移动中,今天 `date` = MDT;lease owner 文件里记录的启动时刻
  渲染是 `10:45:06`,现在同一进程 `ps` 渲染是 `11:45:06`,恰差 1 小时)。
- 时区一变,watcher **对自己 lease 的自断言**(`assert_or_reuse_owned_lease` →
  `_owner_process_matches` 重新渲染 lstart 并比对)永久失败 → 所有 ledger 写入被拒
  (`ledger upsert refused: current process does not hold the verified mutator lease`,今晨
  02:43 起共 183 次)。
- strict create 路径里 ledger prepared 行写不进 → **整个新建的 workspace 被回滚** → 下一轮
  additive sweep 又发现「没有这个 title 的 workspace」→ 再建 → 再回滚,每 ~80s 一轮
  (FLY-1603 循环 83 次、tidal-echo 两个 Lead 73/74 次、eng-lead 30 次…)。
- 部分回滚失败(`rollback failed … manual resolution required`)留下**永久的无名孤儿
  workspace**(现存 6 个 raw 标题的 design 重复项 + 当时的 Lead 孤儿),这就是 founder 看到的
  原始命令行。

**追记(第二个 design session,2026-08-02 17:10 活体复核)**:owner 文件 incarnation
`Sat Aug 1 10:45:06 2026`(Pacific 渲染)vs 当下 `ps` 渲染 `Sat Aug 1 11:45:06 2026`
(机器现为 America/Edmonton)——自断言**此刻仍在失败**,故障不是历史事件而是进行时:
从时区切换起每个新 spawn 的 workspace 都会命名失败,raw design 重复项已由 6 个增至 8 个。
修复上线前该数字会继续涨。

### 根因 B:两个显示面、tab 标题从未被追溯刷新

真机实验(两次判定性 spike,见 research.md §4)确认 cmux 有**两个独立的标题面**:

| 显示面 | 绑定字段 | 由哪个命令设置 |
|---|---|---|
| 侧栏行 | workspace title(session JSON `customTitle`) | `cmux rename-workspace --workspace <ref> <title>` |
| 顶部 tab 条 + macOS 窗口标题 | surface/tab title(session JSON `panels[].customTitle`,未设时回落到 processTitle = 原始 attach 命令) | `cmux rename-tab --workspace <ref> <title>` |

- FLY-1550 之前建的 workspace(全部 Lead)只有 workspace 名、没有 tab 名;FLY-1550 只修了
  **create 时**的 tab 命名,没有任何机制**追溯刷新存量** workspace 的 tab 标题。
- issue 里「16 个 title = 原始命令」数的正是 session JSON 里的 panel/tab 标题(3 个好的恰好是
  FLY-1550 之后、时区切换之前完整走完 create 的);今晨 Lead 侧栏行恢复可读是因为有人(Cass 救火)
  手工 `rename-workspace` 了一批 — 手工 rename 同时也实证了「把 workspace 改成窗口名后,
  按 title 的存在性检查通过,create 死循环就停」(×4 例)。

## 3. 问题空间:要治什么

1. **止血根因 A**:lease 自断言不能依赖会随时区/时钟漂移的 wall-clock 渲染 — 否则任何一次
   founder 带着机器跨时区,整个 cmux 命名/清理管线就静默瘫痪。
2. **补根因 B**:需要一个**幂等的 title reconcile**,把「tmux 窗口名(单一真相源,已经是 FLY-1255
   规范名:Lead=leadId、issue 节点=FLY-XXX-<node>-<backend>)」对齐到两个显示面,既治存量
   (16 个错名 + 6 个孤儿重复)也防再犯。
3. **当场刷新存量**(scope 3):merge + watcher 重启后第一轮 reconcile 自动完成,不需要一次性人工
   脚本。
4. **变异判据**(scope 4):去掉 reconcile 的 rename 调用 → 测试红;lease 修复去掉 → 模拟时区漂移
   的测试红。

## 4. 方向选项

### 根因 A(lease)
- **A1(推荐)**:自断言去 wall-clock — `assert_or_reuse_owned_lease` 里 pid+incarnation+nonce
  三元组与进程内存值全等即证明「owner 文件就是我写的」(nonce 随机且只存在于本进程内存,PID 复用
  伪造不了),不再重新渲染 `ps lstart` 比对。跨进程校验(probe/classify/_pid_is_watcher)保留
  渲染比对但固定 `TZ=UTC LC_ALL=C`,消除时区依赖。
- A2(只固定 TZ,不动自断言):仍受 NTP 时钟阶跃影响,且已运行进程遇渲染变化照样自锁。不彻底。

### 根因 B(reconcile)
- **B1(推荐)**:watcher 内新增 `reconcile_workspace_titles` sweep,方向为「从 tmux 窗口出发」
  (只碰能映射回自家窗口的 workspace,绝不动 founder 的私人 tab):title 已对则只补 tab 名;
  title 是原始命令且 attach 目标解析回本窗口 → adopt(双面 rename),多余重复项 close。
  挂在 `sync_additive`(tick%4)且先于 missing-workspace 扫描,`--once` 同样跑。
- B2(一次性修复脚本 + 只修 create 路径):治不了「下一次再产生存量」的场景(watcher 曾长期
  只设 workspace 名),且多一个入口违反单一 create/rename 收口原则。

## 5. 不做(边界)

- 不动 FLY-1596 的 legacy grouped → A1 迁移(日志里 `legacy grouped migration refused` 一族
  与本单无关,只管 title)。
- 不改 cmux 本体(第三方应用);侧栏/顶栏绑定哪个字段是实验测得的行为事实,不去改它。
- 不动 tmux session 哈希机器名与 `cmux-` view session 命名(机器身份保留)。
- 不碰 FLY-1602 的 Lead 身份 lease(claude-lead.sh/restart-services 一族)— 那是另一个 lease,
  同型(多真相源打架)不同体。

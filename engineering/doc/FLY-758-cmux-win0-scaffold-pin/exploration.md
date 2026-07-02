# FLY-758 cmux workspace 钉在 win0 空壳 — 探索

Issue: FLY-758 (https://linear.app/geoforge3d/issue/FLY-758/cmux-workspace-钉在-win0-空壳没跟-runner-的真-window-geo-436-空-pane关掉又重生cass)
日期: 2026-07-02
基于: 无

## 1. 现象回顾

Annie 在 cmux 里点 GEO-436 workspace 只看到空 pane,关掉又重生一个空的;但 `tmux attach` 能正确看到 runner 内容。Cass 已诊断:

- `=cmux-GEO-436-…` session 有 2 个 window:**win0 = 空 zsh(scaffolding)、win1 = runner 真内容(active)**。
- `tmux attach` 跟 active window → win1 ✅;**cmux 钉死在 win0** → 空 pane,关掉重挂还是 win0。
- 对照 Sub 的 LEARN-150:同样有空 win0、内容在 win6,但 cmux 显示正确 ⇒ **空 win0 本身正常,anomaly = cmux 给 GEO-436 pin 错了 window**。

## 2. 代码审计 — win0 从哪来(已确认)

**Runner 侧 · `packages/claude-runner/src/TmuxAdapter.ts`**

- `ensureSession()`(L1039-1045):base runner session 不存在时用
  `tmux new-session -d -s <runner-project>` 创建。tmux **强制**给每个新 session
  自带一个默认 window = 空登录 shell(本机 = `zsh`)= **win0**。
- `execute()`(L466-480):每个 runner 用
  `tmux new-window -P -F '#{window_id}' -t =<session> … -n <windowName> …` 起在
  **自己的 window**(win1、win2…)。runner window 名恒为
  `<issueId>-claude-<title>`(`buildWindowLabel`,`tmux-naming.ts`),**绝不叫
  `zsh`/`bash`**。

⇒ win0 = 白送的空壳、从没被 runner 用过(issue 描述完全属实)。

**cmux 展示侧 · `scripts/flywheel-cmux-sync.sh`**

- 为每个 agent window 建一个 **grouped linked session** `cmux-<window_name>`:
  `tmux new-session -d -t <source_session> -s <view_session>`(L1833)。grouped
  session 与 source 共享**全部** window(含空 win0),但各自有独立的
  current-window 指针。
- cmux workspace attach 到该 linked session:
  `cmux new-workspace --command "tmux attach -t '=cmux-<window_name>'"`(L1864)。
- cmux-sync **已经在努力**跟真实 window:
  - create 时的 ready-gate:`select-window -t "=<view>:=<window_name>"`(L1844),
    失败就 defer 不建 workspace。
  - `refresh_linked_sessions`(L1935):每个 additive/bootstrap pass 按 **live
    window-id** 重新 `select-window`,修正 stale current-window 指针。
  - `select_live_view_window`(L1620)/ self-heal 系列同理。

⇒ `get_tmux_agent_windows`(L294)过滤掉 `|zsh`/`|bash`,所以 cmux-sync **不会**给
win0 单独建 workspace。观察到的 `=cmux-GEO-436-…` 是 GEO-436 window 的 linked
session,只是它的 **current-window 卡在了 win0**,cmux attach 进去就是空 pane;
关掉重挂 = 再 attach 同一 linked session,current-window 还是 win0 → 还是空。

## 3. 为什么会卡 win0(hypothesis,生产竞态,无法在本地复现)

cmux-sync 明明有 ready-gate + refresh 两道保险,理论上不该停在 win0。可疑竞态:

1. **grouped session 创建瞬间的 current-window 继承**:`new-session -t source`
   时,新 grouped session 的 current-window 继承自 source 当时的 active window。
   若那一刻是 win0,而后续 ready-gate/refresh 因某种原因没生效,就停在 win0。
2. **window 名漂移**:runner window 建出来叫 `<issueId>-claude-<title>`,之后
   `allow-rename on` + Claude `--name`(TmuxAdapter L698、L250-252 注释)可能改名。
   若 linked session 是按旧名建的、window 后来改了名,`refresh_linked_sessions`
   用 `cmux-<当前名>` 找不到旧 linked session → 跳过 → 旧 session 永远停 win0。

这两条都需要生产 cmux + 活 GEO-436 环境才能坐实,而 issue 明确 **"别动 GEO-436 的活
runner"**,且 cmux 竞态无法在 CI/本地稳定复现。对照 Sub(win0 在、cmux 正常)说明这
是**偶发竞态**,不是必现逻辑错 —— 用"修 cmux-sync pin 逻辑"去追一个抓不到的竞态,
风险高、验证难。

## 4. 修法方向对比

issue 给了两个方向:

**方向 1 — 修 cmux pin 逻辑(cmux-sync 侧)**
- 让 pin 永远跟 runner 真实 window / 按名字匹配,不 pin win0。
- 问题:cmux-sync 已经在做这件事;残留 bug 是抓不到的偶发竞态,补丁是**推测性**的,
  且只能靠生产 cmux 验证(无法单测),不确定能不能覆盖真正的触发点。

**方向 2 — spawn 时消灭 win0 空壳(runner 侧,根治)⭐ 推荐**
- runner base session 里**根本不留**那个从没用过的空 win0 → cmux/cmux-sync **结构性
  地**不可能再 pin 到空 win0,不管底层是哪种竞态触发的。
- 实现:`TmuxAdapter.execute()` 里 runner `new-window` 成功后(已拿到 `windowId`),
  若 base session **≥2 个 window** 且 **index 0 是纯默认 shell**(名为 `zsh`/`bash`/
  `sh` 且 pane 跑登录 shell),就 `kill-window` index 0。
  - 守卫:runner window 名恒为 `<issueId>-claude-…`,**绝不**是裸 shell 名 ⇒ 永远
    不会误杀 runner window。
  - 幂等 + best-effort:失败不阻塞 spawn;win0 一旦被清,后续 spawn 找不到 index-0
    裸 shell → no-op。
  - **只作用于 runner session**(`execute()` 只建 `runner-<project>`),Lead 的
    `flywheel` session win0 不碰。
  - 只在**当前 spawn 自己的 window 之后**杀,永远保证 session ≥1 个 runner window,
    绝不会杀成空 session。
- 可单测(TmuxAdapter.test.ts 已有 mock execFileFn 记录 calls 的框架):断言
  new-window 后有 list-windows,且满足条件时 kill-window 打向 index-0 zsh。

## 5. 推荐 + 待 Lead 确认

**推荐方向 2** 作为根治,理由:(a)确定性地消灭失败模式,不依赖复现生产竞态;
(b)最小改动、单文件、可单测;(c)不碰 Lead session、不碰活 runner、字节兼容(裸
shell 检测未命中就 no-op)。issue 本身也把它列为合法修法。

**scope 边界(默认不做,除非 Lead 要)**:方向 1 的 cmux-sync 加固(如 refresh 时
额外确保 linked session 不停在裸 shell window)可作为 belt-and-suspenders,但属推测性、
增复杂度,倾向 backlog。

**待 Lead 拍板的点**:是否认可"方向 2 单独根治、不追 cmux-sync 竞态补丁"这个 scope。

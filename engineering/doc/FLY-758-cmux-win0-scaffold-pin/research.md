# FLY-758 cmux workspace 钉在 win0 空壳 — 调研

Issue: FLY-758 (https://linear.app/geoforge3d/issue/FLY-758/cmux-workspace-钉在-win0-空壳没跟-runner-的真-window-geo-436-空-pane关掉又重生cass)
日期: 2026-07-02
基于: exploration.md

## 1. 结论(Lead 已批方向 2)

根治:在 runner spawn 时消灭从没用过的 win0 空壳,让 base session 只含真实 runner
window。cmux/cmux-sync 结构性地不可能再 pin 到空 win0,不依赖复现生产竞态。
方向 1(cmux-sync 竞态加固)→ backlog,本轮不追。

## 2. 精确改动点

**文件**:`packages/claude-runner/src/TmuxAdapter.ts`
**方法**:`execute()`
**位置**:runner `tmux new-window` 成功、拿到 `windowId` 且(若有)FLY-245 durable
commit 写完之后、`GEO-206 Phase 2: Register session` 之前。

新增私有方法 `pruneScaffoldWindow()`,行为:
1. `tmux list-windows -t =<sessionName> -F "#{window_id}|#{window_name}"`。
2. 窗口数 < 2 → return(**绝不杀 session 最后一个窗** = 绝不误杀成空 session)。
3. 找名字 ∈ {zsh, bash, sh, -zsh, -bash, -sh} 的窗口(= 纯默认 shell scaffold;
   runner 窗名恒为 `<issueId>-claude-…`,绝不匹配)。找到就
   `tmux kill-window -t <window_id>` 并 return(至多一个 scaffold)。
4. 整个方法 try/catch 吞异常 → best-effort,失败绝不阻塞/失败 spawn。

**为何放 execute() 里(而非 ensureSession)**:ensureSession 建 session 时**必然**
带默认窗(tmux 强制),那一刻还没有 runner 窗、不能杀。只有 new-window 成功后才有
≥2 窗、可安全清除 scaffold。放 execute() 也让 4 个 backend(claude/codex/antigravity
/kimi,都继承 `TmuxAdapter.execute()`)统一受益。

## 3. tmux 行为核对

- `tmux new-session -d -s NAME`:强制创建 1 个窗口(index = base-index,默认 0),
  窗名 = pane 当前命令 basename = 登录 shell 名(本机 `zsh`)。== win0 空壳。
- `tmux new-window -t =NAME …`:在 session 里新增窗口(下一个可用 index)。runner
  窗都走这条,窗名 = `-n <sanitized label>`。
- `kill-window -t <window_id>`:删单个窗口;删的不是最后一个窗 → session 存活;
  若删的是 current-window,tmux 自动把 current 移到相邻窗(= 对已错误 pin win0 的
  grouped linked session 反而是自愈)。用 `window_id`(如 `@0`)做 target 无歧义,
  不受 base-index 配置影响。
- grouped/linked session(cmux-sync 的 `cmux-<窗名>`,`new-session -t source` 建):
  与 source 共享窗口对象;win0 从 source 消失后,linked session 也不再有 win0。

## 4. 字节兼容 / 回归风险分析

- **现有测试**:`TmuxAdapter.test.ts` 的 mock 对未处理子命令返回 `{stdout:""}`,
  故 `list-windows` → `""` → 窗口数 0 < 2 → return,**不产生额外 kill-window**。
  现有断言(new-session/new-window/preflight/kill-window 计数)全部不受影响。
- **Lead session 不碰**:`execute()` 只建 `runner-<project>` session(run-infra.ts:548
  `sanitizeTmuxName('runner-' + project.projectName)`);Lead 的 `flywheel` session 由
  claude-lead.sh 建,不经此路径 → win0 不动。
- **无代码依赖 runner session 的 win0**:全仓 grep 确认没有对 runner session window
  index 0 的引用(cmux-sync 一律按窗名/window-id 操作,且主动过滤 `|zsh`/`|bash`)。
- **并发安全**:多 runner 并发进同一新 session 时,每个都在**自己**的 new-window 之后
  才 prune;`kill-window` 幂等(scaffold 已被别的 spawn 清掉 → list 里没有裸 shell 名 →
  no-op)。永远保证 prune 时 session ≥2 窗(自己的窗 + 可能的 scaffold/兄弟窗)。
- **已存在旧 session 的自愈**:fix 部署后,新 runner spawn 进一个仍带旧 win0 的 base
  session 时会顺手清掉 win0 —— 对既有错误 pin 是温和自愈(cmux current-window 被迫移到
  真实窗)。不主动去动 GEO-436 活 runner(纯代码,只在未来 spawn 触发)。

## 5. 备选(未采纳)

- **建 session 时直接以 runner 命令为 win0**:需把 runner 命令下沉到 ensureSession,
  但 ensureSession 不持有 runner 参数、且多 runner 共享 session ⇒ 结构改动大、破坏
  "一 session 多 runner 窗" 模型。否。
- **cmux-sync 侧修 pin**:方向 1,Lead 已转 backlog。

## 6. 测试计划(TDD)

`packages/claude-runner/test/TmuxAdapter.test.ts` 扩 mock 支持 `listWindows?: string`,
新增用例:
1. **清除 scaffold**:list-windows 返回 `@0|zsh\n@42|GEO-TEST-claude-fix` → 断言有
   `kill-window -t @0`,且 **没有** kill runner 窗 `@42`。
2. **只有 runner 窗(1 窗)不杀**:list-windows 返回 `@42|GEO-TEST-claude-fix` →
   断言无 kill-window(避免杀成空 session)。
3. **不误杀 runner 名**:list-windows 只含 runner 名窗(无裸 shell)→ 无 kill-window。
4. **best-effort**:list-windows 抛错 → execute() 不抛、正常完成。
5. **字节兼容**:默认 mock(list-windows→"")→ 无额外 kill-window(护现有断言)。

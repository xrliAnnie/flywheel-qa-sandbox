# Research: cmux attach 检测 + 自愈技术核实 — FLY-169

**Issue**: FLY-169
**Date**: 2026-05-26
**Source**: `doc/engineer/exploration/new/FLY-169-cmux-attach-self-heal.md`

---

## 1. cmux CLI 真实能力（`cmux --help` + live 实测）

issue 假设的 `cmux list-clients` **不存在**。可用 primitive：

| 命令 | 实测输出要点 |
|------|------|
| `cmux --json list-workspaces` | `{workspaces:[{title,ref,index,selected,pinned}]}`；title==window_name |
| `cmux --json list-pane-surfaces --workspace <ref>` | surfaces[].title == 创建时 `--command` 文本，如 `tmux attach -t '=cmux-geoforge3d-product-lead'` |
| `cmux read-screen --workspace <ref>` | surface 屏幕文本；attached 末尾有 tmux 状态栏 `[cmux-…* …] HH:MM` |
| `cmux send / send-key --workspace <ref>` | 往 surface 注入文本/按键 |
| `cmux refresh-surfaces` | 刷新渲染 |
| `cmux surface-health [--workspace]` | `surface:N type=terminal in_window=true`（不区分 attach 状态，无用） |

## 2. 检测信号（已 live 验证）

**主信号 — `tmux list-clients`（tmux-native）**：
```bash
tmux list-clients -t '=cmux-geoforge3d-product-lead' | wc -l
```
- 三个 Lead view session 实测均 = 1（attached）。
- 裸 zsh fallback → 0（issue 确认"0 clients attached"即此信号）。
- 语义：view session 是 linked session（`tmux new-session -t source`），有独立 client list；cmux surface 跑 `tmux attach -t '=cmux-…'` 后即成为该 session 的 client。不依赖 cmux socket、不抓屏，**最 robust**。

**意图信号 — surface title**（`list-pane-surfaces`）：title == `tmux attach -t '=<view_session>'` 反映"本该 attach"，但 fallback 后 title 不变 → 只表意图、不表状态。

**两信号门控**：意图(title==attach) AND 状态(0 client) → 自愈。杜绝误杀用户故意开的裸 shell。

**安全铁律**：`cmux send` 只在 0 client 时发；已 attached 时 send 会打进 Lead 的 Claude 输入框。

## 3. 失败模式

attach 在 `new-workspace --command` 时失败 → cmux fallback 裸 login shell，无重试无校验。触发：tmux session create 后未 ready 的 race、`=` 引号时序。本机当前三 Lead 都 attached（team-lead 2026-05-26 手动恢复），间歇 bug 无法 live 复现 → QA spike 人为 detach 复现。

## 4. 现有测试基建

- `scripts/test-cmux-sync.sh` — bash 3.2 mock 单测：source 脚本后用 bash 函数覆盖 `tmux`/`cmux`，`MOCK_*` 变量驱动。已 mock `list-windows/list-sessions/has-session/set-hook/kill-session` + cmux `list-workspaces(--json)`。**需新增**：tmux `list-clients` mock（按 view session 返回 client 数）、cmux `list-pane-surfaces` mock（返回 surface title）、捕获 `cmux send/send-key/refresh-surfaces` 到 `MOCK_CMUX_OPS`。
- `scripts/test-cmux-sync-hooks-integration.sh` — 真 tmux 集成测试。

## 5. 结论

- 检测用 `tmux list-clients`（主）+ surface title 意图门控；不依赖屏幕抓取。
- 方案 2（reconcile 自愈，新函数挂 `sync_additive` + `sync_additive_bootstrap`）+ 方案 3（create 前 `tmux has-session` 门禁）。
- 可测：检测/意图判定纯逻辑抽函数，mock 驱动；CI 无需真 cmux/GUI。

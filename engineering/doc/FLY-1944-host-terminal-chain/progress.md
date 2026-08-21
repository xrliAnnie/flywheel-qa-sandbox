---
issue: FLY-1944
phase: implement
phaseCursor: 6/7
updated: 2026-08-21T16:36:21.000Z
nextStep: "Run full gates, commit/push the R10 delimiter hardening, rerun exact-head CI, and request R11"
chunks:
  qa-rework-code: completed
  local-verification: completed
  w5-segmentation: documented-in-pr
  dual-codex-isolated-e2e: completed-with-explicit-seams
  dual-codex-host-e2e: completed-real-codex-host-census
  exact-head-ci: completed-green-at-eb864229f
  r10-printable-tmux-identity-separator: focused-green-real-matrix-verified
pointers: {}
---

# FLY-1944 progress
**phase**: implement (6/7)
**next**: Run full gates, commit/push the R10 delimiter hardening, rerun exact-head CI, and request R11

## plan §4.3 真宿主双 Codex E2E

- 通过既有 host tmux server 执行 exact-head `ensureRunnerTuiWindow()`；rescue 指向与分支 byte-identical 的生产脚本，默认 socket 为 `/private/tmp/tmux-501/default`。
- 两个 workspace-local、测试后已删除的 Codex home clone 各启动一个真实 app-server；两个真实 `codex resume --remote` TUI 并发竞争同一 kernel lock。A/B 分别观察到 1/12 次 `status=5` hold，再收敛到 live immutable windows `@537` / `@538`。
- host `/bin/ps` 逐一证明两个 TUI 的 remote socket、cwd 与 thread id；window metadata 的 `@flywheel_exec_id` 分别匹配两个 execution。CommDB 与原 `session.json` 只读核对，测试前后值未改。
- harness、app-server sessions、Unix sockets、byte-identical Codex binary、cloned homes（含 credentials）均已删除；生产 runner 窗口与 CommDB 未变。

## R10 tmux identity separator hardening

- R10 报告 tmux 会将格式字符串里的 TAB 改写成 `_`。在同一宿主分别用 `/usr/local/opt/tmux/bin/tmux` 3.5a 与 `/opt/homebrew/opt/tmux/bin/tmux` 3.7c 的隔离 socket 对 `display-message`、`list-windows -F` 做 `od` 字节验证；两者均保留字面 `09` TAB，因此 reviewer 所述宿主行为未复现。
- 仍按兼容性护栏将 `tmux-lookup.ts` 的两个 identity record 改为可打印 `|` 分隔。新增 sanitizer-emulation RED 覆盖 resolver 与 discovery，两条分别以 `malformed-identity` / `missing` 失败；最小修改后 focused 30/30 GREEN。
- real-tmux suite 扩至 7 项，覆盖正确 `@id` + execution marker、`:pending`、stale window name、stale `@id`、execution drift；在真实 tmux 3.5a 上全绿。

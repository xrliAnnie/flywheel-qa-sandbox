APPROVED

# Flywheel v2 设计稿 v13 复审 R13

- 评审对象：`/tmp/design/design-v13.md`
- v13 SHA-256：`1341d1547916be8cbe4469b3520a7e6a6a2528acf25f7920de621bf078661ef0`
- R12 基线：`/tmp/design/codex-verdict-r12.md`（SHA-256 `3bfa2b6c7165fe7ea59c8241c52645e1c7daba673f3ca9745c02bd218a29c3ba`）
- 仓库锚点：本地干净 `main@83a90791665372ee07b19bb8b48e5f5f2daf30ee`；checkout 与 R12 相同，仍落后本地 `origin/main` 1 个提交。
- 评审边界：只核验 R12 的 HIGH-1、HIGH-2、MEDIUM-1（`codex-verdict-r12.md:21-69`）及 v13 直接引入的矛盾；R6-R12 已闭合项未重开。

## 结论

R12 三项均已闭合，未发现这三处修订引入的新状态机、并发或计数矛盾。

## 逐项核验

### 1. N43 正常终态与 claim-crash 子例已分开

R12 要求正常第六次启动完整执行 claim→spool→alert→attempted，最终为 `held_alert_attempted`；`held_alert_pending` 只能由 claim rename 后的显式 crash 注入产生，并应在下一次启动恢复到 attempted（`codex-verdict-r12.md:21-33`）。

v13 正常子例现明确断言前五次 exec、第六次不 exec、最终 `held_alert_attempted`（`design-v13.md:6-7`）；另设 fault-injection 子例在 claim rename 后立即 crash，先断言 pending，再由下一次启动恢复到 attempted（`design-v13.md:8`）。这与继承状态机的 pending 恢复分支和正常 threshold 分支一致（`design-v11.md:21,23`），不再要求同一条无 crash 时间线同时停在 pending 又完成 attempted。

### 2. resume 已与全部状态写者共享同一锁，重复 resume 收敛为 no-op

v13 把 wrapper、授权 resume 命令和任何恢复工具全部纳入同一 `<child_key>.lock`，并继承取锁失败 fail-closed（`design-v13.md:10-11`）；resume 只能在锁内重读后、实际状态仍为 `held_*` 时条件写（`design-v13.md:12`）。第二个 resume 若读到 `resumed` 或 `active`，成功返回但不改任何字段，尤其不推进 `last_resumed_seq`（`design-v13.md:13`）。

因此 R12 的 stale-rename 交错已被排除：若两个 resume 连续取得锁，后者看到 `resumed`；若 wrapper 夹在两者之间，wrapper 先把 `resumed→active`，后者看到 `active`。两种情况下后者都 no-op，不能覆盖 active/held。v13 还把“恰一 resume 生效、无 stale rename、下界只推进一次”写入并发验收（`design-v13.md:14`）。

仓库现有 Python helper 确实提供 macOS `fcntl.flock`、有界取锁失败且不运行临界区命令的语义（`scripts/flywheel-config-lock.py:53-65,70-81`）；当前 Bridge wrapper 最终以 `exec` 交给子进程（`scripts/flywheel-bridge-wrapper.sh:208-220`），与设计所述“启动前短临界区、随后 exec”的实现边界不冲突。

### 3. 计数下界已改为 durable seq cursor

v13 定义 ledger 行内持久、单调递增且全序的 `seq`（`design-v13.md:16-17`），用 `last_resumed_seq` 替代时间戳计数下界，wall clock 仅决定 10 分钟窗口（`design-v13.md:18`）。终版谓词是窗口内 `event_seq > last_resumed_seq` 且 `state=active` 的事件数至少为 6（`design-v13.md:19`）。

首次/旧状态文件缺字段时取 0（`design-v13.md:20`）；resume 在同一 child 锁内把当时 ledger 最大 seq 作为 cursor（`design-v13.md:12`），故边界之前的旧 episode 事件均被排除，下一条 `+1` 事件可计。same-seq 边界也已明确验收为“等于 cursor 不计、`+1` 计”（`design-v13.md:21`），消除了 R12 指出的 same-tick 与回拨跨 resume 边界问题。该 cursor 在 `resumed→active→held_alert_pending→held_alert_attempted` 全程保留，只有下一次成功的锁内 resume 才推进（`design-v13.md:22`），不会被普通状态转移重置。

## 裁决

三项修订均满足 R12 最小修改集；无新增阻断项。**APPROVED**。

# QA Report: FLY-694 bash 3.2 re-exec guard — independent verification — FLY-704

**Issue**: FLY-704 (QA · FLY-694 — 独立验证 Mufasa launcher bash 3.2 re-exec guard)
**Subject of review**: PR #393 / branch `flywheel-FLY-694` (head `e7ecdc88`), base `main` (`31729b83`)
**Date**: 2026-06-30
**Verdict**: ✅ **PASS — FLY-694 ship-ready**

---

## Summary

FLY-694 修复的是一个 **bash 3.2 here-document / read-buffer-boundary desync**：macOS `/bin/bash`
是 GPLv2-frozen 的 bash 3.2，其*增量*脚本读取器会静默错读跨越内部读缓冲边界的 here-document。
FLY-676 (#388) 给 `codex-lead-tui-home.sh` 加了约 1.8 KB，把一个 heredoc 推到坏边界上，导致 bash 3.2
在**运行时**漏定义 `write_full_access_config` / `append_full_access_lead_actions_mcp` 两个函数 →
Mufasa launcher 撞 `line 395: write_full_access_config: command not found` → 退出 **127** →
launchd 每 30s 重试。`bash -n` 在任何 bash 版本都查不出（parse-vs-execute 分歧）、Linux CI 用现代 bash
也复现不出。

修复方案：脚本顶部一段自包含 **re-exec guard** —— 在 bash `<4` 下 `exec` 进现代 bash (`>=4`)，
后者没有该缺陷、因此对任何未来的 byte-layout 漂移免疫。

本次独立 QA 在**本机真 `/bin/bash` 3.2.57** 下（= 生产部署解释器），对照 fixed (PR head) vs
pre-fix (main) 两版，逐条验证 FLY-704 issue 列出的三条断言。**三条全绿。**

## Environment

| 项 | 值 |
|----|----|
| Host OS | macOS 26.3.2 (build 25D2150) |
| 部署 bash（触发 bug） | `/bin/bash` = 3.2.57(1)-release |
| re-exec 目标 bash | `/opt/homebrew/bin/bash` = 5.3.9(1)-release |
| PR head (fixed) | `e7ecdc88c49c1c6856b27f3971f4db41a956d62d` |
| base main (pre-fix) | `31729b83c6eccc9461a3b723ea12d9030a908e0c` |
| 被测脚本 | `packages/teamlead/scripts/codex-lead-tui-home.sh` |
| 测试套件 | `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh` |

PR #393 含 2 个 commit：`bf03e9cf`（首版 re-exec guard）+ `e7ecdc88`（按 Codex review 加固 LOW-1 + LOW-2，
即本次 QA 验证的最终版）。

## Methodology

为做到**独立**且不污染当前分支：将 PR head 与 main 两版的脚本/测试文件各抽到隔离临时目录，
在 `/bin/bash` 3.2 下分别跑「直接脚本调用」+「完整测试套件」+「`bash -x` 追踪」。所有 full-access
`ensure-home` 调用使用与套件 case 30 相同的 env（fresh home：`auth.json` + `packages/standalone/current/codex` stub）。

---

## Assertion 1 — full-access ensure-home rc=0 + 函数真定义（pre-fix rc=127）

直接脚本级 before/after（`FLYWHEEL_CODEX_LEAD_PROFILE=full-access ... ensure-home`，均在 `/bin/bash` 3.2 下）：

| 版本 | 结果 |
|------|------|
| **pre-fix** (main) | `codex-lead-tui-home.sh: line 395: write_full_access_config: command not found` → **rc=127** —— 逐字复现 FLY-694 故障 |
| **fixed** (PR head) | 无 command-not-found，config.toml 正常写出，**rc=0** |

测试套件（`/bin/bash` 3.2，真实 PR worktree 布局）：

```
Results: 43 passed, 0 failed
```

逐字对上 PR headline 声称的 **43/0**（pre-fix 为 34/6，那 6 个失败正是 full-access case = 本 bug）。
FLY-694 回归块 3 条断言均绿：
- `FLY-694: bash-3.2 re-exec guard present in the script`
- `FLY-694: full-access ensure-home under /bin/bash defines all functions (no 'command not found')`
- `FLY-694: full-access ensure-home under /bin/bash exits 0 (was 127 pre-fix)`

**逻辑闭环**：因 full-access 函数体两版逐字相同（见 Assertion 3），fixed 在 bash 3.2 下能从 127 翻到 0
的**唯一**原因就是 re-exec 进了现代 bash。

✅ **PASS**

## Assertion 2 — re-exec guard 机制

**(a) 真 re-exec（`bash -x` 追踪，父 `/bin/bash` exec 前的轨迹）**

```
+ for _modern_bash in /opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash
+ /opt/homebrew/bin/bash -c 'exit $(( ${BASH_VERSINFO:-0} < 4 ))'
+ export FLYWHEEL_TUI_HOME_REEXEC=1
+ exec /opt/homebrew/bin/bash .../codex-lead-tui-home.sh ensure-home
```

实测 `exec` 进 `/opt/homebrew/bin/bash` 5.3 —— 不是「3.2 碰巧能跑」。

**(b) 4 个可信绝对路径、无 PATH 查找**

候选行恰为 `/opt/homebrew/bin/bash /usr/local/bin/bash /usr/bin/bash /bin/bash`（arm Homebrew / intel·手装 /
Linux `/usr/bin` / `/bin`）。脚本中**无** `command -v bash` / `which bash` / bare `bash` —— 杜绝
PATH 冒充（生产 wrapper 会把用户可写的 `~/.local/bin` 前置进 PATH，且 probe 会**执行**候选，full-access
语境下 PATH 查找即提权风险；Codex review LOW-2）。

**(c) version-probe 拒 3.x / 收 ≥4**

`"$c" -c 'exit $(( ${BASH_VERSINFO:-0} < 4 ))'` 实测：`/bin/bash` 3.2 → rc=1（拒绝，绝不回落进 3.x）；
`/opt/homebrew/bin/bash` 5.3 → rc=0（合格目标）。

**(d) sentinel 防循环**

预设 `FLYWHEEL_TUI_HOME_REEXEC=1` 后在 `/bin/bash` 3.2 跑 → **不** re-exec → 发出 loud warning →
留在 3.2 → heredoc desync 复发 → command-not-found → rc=127。这同时证明：sentinel 能抑制 re-exec，
且 re-exec **正是**修复点（一旦被抑制，bug 立刻回来）。

**(e) 无 modern bash → loud warn 且不死循环**

合成「候选仅含一个 3.x（`/bin/bash`）」：probe 拒绝 → 循环耗尽 → 发出
`WARNING (FLY-694): running under bash 3.2.57 ... did not re-exec into a modern bash ...` →
best-effort 继续（无新增 hard-fail）。**无超时/无死循环**（probe 从结构上只在 `>=4` 才 exec）。

✅ **PASS**

## Assertion 3 — config.toml workspace-write + full-access 逻辑 byte-untouched

**(a) fixed 在 bash 3.2 下（re-exec 后路径）写出的 config.toml**

```toml
sandbox_mode = "workspace-write"
approval_policy = "never"

[sandbox_workspace_write]
network_access = true
writable_roots = ["/work/dir"]

[projects."/work/dir"]
trust_level = "trusted"

[mcp_servers.lead_actions]
command = "/usr/local/bin/node"
args = ["/d/lead-actions-main.js"]
default_tools_approval_mode = "approve"
env_vars = ["DISCORD_BOT_TOKEN"]          # token by NAME, no broker socket
env = { FLYWHEEL_LEAD_ID = "mufasa-lead", ... }
```

完整 full-access 形态：workspace-write + network ON + writable_roots=[cwd] + approve mode +
token by name + **无** broker socket + **无** read-deny profile —— 与 FLY-398/350 既定契约一致。

**(b) full-access 逻辑逐字未动**

- pre-fix vs fixed 脚本 diff = **单条 insert-only hunk**（`29a30,64`，即顶部 +35 行 guard），无其他 hunk。
- 从 `write_full_access_config()` 到文件末尾的整段 md5 两版一致（`bbdb4554...`）。

即修复**只在顶部加了 guard**，对已验证的 config/security 逻辑**零改动**。

✅ **PASS**

---

## Scope boundary（已与 Lead 确认可接受）

测试套件中 5 条 `shell→gate` 交叉验证（content-coordination ×3 + full-access ×2）因 `dist` 未构建被**跳过**
（套件打印 `(skip shell→gate xcheck: dist not built ...)`）。这些验的是 **FLY-398/350** full-access
config ↔ TS 运行时 gate 的一致性，**本 PR 对该逻辑逐字未改**（见 Assertion 3）、且已在 **FLY-389** 独立 QA 过；
两个 checkout 的 `node_modules` 均缺，补 `dist` 需重型 `pnpm install`，与本次纯 bash 解释器修复正交。
按风险分档明确划为 scope 外，**不影响 694 verdict**。

> Retro / follow-up（PR 自带，非本次阻塞）：restart-gated Codex-lead launcher 这类改动需要一道**真在部署 bash
> (macOS 3.2) 下跑 launcher** 的 gate —— Linux CI + vitest 结构性抓不到这一类 bug。建议把
> `codex-lead-tui-home.test.sh` 接进 macOS CI job 或真机 QA checklist。

## Conclusion

FLY-704 issue 列出的三条断言在本机真 `/bin/bash` 3.2 下**全部通过**，并逐字复现 PR 的 43/0 headline 与
127→0 before/after。**FLY-694 (PR #393) ship-ready。**

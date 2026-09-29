# FLY-3030 N-to-N 活体探针 — 调研

Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: exploration.md

## 1. 调研目标

exploration §4 已锁定方案 A。本文只核实三件会让实现节点「做对了却交不了卷」的事实：
(a) 前台 13 分钟 sleep 在 Claude Code 里怎样才不被工具层杀掉；
(b) 「活体丢窗口不判死」在代码里是什么口径，sleep 期间什么行为会污染它；
(c) 交卷路由与本设计节点自己的完成门槛（founder HTML 硬检查）。

## 2. 事实核实

### 2.1 Bash 工具超时（事实 a）

| 项 | 值 | 来源 |
|----|----|------|
| Bash 工具默认超时 | 120 000 ms（2 分钟） | Claude Code Bash 工具参数说明 |
| 最大可设超时 | 176 400 000 ms | 同上 |
| `run_in_background` | 命令脱离前台、立即返回 | 同上 |

结论：`sleep 780` 必须作为**单独一次** Bash 调用，显式 `timeout: 900000`（15 分钟，留 2 分钟余量），
`run_in_background` 保持 false。Codex 体 runner 若走 shell 工具亦同理：不得使用有默认短超时的封装。

### 2.2 判活口径（事实 b）

`packages/claude-runner/src/execution-process-liveness.ts` 首行注释（QA 房源码，头 `95e5cd7`）：

> FLY-2919: the physical execution verdict has no window or workflow-status input.

即「身体（body）活着与否」= 物理进程证据（pid / pgid / 启动身份 / host boot id / 可执行文件与 cwd），
**不看 tmux 窗口在不在、不看 workflow 状态**。所以：

- 窗口丢了但进程活着 → 判 alive，这就是「活体丢窗口不判死」要观察的分支；
- 测试希望 660 秒窗口内 runner **没有任何交互**，才能证明判活不依赖屏幕活动。

对实现节点的含义：
- 不打印心跳、不分段 sleep、不在 sleep 期间查 inbox——任何输出都会改变 pane 内容，
  让 FLY-83/FLY-193 那套 pane 哈希识别器有额外信号，削弱本次观察的说服力；
- sleep 结束后再做 inbox 检查（协议要求的「任务边界安全网」放在第 2 步之前即可）。

### 2.3 交卷路由与设计节点门槛（事实 c）

`packages/flywheel-comm/src/commands/complete.ts` `VALID_ROUTES`：
`auto_approve / needs_review / blocked / ship_attempt_failed / no_code / pr_handoff / phase_design_complete`。

- 本设计节点：`phase_design_complete`，要求（FLY-1404 硬检查）：
  分支名含 issue token（`project-slot-1-FLY-3030` ✓）；
  `merge-base(HEAD, origin/main)..HEAD` 范围内有已提交的 `.html`，路径匹配
  `(^|/)doc/FLY-3030(-[^/]+)?/`（`engineering/doc/FLY-3030-nton-codex-probe/design.html` ✓，
  见 `design-html-evidence.ts:23`）。
- implement 节点：用其注入提示词给出的阶段完成路由；**不是** `pr_handoff`
  （`complete.ts:60` 注释：仅供无 transport 的 antigravity/kimi 体）。PR 必须存在且引用 FLY-3030。

### 2.4 仓库事实

| 项 | 值 |
|----|----|
| origin | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` = issue 指定的沙箱仓 |
| 分支 / 基点 | `project-slot-1-FLY-3030` @ `1855f7a1a`（= origin/main） |
| README.md | 3 行，末字节 `0x0a`（已有换行），末行 `FLY-1375 land E2E marker 20260722T023540Z` |
| lint 范围 | `biome.json` 只管 ts/js/json；markdown 不在范围，README 改动不需要 `pnpm lint` |

## 3. 风险清单

| 风险 | 后果 | 对策（进 plan） |
|------|------|-----------------|
| Bash 调用没带 timeout | sleep 在 120 秒被杀，测试窗口作废 | plan 明写 `timeout: 900000`，并在 sleep 后用 `$SECONDS`/时间戳自证 ≥ 780 秒 |
| 分段 sleep / 打印进度 | 污染安静窗口 | negative guard：单条 sleep，零输出 |
| 重跑或换体续干时再次追加 | README 多出重复行 | `grep -qxF` 幂等守卫 |
| `git add -A` | 把 progress.md 之外的杂物带进 commit | 只 add `README.md` |
| 误建新分支 / force push | 违反 git-workflow skill、触发 FORCE-PUSH GUARD | 明令禁止 |
| 派单房不符（slot 1 vs issue 说 slot 2） | 可能是误派 | 已非阻塞 ask Lead（id `bf853e7c`）；不影响设计内容 |

## 4. 结论

方案 A 可行，无需任何代码改动；所有约束均可写成实现节点逐条可核对的命令。进入 plan。

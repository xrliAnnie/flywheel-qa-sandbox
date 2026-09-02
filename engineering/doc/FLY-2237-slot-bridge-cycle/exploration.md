# FLY-2237 房内 Bridge 循环 — 探索
Issue: FLY-2237 (https://linear.app/geoforge3d/issue/FLY-2237/529台架原语-缺保留在飞工人只循环房内-bridge的动作-reown-reconciler-类重启机制永远无法真机触发2211-三轮实证)
日期: 2026-09-01
基于: 无

## 问题边界

FLY-2211 需要在 529 generalized 房里制造一次真实 Bridge boot pass：owner 缺席时只让同房 Bridge 经 SIGTERM 后回来，使既有 reconciler 观察并 reown 在飞 execution。当前台架只有 `scripts/test-teardown.sh` 加 `scripts/test-deploy.sh` 的整房重建；该路径会停止 Lead、清理房目录、回收 tmux/runner/daemon 状态，因此不能作为重启波验收动作。

本 issue 只补一个房内动作：保留 slot ownership、Lead、在飞 Runner、Codex daemon 与 tmux server，只循环 Bridge。它不修改 reconciler 本身，不重设计 529 topology，也不把生产 Bridge/Lead 生命周期纳入范围。

## 已确认的事实

- `scripts/test-deploy.sh` 有三条 Bridge 启动分支：generalized、reply-by-issue、default。它们共享主要 env，但各自有不同的 unset 与 wrapper/token 行为。
- 每条分支已显式注入 `FLYWHEEL_BIN_DIR`、`FLYWHEEL_HOOKS_DIR`；`BRIDGE_EXTRA_ENV` 已显式注入 `FLYWHEEL_CODEX_HOMES_ROOT`、`FLYWHEEL_CODEX_SESSION_DIR`、`FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT`。
- `BRIDGE_EXTRA_ENV` 还承载 complete marker、loop diagnostics、delivery secret、tmux root、founder-consent audit、roundtable、alerts、digest、extra-lead token、runner stub PATH 与 `FLYWHEEL_STATE_DIR`。另起一套手写重启命令会立即产生第四份容易漂移的环境合同。
- generalized master/ingest token 是 deploy 时生成的 slot-local credential；其中 ingest 值当前只存在于 Bridge 进程环境。仅重新 source `~/.flywheel/.env` 无法恢复同一房的完整 credential set。
- `bridge.pid` 与 owner/campaign slot lock 当前都以 Bridge PID 维持房 ownership。循环后只更新 owner lock 会让 borrowed campaign lock 把已退出旧 PID误判成 stale。
- `bridge.log` 是 boot/reconcile 证据载体；循环时覆盖日志会销毁 boot 前后的同一时间线。

## 目标体验

操作者在一个已经 ready 的 slot 上运行：

```bash
bash scripts/test-cycle-bridge.sh <slot>
```

动作必须：

1. 验证 slot、Bridge PID、所有 ownership lock 与启动合同彼此一致；
2. 以 slot port 的真实 listener 为 authority，向该 listener 对应的完整 run-bridge process tree 发送 SIGTERM，并等待真实退出/端口释放；
3. 由 test-deploy 首次启动时使用的同一个 slot-local 启动合同拉起 Bridge；
4. 等待 `/health` 成功，再原子更新 `bridge.pid` 与 owner/borrowed lock PID；
5. append `bridge.log`，输出 old/new PID 与 URL；
6. 不调用 teardown、launchd Lead stop、tmux kill、Runner close 或 Codex daemon reap。

## 方案比较

### A. 重启脚本重新拼 test-deploy env

拒绝。会产生第四条环境组装分支，未来新增一个隔离变量时无法保证 deploy 与 cycle 同步；deploy-time ingest credential 也无法无损重建。

### B. 从 `ps eww` 抄现有 Bridge 环境

拒绝。不同平台的进程树与 `ps` 输出不稳定，Bridge PID 可能是 `npx`/wrapper 而 listener 在后代；解析进程环境也会扩大 secret 暴露面，且不能证明重启使用的是声明式台架合同。

### C. test-deploy 固化 mode-0600 启动合同，首次启动与循环共同消费

采用。test-deploy 仍是环境组装唯一 authority；它在 slot 内写一个 schema-versioned、mode-0600 的 launch spec，包含 `env -i` 可重放的完整 resolved environment、secret file references、cwd、command、port、log 与 ownership locks。初次 Bridge 也从该 spec 启动，避免“写了合同但首启仍走旧路径”的双写假一致。cycle 只做 ownership/listener-tree 校验、TERM、同 spec restart、health/lock 收尾。

## 假设与约束

- 529 slot 仍以 `/tmp/flywheel-test-slot-<N>` 和同名 `.lock` 为现行 authority；本 issue 不迁移目录协议。
- launch spec 自身不含 bearer/token bytes；deny-by-name classifier 把任意动态 `*TOKEN*/*KEY*/*SECRET*/*AUTH*` 等变量写入 slot-local mode-0600 secret files，slot dir/secret parent 为 0700。deploy readiness 失败保留日志时必须删除未交付 spec/secret files；任何诊断与 JSON stdout 不得打印 secret 值。
- process targeting 不能复用 production `bridge-process-tree.sh`，因为它刻意排除 `*worktrees/*` QA Bridge；本动作从 strict `lsof` 给出的 listener PID 纯沿 PPID 上溯，必须精确到达 spec/`bridge.pid` 的 launcher PID，完全不把 argv/path 文本当 membership authority。fixture 必须模拟真实三层 tsx tree、listener argv 不含 `run-bridge.ts`、祖先只含 repo-relative path，并强制在含 `/worktrees/` 的 arm验证。
- SIGTERM 超时后 fail closed，不升级 SIGKILL；这既满足验收动作，也避免新原语悄悄扩大为强制清场。
- cycle 期间禁止并发第二次 cycle；slot-local cycle lock 用于串行化，活持有者存在时立即拒绝。
- Bridge boot 自己触发的 reconciler/reown 属于预期结果；“不触碰在飞 worker/daemon/tmux”指 cycle 原语不直接停止、删除或重建这些资源。

## 非目标

- 不修改 FLY-2211 reconciler/reown 判据。
- 不补生产 Bridge restart、launchd 或整机恢复动作。
- 不改变 Lead carrier、Runner lifecycle、tmux topology 或 Codex daemon ownership。
- 不在仓库、日志、stdout、room-info 或 launch-manifest 明文新增 secret。

# FLY-766 claude-in-chrome 内存尖峰真根 — 探索

Issue: FLY-766 (https://linear.app/geoforge3d/issue/FLY-766/infrap0-claude-in-chrome-qa-会话是内存尖峰真根-chrome-生命周期回收-并发上限751-覆盖不到)
日期: 2026-07-02
基于: 无(本 issue 起点)

## 1. 问题复述

任何会话(QA runner **必须**保留 claude-in-chrome 做真机验证,普通 runner 有时也会用)用完 Chrome 后**不回收**,孤儿堆积 → fleet 级内存尖峰(今天两次:早上 swap 冲 19.9G、03:46 load 冲 76 / 93 个 Chrome 吃 10G;事后仍 39 个 / 4.8GB)。FLY-751 只砍**非-QA** runner 的 MCP,治不了这条路径。

## 2. 根因(实测 + 代码验证)

**泄漏物 = `agent-browser` CLI 起的 Chrome for Testing**,不是 `mcp__claude-in-chrome__*` 扩展(那条接 Annie 真 Chrome、无临时 profile)。证据链:

- `agent-browser` v0.27.1(Rust 二进制,`~/.npm-global/bin/agent-browser`)是 ProofShot / `flywheel-comm visual-capture` 及浏览器类 skill 的底层。它下载 **Google Chrome for Testing**(`~/.agent-browser/browsers/chrome-147.x/…`),用 `--user-data-dir=$TMPDIR/agent-browser-chrome-<uuid>` + `--headless=new` + `--remote-debugging-port=0` 起一套 Chrome(≈15 进程,几百 MB～1G+)。
- **持久驻留模型**:`agent-browser` 每条 CLI 命令跑完就退出,但 Chrome **不关**——留着让后续命令经 `DevToolsActivePort`(CDP)复用同一实例(`agent-browser --session <name>`,全局注册表在 `~/.agent-browser/`,`close --all` 是全局的)。
- **关键陷阱**:Chrome 被 `agent-browser` 起为子进程,`agent-browser` 一退出,Chrome 就 **reparent 到 launchd(`ppid=1`)**——但**此时它还在被会话复用**。所以 `ppid=1` **不能**区分「在用的持久 Chrome」vs「弃用的孤儿」。Cass 实测的「4 个 ppid=1 孤儿」里,部分可能其实在用。
- 会话到终态(pass/fail/block/complete/crash/terminate)时,**没有任何一步**去关这套 Chrome → 每个会话叠一套 → 尖峰。系统盘上仍留 `$TMPDIR/agent-browser-chrome-443cc074-…`(今早 08:02)这类残 profile。

**安全回收的核心难点**:因为在用的持久 Chrome 也是 `ppid=1`,**要确定性且安全地回收,必须知道每套 Chrome 归属哪个会话**——只回收「归属会话已到终态 / 已消失」的,绝不碰「归属会话仍活着」的。裸 `ppid=1` 或裸 idle-time 都是启发式,会误杀在用会话。

## 3. 现有可复用基建

- **viewer-session-reaper.ts(FLY-754)**:Bridge 侧 reaper 范式——boot one-shot 扫描 + 保守 kill 规则(`ALL must hold`)+ 外部会话(别的 Bridge/QA slot)绝不碰 + 写 audit event。本 issue 的 reaper 直接对标它。
- **crash-reaper.ts(FLY-720)** + **HeartbeatService**:`setInterval` tick 上跑 `reapCrashedRunners` → `reapOrphans`。周期性 chrome reaper 的天然挂载点。
- **close-runner / terminate / crash 路径**:会话终态 teardown 的既有钩子(A「用完必关」的注入点)。
- **run-infra.ts**:runner env 组装处(注入 per-runner 归属信息的地方);runner 已有 `FLYWHEEL_RUNNER_STATE_DIR=~/.flywheel/runner-state/<execId>`。

## 4. 方案骨架(A + B 为核心,C/D 待定)

**归属机制(让 A 确定性、让 B 安全的前提)**:Bridge spawn runner 时,把该 runner 的 `agent-browser` 临时 profile 根指到 per-runner 目录(经 `TMPDIR` → `~/.flywheel/runner-state/<execId>/browser-tmp/`;`agent-browser` 用 Rust `temp_dir()` 读 `TMPDIR`,实测 profile 就在 `$TMPDIR` 下)。于是 Chrome 的 `--user-data-dir` 路径里带 execId → reaper 能把 Chrome 映射回会话、查 StateStore 状态。

**Reaper(A + B 合一,Bridge 侧,对标 viewer-session-reaper)**:
- **选择器(安全)**:只认 `--user-data-dir` 含 `agent-browser-chrome-` **或** exec 路径在 `~/.agent-browser/browsers/` 下的 Chrome。**永不碰** Annie 的 `/Applications/Google Chrome.app` 默认 profile。
- **kill 规则**:从 `--user-data-dir` 解析 execId → 查 StateStore:归属会话是终态/无 row(孤儿)→ kill;归属会话仍活着 → skip。无法归属的(旧 `$TMPDIR` 残留 / Bridge 侧 ProofShot)→ 交给 boot 兜底 + 保守 idle 规则。
- **触发点**:(i) boot one-shot(迁移当前 backlog);(ii) heartbeat tick(高频 → 会话一到终态下一 tick 就回收,即实用的「用完必关」);(iii)(可选)close_runner/crash-reaper teardown 里对该 execId 精确回收(真正确定性 A)。
- 每次 kill 写 audit event;best-effort 不抛;kill-switch env 默认 ON。

**C. 并发上限**:claude-in-chrome 会话难以在 dispatch 前预判是否会开浏览器 → 纯「chrome 会话」粒度的信号量不好做。倾向做成**内存/chrome-数量感知的 admission gate**:live agent-browser Chrome 数 ≥ K(K 按内存算)或系统内存压力高时,延迟新 runner dispatch。**待 founder 拍是否本次纳入,还是 fast-follow。**

**D. 共享 Chrome 池**:多会话复用一个实例池——大改、`agent-browser` 全局注册表不天然支持隔离复用 → **建议明确 defer**。

## 5. 待 brainstorm gate 决策点

1. **归属机制**:采 per-runner `TMPDIR` 注入(推荐,让 A 确定性)vs 仅孤儿启发式回收(blast radius 小但 A 不确定性、有误杀风险)。
2. **C(并发上限)**:本次纳入(内存感知 admission gate)vs fast-follow?
3. **范围确认**:A+B 为本次核心交付,D defer —— 是否认可?

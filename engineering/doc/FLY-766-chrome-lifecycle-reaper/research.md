# FLY-766 claude-in-chrome 内存尖峰真根 — 调研

Issue: FLY-766 (https://linear.app/geoforge3d/issue/FLY-766/infrap0-claude-in-chrome-qa-会话是内存尖峰真根-chrome-生命周期回收-并发上限751-覆盖不到)
日期: 2026-07-02
基于: exploration.md

## 1. brainstorm gate 结论(Tadashi 批准)

- **Q1 = per-runner TMPDIR 注入,坚决走**(execId-tagged profile 目录 = 确定性归属;blast-radius 值得,换来安全+精确)。
- **关键守卫**:reaper 选择器认 **Chrome 的 `--user-data-dir` 值**(不是进程名 grep)——今天 Tadashi 手动清 Chrome 时正是拿进程名 grep 误杀了 766 自己的 runner。这条必须守住。
- **Q2 = C(并发/admission gate)fast-follow 单独 issue**;**Q3 = A+B 核心、D 共享池 defer**。

## 2. agent-browser 启动机制(实证 + 二进制取证)

- `agent-browser` v0.27.1(Rust,`~/.npm-global/bin/agent-browser` → `bin/agent-browser-darwin-arm64`)。
- 下载的 Chrome for Testing 二进制:`~/.agent-browser/browsers/chrome-<ver>/…/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`。
- 启动 flag(二进制 strings 实取):`--user-data-dir=<tmp>/agent-browser-chrome-<uuid>` + `--remote-debugging-port=0` + `--headless=new` + `--no-first-run` + `--no-default-browser-check` + 一堆 `--disable-*`。
- 临时 profile 根 = `std::env::temp_dir()` = **`$TMPDIR`**(macOS)。证据:遗留 profile `/var/folders/zl/…/T/agent-browser-chrome-443cc074-…` 恰在系统 `$TMPDIR` 下;二进制无硬编码 `/var/folders`;Rust `temp_dir()` 读 `TMPDIR`。**→ 设 per-runner `TMPDIR`,agent-browser 的临时 chrome profile 就落进该目录。**
  - **置信度**:高(旁证充分);实证启动被 runner sandbox 拦(agent-browser 要起浏览器+网络),**留作 QA 真机 spawn 终验**(见 §7)。
- 持久驻留:CLI 每命令跑完即退,Chrome 留着供后续命令经 `DevToolsActivePort`(CDP)复用。Chrome 被 CLI 起为子进程,CLI 一退 → Chrome **reparent 到 launchd(`ppid=1`)**——**在用期间也是 `ppid=1`** ⇒ 裸 `ppid=1` 不能区分在用/弃用。
- 全局 session 注册表在 `~/.agent-browser/`;`agent-browser close --all` 是**全局**的 → **绝不能**跨 runner 用(会杀别 runner 的 chrome)。

## 3. Chrome 进程形态与安全选择器

一套 Chrome for Testing ≈ 15 进程:1 个 **main/browser 进程**(argv 含 `--user-data-dir=` 且**无** `--type=`)+ N 个子进程(`--type=renderer|gpu-process|utility|zygote`,通常也带 `--user-data-dir`)。

**安全选择器(两条都满足才算命中,守住 gate 的关键守卫)**:
1. **可执行像 Chrome for Testing**:argv[0] / comm 是 `Google Chrome for Testing`(或路径在 `~/.agent-browser/browsers/` 下)。**排除** `claude` / `node` / 任何非-chrome 进程 —— 防止 runner 进程(其 argv/issue 标题恰含 "agent-browser-chrome" 子串)被误命中。
2. **有 `--user-data-dir=<path>` 且 path 段含 `agent-browser-chrome-`**。

**永不碰**:Annie 的 `/Applications/Google Chrome.app`(默认 profile,user-data-dir 在 `~/Library/Application Support/Google/Chrome`,不含 `agent-browser-chrome-`)。

**只杀 main 进程**:命中里再筛「无 `--type=`」= 每套 1 个 main PID。SIGTERM main → 子进程(renderer 等)随之退出(chrome 自管)。下一 tick 兜底残留。

**进程枚举**:`ps -Awwo pid=,ppid=,command=`(`-ww` 防截断;**不用** `-E`/`-e`,那会 dump env 泄 secret + 巨量)。

## 4. 归属(attribution)

per-runner profile 路径:`~/.flywheel/runner-state/<execId>/browser-tmp/agent-browser-chrome-<uuid>`。
- 注入点:`packages/claude-runner/src/TmuxAdapter.ts:337` 附近(已用 tmux `-e` 注入 `FLYWHEEL_RUNNER_STATE_DIR=<runner-state>/<execId>`)。在同处**无条件**追加 `-e TMPDIR=<runner-state>/<execId>/browser-tmp` 并 mkdir。
  - 现 `FLYWHEEL_RUNNER_STATE_DIR` 只在 `backend==="mailbox"` 分支写;TMPDIR 注入要**两分支都做**(提到 if/else 外)。
  - claude prompt 文件用绝对路径(`--append-system-prompt-file /var/folders/.../T/...`,spawn 前已解析)→ 不受 runner TMPDIR 改变影响。
- reaper 从 `--user-data-dir` 解析:path 段 `runner-state/` 之后那段 = `<execId>` → 查 StateStore。

## 5. Reaper 设计(对标 viewer-session-reaper)

**A. 归属型回收(boot + heartbeat tick 都跑,零启发式、零误杀)**:
- 命中 §3 选择器 + user-data-dir 在 `runner-state/<execId>/` 下 → 解析 execId → 查 StateStore:
  - 会话在 OUTCOME/终态(复用 `OUTCOME_STATUSES` 去掉 `approved_to_ship`,同 viewer-reaper)**或** 无 row → **SIGTERM main**。
  - 会话活着(running/pending/awaiting_review/approved_to_ship)→ **skip**。
- 这就是确定性「用完必关」:会话到终态,下一 heartbeat tick(HeartbeatService `setInterval`)内其 chrome 被回收。

**B. backlog 迁移(boot one-shot only,保守)**:
- 处理**不可归属**的 chrome(user-data-dir 不在 runner-state 下,如旧系统 `$TMPDIR` 残留 / Bridge 侧 ProofShot)。
- 只杀「明确弃用」:`ppid==1` **且** profile 目录 mtime idle ≥ grace(默认 10min,env 可调)。在用 QA chrome 秒级写 profile,10min idle 安全。
- 目的:清掉当前 39 个遗留 + 部署过渡期 pre-fix 残留;不误杀过渡期仍在用的 pre-fix chrome(它 profile 一直被写)。

**触发点**:
- boot one-shot:`plugin.ts` 里 viewer-session-reaper 挂载点旁(§ FLY-754 同位),跑 A + B。
- heartbeat tick:HeartbeatService tick 里(reapCrashedRunners 之后)跑 A。
- best-effort(失败进 errors 不抛)+ 每次 kill 写 audit event(`chrome_session_reaped`)+ kill-switch env `FLYWHEEL_CHROME_REAPER=0` 关,默认 ON。

**不做(v1)**:profile 目录 rm(内存是痛点非磁盘;per-runner 的随 runner-state 清;系统 $TMPDIR 的 OS 自清)——列为可选 follow-up。

## 6. 边界 / 风险

- **过渡期**:fix 部署那一刻起,新 runner 的 chrome 才带 per-runner TMPDIR;部署前起的 runner chrome 在系统 $TMPDIR(不可归属)→ 由 B 的 idle-grace 保护,不会被误杀在用的。fleet 循环一轮后全部可归属。
- **Bridge 重启不杀 runner**:boot 跑 A 时,活 runner 的 chrome(会话 running)→ skip;终态的 → 杀。正确。
- **QA slot / 别的 Bridge**:它们的 runner 有各自的 runner-state 路径,execId 在本 Bridge StateStore 无 row → 按「无 row = 孤儿」会被杀?**需守卫**:归属型回收里,execId 无 row 时要像 viewer-reaper 一样确认该 runner-state 归属**本 fleet**(路径在本机 `~/.flywheel/runner-state/` 下即本机;多 Bridge 共享同一 `~/.flywheel` 时需按 execId 是否本 Bridge 已知来判。plan 里细化:无 row 且路径在本机 runner-state → 视为本机孤儿可杀;这台机器单 `~/.flywheel`,QA slot 用隔离 FLYWHEEL_STATE_DIR/COMM_DIR,runner-state 路径也隔离)。
- **`about:blank`/短命 ProofShot**:Bridge 侧 publish-report 的 proofshot 短命自关,极少撞 B 的 idle-grace。

## 7. 测试策略

- **单测(reaper 核心,mock ps 输出)**:选择器精确性(Chrome-for-Testing 命中 / `claude` 含子串**不**命中 / 真 `/Applications/Google Chrome.app` 不命中 / renderer `--type=` 被筛掉只留 main);归属解析 execId;kill 规则(终态→杀、running→skip、无 row 孤儿→杀);B 的 idle-grace 边界;kill-switch off;best-effort 不抛。
- **单测(TMPDIR 注入)**:TmuxAdapter 两分支都追加 `-e TMPDIR=<runner-state>/<execId>/browser-tmp` + mkdir;rollback 分支也有;byte-compat 其余 env args。
- **QA 真机 E2E(终验 §2 的 TMPDIR 假设 + 端到端)**:真 spawn 一个 runner → 让它跑 visual-capture/agent-browser → 确认 chrome 的 user-data-dir 落在 `runner-state/<execId>/browser-tmp/` → 会话终态后确认下一 tick chrome 被 SIGTERM(前后 chrome 计数)→ 确认活 runner 的 chrome 不被碰 → 确认 Annie 真 Chrome.app 不被碰。

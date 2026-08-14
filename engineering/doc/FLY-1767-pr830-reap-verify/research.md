# FLY-1767 独立验证 PR #830 worktree 进程回收 — 调研

Issue: FLY-1767 (https://linear.app/geoforge3d/issue/FLY-1767/qafly-1759-独立验证-pr-830-worktree-进程回收最终-head-无-qa-verdict补验)
日期: 2026-08-14
基于: exploration.md

## 1. 被测物审计(frozen head `0aa43410`)

PR #830 = 36 文件 / +4120 −60。生产代码面只有五处:

| 文件 | 作用 |
| -- | -- |
| `packages/edge-worker/src/worktree-process-reaper.ts`(新增 538 行) | 回收器本体:cwd 普查 → ppid 后代闭包 → 组/点杀 → 有界收敛验证 |
| `packages/edge-worker/src/worktree-paths.ts`(新增 31 行) | 路径规范化 |
| `packages/edge-worker/src/WorktreeManager.ts`(+305 −60) | 四个拆除原语全部 reap-first |
| `packages/teamlead/src/bridge/{lifecycle-sweep,worktree-cleanup}.ts` | 把不完整回收写成 `worktree_reap_incomplete` 审计事件 |
| `.claude/orchestrator/lib/reap-worktree.sh` + `cleanup-agent.sh` | shell 侧同款 |

其余是测试(5 个 vitest 文件 + 2 个 shell 套件)、CI 接线、doc-flow 文档。

### 1.1 回收器的关键不变量(读源码得出,逐条在 plan 里变成用例)

- **枚举无关**:全文无进程名白/黑名单。命中判据 = cwd 在目标路径下(`root` 或 `root/`),
  再按 ppid 做后代闭包。
- **五道 guard**(`guardTarget`):绝对路径 / 深度 ≥3 段 / 必须是 expectedParent 的直接子目录 /
  basename 必须以 repo slug 前缀开头 / live 目标不得是 symlink 且 realpath 不得漂移。
  `rootProof: "gone"` 的目标反过来要求磁盘上不存在。
- **自我保护**(`protectedPids`):pid 1、自身 pid、以及自身向上的整条祖先链永不被信号。
- **组杀条件**(`wholeGroupOwned`):只有当整个进程组的**每个**成员都在候选集里、都不是
  受保护 pid、且身份(pid+lstart+command)与首次普查一致时,才 `kill(-pgid)`;否则点杀。
- **身份栅栏**(`rowIdentityEquals`):pid+lstart+command 三元组;不一致 → 记
  `identityMismatchSkipped` 并**跳过不发信号**(防 PID 复用误杀)。
- **有界**:`REAP_TOTAL_DEADLINE_MS = 25s`,TERM 宽限 5s / KILL 宽限 2s /
  最多 2 轮收敛;超时返回 `verified:false` + `survivors`。
- **fail-open**:`reapPath()` 捕获一切异常写成 `scanError`,`WorktreeManager` 照常删目录,
  只在 `isReapIncomplete()` 时 `logger.warn("worktree_reap_incomplete")`。
  teamlead 侧只写 StateStore 审计事件(带稳定 event_id 去重),**不拦删除、不转 quarantine、
  不发 Discord**。

## 2. 原 QA FAIL 的原文还原

从引擎账本取到(`session_events`,exec `19a2ef1e`,2026-08-14 04:47:14,
`{"status":"fail","predicate":"qa_failed","subjectHead":"1671a3f2..."}`)。

**产品行为当时就全部达标** —— 那一轮已经验过调用点 A/B/C、真 tmux、非枚举性、突变检验。
FAIL 的**唯一**理由是测试基建缺陷:

> `packages/edge-worker/src/__tests__/WorktreeManager.reap.real-tmux.test.ts` 第 60-74 行的
> tmux fixture 命令无效。现状用 `tmux -D -S sock new-session -d ...`,tmux 3.5a 实测 `-D`
> 与带 command 互斥,直接打 usage 并 exit 1,socket 永不出现 → 第 82 行断言恒失败。

三重影响(原文):
1. 任何装 tmux 且没设 CI 的主机上 edge-worker 全包恒红一例(1281 pass/5 skip/**1 fail**);
2. `skipIf` 里 `process.env.CI` 强制 false 导致 CI 永远跳过,这个红项 CI 看不见会一路进 main;
3. 文件名宣称真 tmux 覆盖**实际零覆盖**,而 tmux 恰是事故里活了 5 天的逃逸者。

另有三条非阻塞观察:(a)普查开销 lsof≈375ms/ps≈130ms,高负载下可能撞 execFile 10s 超时走
fail-open;(b)reap-first 后若 git remove 被拒会出现「进程已杀、目录还在」的中间态;
(c)里程碑文案称 9 个场景在受限 macOS runner 跳过,与实测不符。

## 3. 返工到底改了什么(`1671a3f2` → `0aa43410`)

```
 .github/workflows/ci.yml                                    |  10 +-
 engineering/doc/FLY-1759-.../progress.md                    |   6 +-
 packages/edge-worker/src/__tests__/...real-tmux.test.ts     | 220 +++++---
```

**生产源码零改动。** 这一条很重要:Codex code review 在 `1671a3f2` 上 APPROVED,而返工只动了
一个测试文件 + CI workflow + 进度台账 —— 也就是说 review 覆盖过的生产面在最终 head 上逐字未变。

测试文件的实际修法比原 QA 建议的「删掉 `-D` 一个 flag」更彻底,六处:

1. 去掉 `-D`,并改用**同步** `execFileSync` —— 畸形调用当场抛出并带上 tmux 自己的 stderr,
   而不是静默地在一个永不出现的 socket 上超时;
2. 断言对象从 **client pid** 换成 `display-message -p '#{pid}'` 取到的**真 server pid**
   (client 无论如何 ~1s 就退出,对它断言是空过绿);
3. `skipIf` 改由真实能力探针驱动(`tmux -V` / 全局 `ps`),不再看 `process.env.CI`;
   **CI 上缺工具直接 throw**(「must not be skipped on CI」),不许静默跳过;
4. fixture 根锚到 `/tmp` 并显式断言 socket 路径 < 104 字节(macOS AF_UNIX `sun_path` 上限;
   本机 `TMPDIR` 是 88 字符的 per-session 路径,不锚短就会以「File name too long」诡异失败);
5. socket 路径在 tmux 启动**之前**记录,`afterEach` 先 `kill-server` 再按 pid/组兜底 ——
   这个套件自己绝不能泄漏一个 tmux server;
6. 超时 20s → 60s(10s 启动 + 10s pid 轮询 + 回收器自己的 25s 预算 = 45s 最坏情况)。

CI 侧:edge-worker job 的依赖安装从 `lsof` 扩到 `lsof tmux`;script-tests job 显式列出
两个 FLY-1759 shell 套件(该 job 不做 glob 发现,不列 = 不跑)。

## 4. 已知的 Codex advisory(非阻塞,已记 follow-up)

code review 留了 6 条 MEDIUM/LOW:①共享 tmux server 爆炸半径防护 ②lifecycle reap 审计周期化
③shell 终验排除受保护 PID ④`pruneOrphans` 锁时长上界 ⑤reconciler 收割证据持久化
⑥lsof 解析 NUL-safe。本次 QA 对 ① 做了独立的跨组实测(见 qa-report L 组);其余照旧挂 follow-up。

## 5. 验证工具链

- 被测源码用 `tsx` 直接从 `flywheel-FLY-1759` worktree 的 **TS 源**导入(不经 dist,保证测的是
  frozen head 的字节)。
- 自建 harness 全部落在 scratchpad,仓库零写入;运行前后各核一次 `git rev-parse HEAD` +
  `git status --porcelain`。
- `TMPDIR` 必须临时设为 `/tmp` —— 否则连 `tsx` 自己的 IPC unix socket 都会撞
  `sun_path` 上限(EINVAL),这本身就是第 4 条修法的旁证。

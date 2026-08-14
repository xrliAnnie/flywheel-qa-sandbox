# FLY-1767 独立验证 PR #830 worktree 进程回收 — QA 报告

Issue: FLY-1767 (https://linear.app/geoforge3d/issue/FLY-1767/qafly-1759-独立验证-pr-830-worktree-进程回收最终-head-无-qa-verdict补验)
日期: 2026-08-14
基于: plan.md

## 结论:**PASS**

被测:PR #830 `flywheel-FLY-1759` @ **`0aa43410477e329cc91c42d2ca7e349196cf49e4`**
(开跑前与收工后各核一次,head 未漂;PR 非 draft、MERGEABLE、mergeStateStatus=CLEAN)

原 QA 的**唯一阻塞项已实证关闭**,且关得比当初建议的更彻底。产品行为在我自建的、
与上一轮无关的 harness 上全部复现通过,含上一轮没覆盖的第四个调用点。所有硬门全绿。

---

## 1. 硬门清单

| 门 | 结果 | 证据 |
| -- | -- | -- |
| 自建独立 harness(5 组) | **129 assertions / 0 failed** | 下文逐组 |
| 突变检验(回归防线非空) | **8 例变红**(含 real-tmux) | §4 |
| PR 自带套件 @ frozen head | edge-worker **1282 pass / 5 skip / 0 fail**(111 文件,119.6s) | §5 |
| teamlead bridge sweep+cleanup | **26 / 26** | §5 |
| 两个 shell 套件 | **4/4** 与 **7/7** | §5 |
| `pnpm lint` | **0 error**(2439 文件,7 warning,均为既有 suppression 提示) | §5 |
| 改动包 build | exit 0 | §5 |
| `gh pr checks 830` | **9/9 pass**,run `31785229770` `head_sha=0aa43410`,conclusion=success | §5 |
| Codex code review | APPROVED @ `1671a3f2`;**到 `0aa43410` 的增量生产源码为零** | §6 |
| 被测分支零写入 | 跑前跑后 `git status --porcelain` 均为空,HEAD 未动 | §7 |

---

## 2. 变更前基线 —— 先证明 bug 是真的(否则绿测无意义)

同一个 fixture,走**旧**拆除形态(裸 `git worktree remove --force` + `rm -rf`,无回收):

```
PASS  baseline: all 3 fixture processes started — chain=14925 plain=14926 orphan=14946
PASS  baseline: orphan really reparented (ppid=1) — ppid=1
PASS  baseline: cwd census sees the worktree — cwd=/private/tmp/q1767-base-YnyFuO/flywheel-FLY-1759
PASS  baseline: directory is gone
PASS  BUG REPRODUCED — processes survive the old teardown — chain=true plain=true orphan=true
PASS  baseline: 8-13 incident signature (ppid=1 + cwd in a deleted worktree) — ppid=1 cwd=.../flywheel-FLY-1759
```

**目录删掉了,三个进程全活着,孤儿 ppid=1 且 cwd 还指着已删路径** —— 与 8-13 事故巡检
拿到的签名一致。这就是对照组。

## 3. 修复本体 —— 四个生产原语,真进程,独立复验

判据不看被测代码的返回值,而是逐 PID `kill(pid, 0)` 要 ESRCH。

| 调用点 | 结果 | 关键证据 |
| -- | -- | -- |
| **A** `remove()`(`.removing-*` 改名路径) | PASS | `matched:4 reaped:[17564,17565,17572,17645] survivors:[] verified:true`;后代闭包(zsh→sh→sleep)整棵灭;目录删净 |
| **B** `removeCleanWorktreeByPath()`(`git worktree remove`) | PASS | `removed:true`;`matched:4 survivors:[] verified:true` |
| **C** `removeWorktreeForce()`(quarantine 后) | PASS | 目标先弄脏;`removed:true`;`survivors:[]` |
| **D** `removeIfExists()` **orphan 分支** | PASS | 上一轮 QA **未覆盖**。该 API 只返 `boolean`,所以判定完全靠真 PID:`chain=false plain=false orphan=false`,orphan 目录删净 |
| **E** 真 tmux server | PASS | ppid=1、cwd 在 worktree、**socket 故意放在 worktree 外**(证明命中靠 cwd 不靠 fd);`reaped` 含 server pid;`kill(pid,0)` ESRCH |

每一组都带 cwd 在主仓的阴性对照进程,全部存活。

### 3.1 作用域 / 爆炸半径

| 用例 | 结果 |
| -- | -- |
| 兄弟 worktree(`flywheel-FLY-2`)里的进程 | **存活** |
| **前缀混淆**路径(目标 `flywheel-FLY-1` 是 `flywheel-FLY-12` 的严格字符串前缀) | **存活**,`matched` 恰为 1 |
| 主仓进程 | **存活** |
| ppid 闭包:父 cwd 在 worktree、子 `cd /` 后 exec(普查看不见子) | 子**也被收掉** — `matched:1 reaped:[2444,2593]` |
| 跨组:组长 cwd 在主仓、成员 cwd 在 worktree、二者同 pgid(`leaderPgid=21858 memberPgid=21858` 实测) | 成员死、**组长活** — 不做 `kill(-pgid)` |
| guard 拒绝 ×7:前缀不符 / 非直接子目录 / 相对路径 / 深度不足 / symlink / realpath 漂移 / gone-proof 但目录还在 | 全部 `refusedReason` + **零信号**;末尾阳性对照证明同一受害者在合法 target 下确实会被收(不是空过绿) |
| 自身进程链(把 harness 自己的 cwd 切进目标) | 自己**活下来**、不在 `reaped` 里、真受害者照杀、summary 诚实报 `verified:false` |
| PID 复用(注入两次普查间身份变化) | `identityMismatchSkipped:1`,**一个信号都没发**,不宣称成功 |

### 3.2 fail-open 与有界

| 用例 | 结果 |
| -- | -- |
| 普查抛异常(模拟 lsof 不可用) | `scanError` + `verified:false` + **零击杀** |
| 注入抛异常的 reaper 进 `WorktreeManager` | 目录**照删**(fail-open 真的开着)、错误留档 `reaper threw: ...`、进程**没被误杀** |
| 永不死的目标 + 虚拟时钟 | 返回而非挂死,虚拟耗时 **7000ms ≤ 25000ms** 预算,`verified:false`,survivors 含它,带 `verifyError` |
| reap-first 顺序:弄脏目标让 `git worktree remove` 被拒 | 观察到中间态 **进程已死 + 目录还在** → 回收确实发生在文件系统动作**之前** |
| `.removing-*` 崩溃残留(Bridge 在 rename 与 rm 之间死) | 残留路径与新占用的原路径**各自**成为 reap target,两边进程都收掉,两条记录都 `verified:true` |

### 3.3 8-13 事故重放

一个 worktree 同时种四个泄漏家族,**一次** `remove()`:

```
planted: 3×node 常驻(vitest pool worker 形态)+ 2×double-fork ppid=1 守护(codex app-server 形态)
         + 1×真 tmux server + 1×zsh→sh→sleep 链 + 1×plain sleep   → 9 个 pid
teardown: 2372ms
summary : matched:10 reaped:[…10 pids…] survivors:[] verified:true
verdict : 每个 planted pid 独立 kill(pid,0) 全 ESRCH;仓库内对照进程存活;目录删净
```

---

## 4. 突变检验 —— 回归防线不是空过绿

不改仓库任何字节,用 scratchpad 的 vitest config 把 reaper 别名到「什么都不扫、什么都不杀,
但报告 `verified:true`」的空实现(= 精确复刻修复前行为,只是穿了成功外衣):

| | 未突变 | 突变后 |
| -- | -- | -- |
| `WorktreeManager.reap.e2e.test.ts` + `...real-tmux.test.ts` | 10 passed | **8 failed / 2 passed** |

剩下 2 个绿的正是两个**阴性对照**(同路径重建、symlink 拒绝),它们本来就断言「不许杀」。

**其中 real-tmux 那一例也变红了** —— 这正是原 FAIL 第 (3) 条「宣称真 tmux 覆盖、实际零覆盖」
的直接闭环证据:它现在是真覆盖。

**突变 harness 自身的阳性对照**:同一份 config 跑不依赖 reaper 的 `WorktreeManager.test.ts`,
**58/58 仍全绿** —— 所以「变红」是覆盖的证明,不是我把环境搞坏了。

> 顺带一笔:`WorktreeManager.reap.test.ts`(4)与 `WorktreeManager.convergence.test.ts`(3)
> 在突变下**仍然绿**。它们注入自己的 reaper stub,属于接线单测,不构成对该回归的防线。
> 真正的防线是 e2e + real-tmux 这 10 例。

---

## 5. 原 QA FAIL 项 —— 逐条闭环

| 原 FAIL 判据 | 现状 | 证据 |
| -- | -- | -- |
| `tmux -D -S sock new-session -d …` 在 3.5a 上无效 | **已消** | 逐字重放旧 argv:`exit=1`,stderr = `usage: tmux [-2CDlNuVv] …`,5s 轮询后 socket 仍不存在(旧断言恒 false);去掉 `-D` 的新写法 `exit=0` 且 socket 真出现 |
| 影响(1)装 tmux 且非 CI 的主机上全包恒红一例(1281 pass / **1 fail**) | **已消** | 本机 edge-worker 全包 **1282 passed / 5 skipped / 0 failed** |
| 影响(2)`skipIf` 的 `process.env.CI` 短路 → CI 永远跳过 | **已消** | 旧源码 `if (process.env.CI) return false` 已删;新版 `describe.skipIf(skipReason !== null)` 由真实能力探针驱动;**CI 上缺 tmux/ps 直接 throw**(`must not be skipped on CI`) |
| 影响(3)文件名宣称真 tmux 覆盖、实际零覆盖 | **已消** | ① 该文件在本机**真跑并通过**(1 test, 3.2s,非 skip);② 断言从必死的 client pid 改绑 `display-message -p '#{pid}'` 的真 server pid,断言它在 `reaped` 且 `survivors=[]`;③ 突变下它**变红** |
| 附带建议:CI 装 tmux 打开这条覆盖 | **已采纳** | edge-worker job `apt-get install -y lsof tmux`;script-tests job 显式列出两个 FLY-1759 shell 套件 |

原 QA 的三条非阻塞观察,我复测的结论:

- **(a) 普查开销**:本机 load **16.15**、1023 进程下,`listSystemCwds()` 实测 **421ms / 809 行**,
  远在 `execFile` 10s 超时内。极端负载下若真超时,走的是 `scanError` fail-open 分支
  (§3.2 已实测:不阻塞删除、不误杀、留审计)。
- **(b) reap-first 中间态**:**实测复现**(§3.2 O 组)。生产该路径只对 clean/merged worktree
  调用,风险低;这是设计取舍不是缺陷。
- **(c) 里程碑文案说 9 例在受限 macOS runner 跳过**:与实测不符,本机 9 例全部真跑。建议
  按实测更正口径(文案问题,不阻塞)。

---

## 6. 回归与 CI

| 项 | 结果 |
| -- | -- |
| edge-worker 全包 @ `0aa43410` | **1282 passed / 5 skipped / 0 failed**(111 文件,119.6s;5 skip 均为需要外部凭据的既有 live 用例) |
| FLY-1759 五个 reap 测试文件 | **34 / 34**(e2e 9、real-tmux 1、reaper 单测 17、convergence 3、reap 4) |
| teamlead `lifecycle-sweep` + `worktree-cleanup` | **26 / 26** |
| `scripts/__tests__/test-reap-worktree-lib.test.sh` | **PASS=4 FAIL=0**(含真 shell/sleep 子孙闭包) |
| `scripts/__tests__/test-worktree-removal-contract.test.sh` | **PASS=7 FAIL=0**(含「注入一条无锚点的裸删除必须让守卫变红」的突变对照) |
| `pnpm lint` | 2439 文件,**0 error**,7 warning(既有 suppression 提示) |
| `packages/edge-worker` build | exit 0 |
| `gh pr checks 830` | **9/9 pass**;run `31785229770`,`head_sha=0aa43410…`,conclusion=`success`,created 2026-08-14T08:45:33Z |

### Codex code review 的口径(重要,请 Tadashi 过目)

review 是在 `1671a3f2` 上 APPROVED 的,之后 head 漂到了 `0aa43410`。我核过这段增量:

```
.github/workflows/ci.yml                                 |  10 +-
engineering/doc/FLY-1759-.../progress.md                 |   6 +-
packages/edge-worker/src/__tests__/…real-tmux.test.ts    | 220 +++++---
```

**生产源码零改动** —— review 覆盖过的生产面在最终 head 上逐字未变。增量只有一个测试文件、
CI workflow 和进度台账。要不要为这段测试增量再补一轮 Codex,是 Tadashi 的判断;
我没有替他决定,也没有替他豁免。

---

## 7. 隔离与卫生

- 被测 worktree `flywheel-FLY-1759`:开跑前 `HEAD=0aa43410 status=[]`,收工后
  `HEAD=0aa43410 status=[]` —— **零字节写入,零 commit,未做任何 checkout**。
- 被测源码经 `tsx` 直接从该 worktree 的 **TS 源**导入(不经 dist),保证测的是 frozen head。
- 所有 fixture 落在 `mktemp -d /tmp/q1767-*` 的独立 git repo;未碰 `~/.flywheel`、
  未碰 9876 端口、未跑 `restart-services.sh`、未动生产 Bridge(收工时 `/health` 正常)。
- **这个 QA 自己没有泄漏它在测的东西**:收工核 `/tmp/q1767-*` 无残留目录,
  `ps` 里无残留 fixture 进程。

### harness 自纠(诚实记录)

我的 harness 在过程中有 4 处自身缺陷,都在定案前查清并修掉,没有一处被写成产品结论:

1. `zsh -c 'sh -c sleep'` 被 exec 优化成单进程 → 「链有后代」断言失败。改为 `… & wait` 造真三代。
2. `zsh -c 'cd / && sleep & wait'` 的 `cd /` 其实改的是**父** shell 的 cwd(zsh 没为该 AND-list
   fork 子 shell)→ 普查 `matched:0`。改为 `(cd / && exec sleep) & wait`。
3. 跨组用例里组长写成 `… & wait`,成员一死组长**自然退出** —— 差一点被读成「误杀组长」的
   假发现。改为组长自己持有独立 `sleep`,并补一条 `pgid` 相等的前置断言。
4. 突变别名用了部分匹配正则,只替换了子串,产出 `.//private/tmp/…` 解析失败 → `no tests ran`。
   这是**假的**突变结果;改为整串匹配,并补「突变 harness 自身的阳性对照」。

---

## 8. 非阻塞观察(建议记 follow-up,不阻塞 ship)

**O-1 未被 `wait()` 的僵尸子进程会让回收报「不完整」。**
形态:目标 worktree 里的进程,其父进程在**目标之外**(所以不被杀)且不 `wait()` 回收子进程。
实测:成员被 SIGTERM 杀掉后变成僵尸(`state=Z rss=0KB`),而 `kill(pid,0)` 对僵尸**成功**,
于是回收器认为它还活着 → 耗完 TERM 5s + KILL 2s + 收敛轮 ≈ **7.8s**,最后报
`verified:false survivors:[…] verifyError:"processes survived SIGKILL grace"`。

- **不构成 ship 阻塞**:僵尸不占地址空间(实测 RSS=0),本单要治的内存泄漏已经治住;
  且行为 fail-open —— 我在同一形态下实测 `removeCleanWorktreeByPath` 仍 `removed:true`、
  目录删净。teamlead 侧对不完整回收也只写一条带稳定 event_id 的 StateStore 审计事件,
  **不拦删除、不转 quarantine、不发 Discord**。
- 代价是每次撞上多花 ~8s 拆除时间 + 一条噪音审计。若将来 `worktree_reap_incomplete`
  被接进告警,建议先把「僵尸(state=Z)视同已死」这一条补进存活判定,否则会有假告警。
- 生产触发概率不高:事故里的真实形态是 ppid=1 孤儿(init 会立刻收尸),而 Node 父进程
  由 libuv 自动收尸。需要一个「活着的、不收尸的、在目标外的父进程」才会遇到。

**O-2 已知 Codex advisory 6 条**(共享 tmux server 爆炸半径 / lifecycle reap 审计周期化 /
shell 终验排除受保护 PID / `pruneOrphans` 锁时长上界 / reconciler 收割证据持久化 /
lsof 解析 NUL-safe)照旧挂 follow-up。其中「共享 tmux server 爆炸半径」我这轮做了独立跨组
实测(§3.1),当前实现的组杀条件是安全的。

---

## 9. 诚实边界

- 只在 **macOS 26 / tmux 3.5a / 本机(load ~16、1023 进程)** 上做真机验证。
- **没有 Linux 主机可复跑**;Ubuntu 侧行为以 CI 为准(9/9 绿,且本 PR 已把 tmux 装进 CI,
  那条真 tmux 覆盖在 Linux 上现在会真跑)。真 Linux 的 `(deleted)` cwd 语义我没在真 Linux 验过。
- **未做 24h 浸泡观察** —— 属 ship 后自然观察项。
- `spin.md` / `orchestrator.md` 的提示词改动只由合同测试静态守住锚点存在性,
  **未在真 orchestrator 跑动中验证**。
- 本节点合同:**verdict 不进引擎**。以上结论交 flywheel-eng-lead,作为 founder 批 #830 的输入。

## 10. 复现方式

harness 全部在
`/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1767/9ac0f90d-…/scratchpad/`:
`lib.ts`(fixture 工具)、`s1-callsites.ts`、`s2-adversarial.ts`、`s3-origfail.ts`、
`s4-boundary.ts`、`s5-replay.ts`、`mutant-reaper.ts` + `vitest.mutant.config.ts`。

```bash
cd /Users/xiaorongli/Dev/flywheel-FLY-1759
TMPDIR=/tmp ./node_modules/.bin/tsx <scratchpad>/s1-callsites.ts     # 41/41
TMPDIR=/tmp ./node_modules/.bin/tsx <scratchpad>/s2-adversarial.ts   # 37/37
TMPDIR=/tmp ./node_modules/.bin/tsx <scratchpad>/s3-origfail.ts      # 20/20
TMPDIR=/tmp ./node_modules/.bin/tsx <scratchpad>/s4-boundary.ts      # 21/21
TMPDIR=/tmp ./node_modules/.bin/tsx <scratchpad>/s5-replay.ts        # 10/10
```

`TMPDIR=/tmp` 是必需的:本机 `TMPDIR` 是 88 字符的 per-session 路径,不设短根连 `tsx`
自己的 IPC unix socket 都会撞 `sun_path` 104 字节上限 —— 这本身就是修复第 4 点
(fixture 锚到 `/tmp` + 显式断言 <104 字节)的旁证。

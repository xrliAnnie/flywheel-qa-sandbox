# FLY-1252 自动切号 robust 化 — QA 报告(PR #618 PR-A)

Issue: FLY-1252 (https://linear.app/geoforge3d/issue/FLY-1252)
日期: 2026-07-16(round 1) / 2026-07-17(round 2 re-test)
基于: plan.md, research.md, exploration.md, 本分支 implement phase 已提交的代码
(round 1 @ f9bd04feb → **round 2 @ 90db2ff07**)

---

# ROUND 2 RE-TEST 结论(2026-07-17 @ 90db2ff07)— **PASS**

round 1 的两个阻塞项**都已真修复并经突变对照证实**。详见 §11。
round 1 的正文(§1-§10)保留原样存档;**§9 红线 ① 的表述有误,已在 §11.4 更正**。

---

**结论: FAIL(kickback)** — 上一轮 QA 的阻塞项 ③(Node 锁忙等)**已真正修复并经突变对照证实**;
但本轮在**同一把锁的 bash 侧**发现**同一个 bug 类的孪生缺陷**,且**由本 PR 亲手引入**:
`flywheel-claude-profile` 的锁获取循环在 stale 分支上**无上限、无退避、无 fail-loud**,
一旦锁被 `.stale-break.*` 残留污染就**永不返回**,并把这把锁**对 bash 与 Node 双双毒死**,
直到人肉 `rm -rf`。这正是 FLY-1252 要根治的失效类(卡死进程 → 切不了号 → founder 手动救),
**阻塞 ship**。另有一个已提交的事故重放 e2e 在本 head 崩溃。其余核心修复全部验证通过。

---

## 1. 🔴 阻塞项 A(HIGH)— bash 锁获取循环无界忙等(advisory ③ 的 bash 孪生,**本 PR 引入**)

**文件**: `packages/claude-runner/bin/flywheel-claude-profile:379-383`

```bash
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if lock_is_stale; then break_stale_lock || true; continue; fi   # ← 跳过下面两行
  [[ $(now_ms) -ge $deadline ]] && fail "timeout acquiring lock $LOCK_DIR"
  sleep 0.05
done
```

stale 分支的 `continue` **同时绕过 deadline 检查与 50ms 退避**。只要出现
「`lock_is_stale` 持续为真 且 `break_stale_lock` 持续失败」的状态,`LOCK_TIMEOUT_MS`
**永远不会触发** → 无界、fork 密集的自旋。

**这是本 PR 新增的代码**,不是历史遗留:
`git diff origin/main...HEAD` 显示 `break_stale_lock()` 与
`if lock_is_stale; then break_stale_lock || true; continue; fi` **两者都是本 PR 的 `+` 行**。
Node 侧同类缺陷(上一轮 QA 的 advisory ③)已修(`mkdir-lock.ts:286` 非-EEXIST 立即抛;
等待分支恒查 deadline + sleep)——**bash 侧没跟上,而两边共用同一把锁**。

**可达触发路径(自伤且不可自愈)**:
`break_stale_lock`(`:207-209`)先把 holder marker `mv` 成 `$LOCK_DIR/.stale-break.$$.$RANDOM`,
再 `rm -f` 它。**breaker 在 mv 与 rm 之间被杀**(Ctrl-C——新的 trampoline 会把 SIGINT 转发整个进程组;
SIGKILL;崩溃;断电;acquire 期间 `LOCK_HELD=0` 故 EXIT trap 不清理该 claim)→ claim 文件成为孤儿。
此后:
- **bash**: `holder.*` glob 不匹配 `.stale-break.*` → 无 holder → 目录 mtime > 120s → 判 stale →
  `rmdir` 恒 ENOTEMPTY → **无限自旋,永不超时**;
- **Node**: `inspectLock` 同样过滤掉该名字 → 视作 empty → 判 stale → `rmdirSync` ENOTEMPTY →
  `removed=false` → sleep → **每次获取都在 deadline 后抛 timeout**。

全仓 grep 确认**没有任何代码路径回收 `.stale-break.*` 残留** → 自动切号彻底瘫痪直到人工干预。
同一分支的第二条触发路径:等待期间锁的父目录消失(`mkdir` ENOENT 被 `while ! mkdir` 当作竞争,
`lock_is_stale:167` 判「目录没了 → free」= stale,`rmdir` ENOENT → 同样无限自旋)——
这正是 Node 侧已修的「父目录缺失忙等」的 bash 版本。

**独立复现(两臂实验,含阳性对照)**
脚本: `engineering/doc/FLY-1252-auto-switch-robust/qa/qa-fly-1252-bash-lock-stale-spin.sh`
(hermetic:scratch pool/store/lock + 桩 security/alert/guard/freshness;`FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS=2000`)

| 臂 | 构造 | 结果 |
|---|---|---|
| **CONTROL(阳性对照)** | 锁被**真活着**的 holder 持有 | **2418ms 退出**,原话 `Error: timeout acquiring lock …` — deadline 正常、且**证明 harness 确实走到了获取循环** |
| **WEDGED** | 锁内留 `.stale-break.424242.7` 孤儿 + mtime 回拨到 2020 | **SPINNING** — 超过 10s 预算仍不退出,被看门狗杀掉 |

**阳性对照是这个结论的命根子**:没有它,「进程不退出」也可能只是 harness 根本没走到锁循环。
本次对照写对之前**连踩两次假绿**,都被对照自身的断言挡下并已固化进脚本:
① pool 布局写错(应为 `pool/<name>/.credentials.json`)→ 控制臂死在 "pool profile not found",从没进锁循环;
② holder marker 的 `processStartTime` 用了 `tr -s ' '`(挤压内部空格),与脚本自己的
`process_start_time()`(`:138-140`,只 trim 首尾)不一致 → 被判 PID 复用 → 「活 holder」被当 stale 破锁 →
控制臂反而**切号成功**。脚本现在**硬断言控制臂必须以 `timeout acquiring lock` 落地**,否则 exit 2 判 INVALID。

**期望 vs 实际**: 期望 = 任何分支都在 `LOCK_TIMEOUT_MS` 内 fail-loud;实际 = 静默无限自旋 + 锁被永久毒死。

**严重度**: HIGH。触发条件是异常态,但一旦触发:`flywheel-claude-profile use/next` 永不返回、
自动切号与手动切号**同时**瘫痪、且**无自愈路径**。这与本 issue 的原始事故同构
(卡死 → Lead 切不了号 → 要 Annie 老公人肉救),等于把 FLY-1252 要消灭的失效类**换个位置又装回去**。

**修复方向(小改,implementer 定)**: ① stale 分支同样受 deadline 约束并 `sleep` 后重试;
② `break_stale_lock` / `find_holder_marker` 回收超龄 `.stale-break.*` 残留。
核心与 ③ 同:**acquire 循环任何分支都不得无界紧忙等**。修完本脚本应转绿。

## 2. 🔴 阻塞项 B(MEDIUM-HIGH)— 已提交的事故重放 e2e 在本 head 崩溃

**文件**: `scripts/qa-fly-1252-quota-state-e2e.sh:346` 与 `:374`

该脚本第 5 段(daemon 观察投影 + CUTOVER-off legacy 回滚)**必崩**:

```
TypeError: Cannot read properties of undefined (reading 'outcome')
    at executeSwitch (account-heal/account-switch-repair.js:95)
    at runLegacyScenario (runtime-replay.mjs:155)
```

**根因**: R15#1/R16#1 把锁 seam 统一成 `withAccountsLock` 后,`SwitchDeps.withLock` 的契约变成
返回**带标签的** `LockRunResult<T>`(`{kind:"ok",value} | reconciled | blocked`,`accounts-lock.ts:18-31`);
`switchAccount` 用 `switch (locked.kind)` 穷尽匹配(`switch-executor.ts:344`)且**没有 default 分支**。
而该 e2e 仍注入改造前的桩 `withLock: async (_path, fn) => fn()`(返回裸值,无 `.kind`)→
switch 无 case 命中 → `switchAccount` **静默返回 undefined** → 下游 `result.outcome` 崩。
TypeScript 的穷尽性让编译器满意,所以这个契约漂移**编译期抓不到**。

**影响**:
- 前 4 段(事故重放本体 / 手动 bypass 响亮可审计 / healthy 观察播种)**仍 PASS**,第 5 段起崩;
- **Lead QA scope 项 ⑤(撤 CUTOVER 后 legacy 读真数据)在本 head 失去唯一 e2e 证据**;
- 上一轮 QA 报告 §2.2 记录的「hermetic e2e 事故复现 — exit 0,3 段 PASS」**在本 head 已不成立**。
- 确认与环境无关:`env -i` 下同样必崩;CI **不**跑该脚本(`.github/` 无引用),故不会红 CI。

**非生产缺陷**:生产把 `withLock` 接的是真 `withAccountsLock`,`.kind` 恒合法。
但一个 409 行、为本 issue 而写的事故重放交付物**在 head 上跑不起来**,且 PR body 的
Verification 段并未声称它通过(只声称 switch-robust e2e)——即证据缺口是真实的。

**修复方向**: 两处桩 → `async (_path, fn) => ({ kind: "ok", value: await fn(lease) })`(2 行)。
另建议(implementer 定)给 `switch (locked.kind)` 加 default → fail loud,
把「静默 undefined」变成一句响亮错误;否则下一次契约漂移仍会在几百行外炸。
配套探针已提交: `qa/qa-fly-1252-lockresult-contract.mjs`(~1s 复现该 seam,不用跑 400 行 e2e)。

## 3. 上一轮阻塞项 ③(Node 锁忙等)— ✅ 已真正修复(突变对照证实)

| 步骤 | 结果 |
|---|---|
| 现 head 跑 `qa/qa-fly-1252-lock-busyloop.sh` | **PASS** — `SETTLED=THREW:ENOENT… elapsedMs=0`(有界、fail-loud) |
| **突变对照**:把 dist 的 `mkdir-lock.js` 改回改前的 `ENOENT → continue` | **FAIL** — `%cpu=99.2`,6s 预算内不退出 |
| 还原 dist | 复绿;`git status` 干净,src 未动 |

修法 = 恢复 `if (code !== "EEXIST") throw err`(`mkdir-lock.ts:286`)即改前的 fail-loud 语义;
另一条 ENOENT 路径(marker 写入失败,`:348-352`)现受 deadline 约束并退避。
**探针是 load-bearing 的**(改回 bug 就红),故这条 PASS 不是空过的绿。

## 4. 其余验证 — 全 PASS

| 项 | 命令 | 结果 |
|---|---|---|
| teamlead FLY-1252 定向套件(20 文件) | `vitest run --testTimeout=20000` | **297/297**(×3 轮) |
| claude-runner bash 集成 | `vitest run test/claude-profile.test.ts --testTimeout=60000` | **68/68**(×2 轮) |
| switch-robust 事故重放 e2e | `bash scripts/qa-fly-1252-switch-robust-e2e.sh` | **PASS**(9 passed / 59 skipped) |
| guard 突变对照(A 阳性 / B 修复 / C 突变复现事故) | `qa/qa-fly-1252-guard-mutation.sh` | **ALL PASS** — guard 判定 load-bearing |
| setup-quota-monitor 契约 | `scripts/__tests__/setup-quota-monitor.test.sh` | **14/14** |
| wrapper 契约 | `scripts/__tests__/quota-monitor-wrapper.test.sh`(`env -i`) | **5/5**(见 §6) |
| feature-flag registry + drift | `packages/config` vitest | **16/16** |
| typecheck | `packages/teamlead` `tsc --noEmit` | exit 0 |

### 4.1 安全默认逐条核实(对**代码**,非对文档)

| 声称 | 结论 | 证据 |
|---|---|---|
| `degradedSwitch` 默认 false | ✅ | `quota-monitor-config.ts:27`(缺失/非法回退)+ `:73`(`?? false`);唯一落地闸 `quota-monitor.ts:1019-1026`。两处默认一致,无第二个分歧读者 |
| `FLYWHEEL_QUOTA_DEGRADED_SWITCH=0` 即时压制 | ✅ | `quota-monitor.ts:1022`,仅精确 `"0"` 压制;未设 ∧ config 默认 false ⇒ 无法被 env 单独打开 |
| wake 只发给 `wakeProtocol>=1` 的 daemon | ✅ | `quota-daemon-wake.ts:69`(`?? 0 < 1` → noop)。main 上的 pidfile 无该字段 ⇒ 老 daemon 恒 noop,**绝不 SIGUSR1 无 handler 的进程** |
| `{pid,uid,processStartTime}` 三元组 + PID 复用防护 | ✅ | `:64`/`:68`(uid)、`:70-72`(startTime 不符 → noop);`ps` 失败 → null → fail-closed |
| `FLYWHEEL_QUOTA_WAKE=0` kill-switch | ✅ | `:53`/`:58`,先于任何 pidfile 读与 kill |
| handler 先装、能力后发布;撤销反向对称 | ✅ | `quota-monitor-cli.ts:151` 装 handler → `:154-157` 发布 pidfile;release 闭包 `:163-168` 先 unlink pidfile 再 `off` |
| env 全缺席 → 单发 unified、无 mention、逐字兼容 | ✅ | `quota-monitor-alert.ts:139-141`/`:148-152`;primary argv 与 main 逐字一致(注:TS 返回类型由 throw 改为 `DeliveryReport`,是 episode 机制的刻意改动) |
| severe==unified 去重 | ✅ | `:150` 精确串相等 → 只发 primary |
| 新 flag 已注册 + drift 测试守卫 | ✅ | `registry.ts:183-226`;drift 测试扫生产 src 的 `process.env.FLYWHEEL_*`,未注册即红 |

### 4.2 scope 澄清 — P7 身份核验**不在本 PR**

plan §3.6 的 P7(`FLYWHEEL_ACCOUNT_IDENTITY_CHECK`、`/api/oauth/profile`、exit 34/36/37/38)
**在代码中零存在**(全仓 grep 确认);实际 exit 映射只有 30/31/32/39。这与 PR body
「P7 deliberately excluded, will ship as a separate default-OFF PR」一致,**不是缺陷**。
但据此:任何「身份核验默认 OFF」的说法是在引用 plan 而非引用本 diff,评审/验收时不应记在 #618 头上。

## 5. 未独立验证 / 供 implementer 判断(非本轮阻塞)

以下由并行的对抗式 code review 提出,**我未逐条独立复现**,如实标注:

- **MEDIUM — journal reconcile 只凭 `kill(-pgid,0)` 判 writer_alive**(`flywheel-claude-profile:825-826`):
  `write_transition_journal` 记了 `leaderPid`/`leaderStartTime` 却在 reconcile 时**从不使用**;
  崩溃留下的 journal 可能搁置数小时,期间 pgid 被任意新进程组复用 → 恒判 `writer_alive` →
  自动切号永远 `transition_journal_writer_alive`、手动 use/next/capture 全部拒绝,且无 age 上限、无操作员逃生口。
  (plan §195 确实选了 pgid 探测 fail-closed,故属部分「已接受设计」;但 journal 里那两个身份字段
  正是用来否证复用的,现在是死数据。)
- **MEDIUM — `FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL` 未被子进程 env 洗掉**:
  `applyProfile` 刻意删除 `FRESHNESS_BYPASS`/`QUOTA_BYPASS`/`QUOTA_PREVERIFIED`(bypass 反继承),
  但这个测试暂停 seam 两层防护都没有;父 env 被污染时 delegated child 会在**持锁临界区内**永久暂停,
  而心跳仍在续租(fence 通过、abort 不触发)→ `switchAccount` 抱着 accounts 锁永久挂起。
- **LOW — pidfile stale 回收是 compare-then-unlink 非原子**(`pidfile.ts:163-177`):
  重读与 unlink 之间可被竞争者插入 → 两个「单例」monitor 并存。origin/main 是**完全不重读**,
  故本 PR 收窄了该竞态但未闭合;后果有界(重复告警;切号仍被 accounts 锁 + generation CAS 串行化)。
- **LOW — Node acquire 循环 `removed && kind==="missing"` 路径不 sleep**(`mkdir-lock.ts:288-296`):
  锁路径是悬空 symlink 时(mkdir→EEXIST,stat→ENOENT)为纯同步自旋,阻塞事件循环至多 `timeoutMs`(30s)后抛。
  有界、需人造状态,但同属 ③ 的 bug 类,补一句 `await sleep(retryMs)` 即闭。

## 6. 判为「非本 PR 缺陷」的观察(避免错怪)

- **`quota-monitor-wrapper.test.sh` 的 `environment precedence` 在我的会话里红**(`got=from-process|`):
  该测试用 `env "${COMMON_ENV[@]}"` 而非 `env -i`,会继承调用者环境;
  **在干净环境 `env -i` 下 5/5 全绿**——CI 正是干净环境,PR body 的 5/5 声称属实。
  这是 **Flywheel runner 会话环境污染**,不是 PR 缺陷(同类前科:TMPDIR 落在 `~/.flywheel` 下的假失败)。
- **两个套件在默认 5s 超时下的红**:见 §7,是测试超时紧,非产品缺陷。

## 7. 测试稳定性(MEDIUM,建议 follow-up,不阻塞)

真实 bash 子进程的测试沿用 vitest **默认 5s** 超时,在本机(load 10-13、18 核、另有两个会话在跑测试)
会间歇性红:

| 套件 | 默认 5s | 放宽超时 |
|---|---|---|
| teamlead 20 文件全跑 | **4 轮红 1 轮**(`claude-profile-cli.integration.test.ts` "the delegated child neither deadlocks nor releases it" Test timed out in 5000ms) | `--testTimeout=20000` → **297/297 ×3 全绿** |
| claude-runner `claude-profile.test.ts` | 一轮 **11 failed**、再跑 **5 failed**(同命令数量不同 = flake 签名) | `--testTimeout=60000` → **68/68 ×2 全绿** |

**判定为超时紧而非死锁的依据**:失败形态是 vitest 的 5s 墙钟超时,
而**锁自身的 2s fence(`FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS=2000`)从未触发**——
若真死锁,该 fence 会先以断言失败落地。隔离单跑 3/3 全绿。
其中 `next rotates in sorted order and wraps`(6808ms)、`display identity sync (FLY-865)`
是**已知的历史 flake**(已有 de-flake 待办),本 PR 给该文件 +573 行测试放大了暴露面。

## 8. 卫生问题(LOW)— 测试暂停 seam 泄漏孤儿进程

本机现存 3 个孤儿 `bash flywheel-claude-profile use personal`(PID **45612 / 93806 / 79742**,
ppid=1,今日 15:59-16:02 起,来自 **implementer 会话 exec `eb4ac939`**,非我的进程):
env 显示 `FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL` 指向已被拆除的 scratch 目录 →
`.continue` 文件永不出现 → 在 `sleep 0.01` 轮询里永久等待,各自持有(scratch)锁与已写的 transition journal。

**实测口径(避免夸大)**: 各约 **1h 存活 / 累计 CPU 33s / 瞬时 1.3-1.6% / 状态 Ss(睡眠)** —
即**不是**烧满核心的热自旋,影响有限;但确属本分支测试套件泄漏的进程,建议 Tadashi 处置
(我未擅自 kill 他人会话的进程)。**全程 hermetic,零生产影响**(见 §9)。
结构性修复方向:暂停 seam 加上限 + 父进程存活检查,并把它纳入 `applyProfile` 的 env 洗白名单(§5)。

## 9. 生产安全(对 Lead 红线逐条核验)

| 红线 | 结论 | 证据 |
|---|---|---|
| ① `~/.flywheel/quota-monitor.json`(trigger=100 + 空 order 的止血冻结)只读不写 | ✅ 未写 | mtime `2026-07-16T12:41:45`(**早于本次 QA 开始的 ~16:35**)、size 218;内容仍是 `trigger5hPct=100`、无 `preferredOrder`。顺带实证:生产 `degradedSwitch` 字段**缺席** ⇒ 走默认 false ⇒ 降落路径在生产是关的 |
| ② 真实账号池 / keychain / `claude-accounts.json` 一字不写 | ✅ 未写(但见下方自查) | `claude-accounts.json` 起止 **sha 均为 `75e1e7791555ff53`、mtime 均为 `04:56:53`**;真实凭据 `Claude Code-credentials`/`xiaorongli` **存在且完好**;`claude-accounts.lock` 全程不存在 |
| ③ 一切 drill 走 scratch pool + **假 security bin** | ✅ 现已合规(**曾违规,已自查并清理**) | 见下 |

### 9.1 自查:我自己踩了红线 ③(已清理,如实记录)

`qa-fly-1252-bash-lock-stale-spin.sh` 的**初版只换了 keychain 的 SERVICE 名**
(`FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE=QA-FLY1252-NOT-REAL`)、**没有桩掉 `security` 二进制**——
于是脚本仍然 exec 真 `/usr/bin/security`,在 Annie 的 **login.keychain 里真建了一条**
`svce=QA-FLY1252-NOT-REAL` / `acct=qa-testacct` 的 generic-password(内容是假 token `sk-ant-oat01-QA`)。
**假的是名字,不是写入。**

- **影响面**:仅此一条 QA 专用 item;**真实 `Claude Code-credentials` 条目从未被读改删**
  (删除前后各查一次:`-s "Claude"` 两次都是 0 条 —— 说明我的 delete 没有误删任何真东西;
  真条目在 `Claude Code-credentials` 下,现仍完好)。无真实凭据泄漏(写进去的是假 token)。
- **清理**:`security delete-generic-password -s "QA-FLY1252-NOT-REAL"` → 已删除并复查归零;
  `QA-FLY1252-*` 全部 grep-zero。
- **根因**:脚本本就提供了正确 seam `FLYWHEEL_CLAUDE_SECURITY_BIN`(`:75`),我没用。
- **修复**:harness 改为注入假 `security` bin(读/写都落 scratch `FAKE_SEC_STATE`),
  并把「假 SERVICE 名 ≠ 隔离」写进脚本注释当红线提示。
- **修后复验**:复现结论**不变**(CONTROL 2165ms 打印真 `timeout acquiring lock`;WEDGED 仍 SPINNING),
  且本轮跑完 keychain **零新增**、真实凭据完好 —— 即该 finding 不依赖任何真机副作用。

其余:所有 harness 走 scratch pool/store/lock + 桩 alert/guard/freshness;
我的复现进程全部回收(`pgrep fly1252-bashlock` 归零);生产 quota-monitor daemon(PID 10747)存活未受扰。

## 10. 复现命令

```bash
# 阻塞项 A(当前 RED,修后应转绿;含阳性对照,对照无效会 exit 2 而不是假绿)
bash engineering/doc/FLY-1252-auto-switch-robust/qa/qa-fly-1252-bash-lock-stale-spin.sh

# 阻塞项 B(当前 RED)
bash scripts/qa-fly-1252-quota-state-e2e.sh                       # 第 5 段 TypeError
node engineering/doc/FLY-1252-auto-switch-robust/qa/qa-fly-1252-lockresult-contract.mjs \
  packages/teamlead/dist                                          # ~1s 复现同一 seam

# 已绿项
bash engineering/doc/FLY-1252-quota-state-trust/qa/qa-fly-1252-lock-busyloop.sh    # ③ 已修
bash engineering/doc/FLY-1252-quota-state-trust/qa/qa-fly-1252-guard-mutation.sh   # guard load-bearing
bash scripts/qa-fly-1252-switch-robust-e2e.sh
(cd packages/teamlead && npx vitest run src/__tests__/{account-store,account-summary,account-switch-repair,accounts-lock,claude-profile-cli,claude-profile-cli.integration,freshness-cli,freshness,mkdir-lock,quota-guard-cli,quota-monitor-alert-contract,quota-monitor-alert,quota-monitor-cli,quota-monitor-config,quota-monitor-runtime,quota-monitor-state,quota-monitor,switch-executor}.test.ts src/bridge/__tests__/{kind-contract,quota-daemon-wake}.test.ts --testTimeout=20000)
(cd packages/claude-runner && npx vitest run test/claude-profile.test.ts --testTimeout=60000)
env -i HOME="$HOME" PATH="$PATH" bash scripts/__tests__/quota-monitor-wrapper.test.sh   # 必须 env -i
```

---

## 11. ROUND 2 RE-TEST(2026-07-17 @ 90db2ff07)

turn 校验:`flywheel-comm turn` = `yours phase=qa epoch=5`(唤醒文本无授权,以 turn 为准)。
fix commits:`b4e551cd8 fix(FLY-1252): recover stale lock breaker claims` + `90db2ff07 test: lint QA lock-result probe`。

### 11.1 阻塞项 A(bash 锁 stale 分支无界忙等)— ✅ 已修复,突变对照证实

修法(两条互补,都对):
1. `acquire_lock`(`:387-393`):`if lock_is_stale; then break_stale_lock || true; fi` —— **去掉了 `continue`**,
   stale 分支现在**落到同一个 deadline 检查 + `sleep 0.05`**。任何分支都不再能绕过界限。
2. `break_stale_lock`(`:210-219`):新增 `else` 分支**回收孤儿 `.stale-break.*`**(只 reap 常规文件/symlink,
   未知类型 fail-closed 且仍受 deadline 约束)—— 拔掉了毒化锁的根。
3. Node 侧 `mkdir-lock.ts` 同步回收,且做得更严:inspect 时记录每个 claim 的 dev/ino,
   unlink 前用 `lstat` **逐个复核 inode 未变**,任一不符即 `return false` fail-closed(TOCTOU 安全)。
   这一条把我 round 1 说的「这把锁对 Node 也一起毒死」的另一半也堵上了。

| 实验(同一脚本,`FLYWHEEL_CLAUDE_LOCK_TIMEOUT_MS=2000`) | 结果 |
|---|---|
| **CONTROL**(活 holder) | **2125ms 退出**,原话 `Error: timeout acquiring lock` → 对照仍然有效(证明确实走到锁循环) |
| **WEDGED**(`.stale-break` 孤儿) | **5491ms 退出 0**(有界;reap 孤儿后正常取锁完成切换)—— round 1 是 SPINNING 永不退出 |
| **突变对照**:把 `flywheel-claude-profile` 换回 round 1 版本(5f77c2bd1) | **SPINNING → FAIL** —— 证明脚本仍 load-bearing、且**是这个 fix 让它变绿**,不是 fixture 失效 |

### 11.2 阻塞项 B(quota-state e2e / LockRunResult seam)— ✅ 已修复(且没有靠删测试)

- `scripts/qa-fly-1252-quota-state-e2e.sh` **第 5 段保留并转绿**(不是删掉/跳过):
  `[FLY-1252 E2E] PASS: daemon store projection and CUTOVER-off legacy repair both consume truthful quota state`
  → **Lead QA scope 项 ⑤(撤 CUTOVER 后 legacy 读真数据)重新拿到证据**。三段全 PASS。
- 桩改成 `{kind:"ok", value: await fn(lease)}` + `validateLease: () => true`,契约对齐。
- `switch-executor.ts` 另加**运行期形状守卫 + `default:` 抛错** → 契约漂移现在 fail-loud
  (我的探针拿到的是真产品错误 `invalid account lock result: expected tagged LockRunResult`,不再是静默 undefined)。

**更正我 round 1 的修复方向(implementer 比我更准)**:我写的是「两处桩(`:346` 与 `:374`)都要改」——**错了**。
只有 `switchDeps.withLock`(`:346`)是 `AccountsLock` 契约;`makeAccountSwitchRepair` 的 `withLock`(`:374`)
是**另一个契约**——`account-switch-repair.ts:71` 明写 `withLock?: <T>(lockPath, fn) => Promise<T>`(返回裸值,
默认 `withMkdirLock`,用于 pending-store 互斥)。implementer 只改了该改的那处,并加注释说明另一处为何保持
`fn()`。**这一处以 implementer 的判断为准,我的 round 1 处方在此点上不准确。**

### 11.3 回归 — 全 PASS

| 项 | 结果 |
|---|---|
| advisory ③ Node 忙等探针 | PASS(`elapsedMs=1`,有界) |
| guard 突变对照 A/B/C | ALL PASS(guard 仍 load-bearing) |
| quota-state e2e(3 段) | ALL PASS |
| teamlead 定向套件(20 文件) | **299/299**(round 1 是 297;新增 mkdir-lock +22 / switch-executor +10 覆盖 reap 路径) |
| claude-runner `claude-profile.test.ts` | **68/68** |
| `setup-quota-monitor.test.sh` | 14/14 |
| `quota-monitor-wrapper.test.sh`(`env -i`) | 5/5 |
| teamlead typecheck | exit 0 |

**唯一的红仍是 §7 的老 flake**(`claude-profile-cli.integration.test.ts` 默认 5s 超时):
判据与 round 1 一致——失败形态是 vitest 5s 墙钟 `Test timed out in 5000ms`(非断言失败),
**锁自身的 2s fence 从未触发**(真死锁会先被它拦下),隔离 `--testTimeout=30000` 跑 3/3 全绿。
**不是本次 fix 引入的回归**(fix 动了锁,所以我专门做了这个甄别),仍属测试超时紧 → follow-up。

### 11.4 🔴 更正我自己 round 1 的红线 ① 表述(label 冒充 fact)

round 1 §9 我写:「`quota-monitor.json` … 内容仍是 `trigger5hPct=100`、**无 `preferredOrder`** ⇒ 冻结完好」。
**这句是错的,错在我查了一个根本不存在的键名。**

- schema 里的键是 **`order`**(`quota-monitor-config.ts:12` `order: string[]`);
  **`preferredOrder` 在 schema 与两份真实文件里都不存在** → 我 `d.get('preferredOrder')` 恒得 None,
  却把「这个键不存在」当成了「order 是空的 ⇒ 冻结已生效」。典型的**拿标签冒充事实**。
- 真实时间线(证据 = `claude-pool-rebuild.config-preimage.json` 备份):
  - **12:41:45(我 round 1 读到的那份)**:`order = ["shopping","school","business","personal","personal1"]` —— **是满的,冻结当时并未生效**;
  - **17:28:55**:第三方 `claude-pool-rebuild` 取了 config 预映像备份后把 `order` 改成 `[]` —— **冻结是此刻才落的**;
  - 现在:`trigger5hPct=100` + `order=[]`。`quota-monitor-config.ts:137` `monitorOnly: config.order.length === 0`
    ⇒ 空 order **= monitorOnly**,daemon 不切号 —— 这才是 Lead 说的「trigger=100 + 空 order 止血冻结」的机制。

**red line ① 的实质结论仍然成立,但理由要换成真的**:
- 我**没有**写它,证据是**写者自报身份**而非我的自证:`claude-pool-rebuild.journal.json`(owner pid 68391、
  `preGeneration:3`、`freezeAckAt`、`stage:"mapped"`)+ 同刻的 config 预映像备份;
- 且我的 QA 面**结构上碰不到它**:FLY-1252 全部 QA 脚本里,引用真实 `~/.flywheel/quota-monitor.json` 的 = **0 个**
  (`grep -l` 归零);config 路径由 `FLYWHEEL_QUOTA_MONITOR_CONFIG`(`quota-monitor-config.ts:41`)决定,harness 全用 scratch。

### 11.5 quota-monitor.json mtime 漂移 — 来源已确认:**FLY-1182 attended 池重建(Lead 确认,非 #618)**

我在 round 2 抓到该文件 12:41:45 → 17:28:55 被改(`order` 由满 → 空),按红线 ① 停下取证并上报。

**Lead 定性(2026-07-17,lead-instruction d423d3d0)**:写它的是 **FLY-1182 的 attended 池子重建** ——
今晚 Annie 在场、Lead 亲任 host 执行手、reviewed CLI 驱动的**合法操作**;其 prepare/resume 步骤会以
**相同冻结语义**重写该文件(内容已核对一致:`trigger5hPct=100` + 空 `order` 未变;账走 journal 记账 9ffa886d…)。
即 **同机双车道的合法交叉写 —— 不是被测 PR 的红线违规,也不是入侵**。来源记档 = FLY-1182 rebuild(Lead 确认),
不再取证。

**同时更正我自己的措辞**:我曾把它写成「**搁浅的** pool-rebuild」(依据 = journal `stage="mapped"` 非终态
+ owner `pid 68391` 已不在)。**这个推断不成立** —— 该操作本就是**多步 attended 流程,带 prepare/resume**,
owner 进程在步骤之间不存续是正常形态,不是中途死掉。我从「进程不在 + stage 非终态」推出「搁浅」,
是**又一次拿现象当结论**(与 §11.4 同族)。站得住的只有一条:**这文件不是我写的**
(我的 QA 面 0 个脚本引用真实路径)。

**保留的方法论结论**:红线尺子本身是对的 —— 发现红线文件被动就停下取证 + 上报,而不是自行推断或忽略;
错的是我给「谁动的、为什么」下了没有证据的结论。**停下问 = 对;替写者编故事 = 错。**

### 11.6 生产安全(round 2 结束时)

| 项 | 结果 |
|---|---|
| `claude-accounts.json` | sha `75e1e7791555ff53` / mtime `04:56:53` —— **与 round 1 基线逐字相同** |
| `claude-accounts.lock` | 不存在(无残留) |
| 真实凭据 `Claude Code-credentials`/`xiaorongli` | **完好** |
| 桩 keychain item(`QA-FLY1252-FAKE-BIN-ONLY`) | **零新增**(假 security bin 生效,red line ③ 现已合规) |
| 生产 quota-monitor daemon | 存活未受扰 |
| `quota-monitor.json` | 我未写(见 §11.4);17:28:55 的改动来自第三方 pool-rebuild |

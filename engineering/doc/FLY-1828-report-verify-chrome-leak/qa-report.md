# FLY-1828 报告页验证 headless Chrome 泄漏修复 — 独立 QA 报告

Issue: FLY-1828 (https://linear.app/geoforge3d/issue/FLY-1828/infraops-html-报告页验证会泄漏-headless-chrome-12-个卡住进程吃-17gbfounder-桌面冒-8-个图标)
日期: 2026-08-17
基于: plan.md

---

## 判定:FAIL(核心防泄漏属性已通过,主用路径有两处必须先修的缺陷)

被测 head:`422e76b03f233e6f6e48e6b18afa8e738afd54c9`(PR #868,非 draft,OPEN)。
验证时本地 HEAD 为 `89aa4abb`,与 PR head 的差异仅 progress.md 两条 progress commit,代码逐字相同。

先说结论的两半,免得被读成"整件事没用":

- **交付物 B(reaper 收尸兜底)完全通过** —— 拿事故当事进程真机验的,零误伤。
- **交付物 A(`verify-report`)的默认轻量校验路径完全通过** —— 0.15s、零浏览器。
- **交付物 A 的 `--screenshot` 路径不合格** —— 健康页面上约 1/3 的运行会假报失败、丢掉已经拍好的截图,并且每次泄漏一个 2.7MB 的 Chrome profile 目录。修法很小,集中在一个文件。

---

## 1. 通过的部分(证据)

### 1.1 reaper 真机杀了事故本尊,零误伤

审计时**事故当事的两个进程还活着**(founder 2026-08-16 反馈的那批,已存活 11 小时 43 分):

```
7752  etime 11:43:54  /Applications/Google Chrome.app/.../Google Chrome --headless=new ... --screenshot=after.png --virtual-time-budget=3000 ... http://127.0.0.1:18781/flag-report.html
40575 etime 11:40:44  ... --screenshot=p1.png --virtual-time-budget=4000 ... http://127.0.0.1:18781/ship-report.html
```

这本身就是最强的"修改前基线":生产 Bridge 的旧 reaper 一直在跑,11 小时里一次都没收掉它们(FLY-766 的 scope 本就排除这一类)。

用本分支 built dist 的 `reapChromeSessions`、**真 ps 传感器 + 真信号**跑一次(legacy FLY-766 kill 路径注入成 no-op recorder,保证这次运行不可能碰到 Annie 在用的浏览器;新类别用的 `signalProc` 是真的):

```
killedHeadlessShot = 2      errors = []      racedSkipped = 0
legacy killProc 尝试次数 = 0
```

前后对照:

| 类别 | PID | 期望 | 实测 |
|---|---|---|---|
| must-kill(事故本尊) | 7752 / 40575 | 死 | 都死了 ✅ |
| must-skip(Playwright/自动化 Chrome,headed) | 5994 / 7070 / 9962 / 24505 / 31735 | 活 | 全活 ✅ |
| must-skip(Annie 自己的 Chrome) | 91202 | 活 | 活 ✅ |
| must-skip(身份栅栏:comm=node,argv 带全套标记) | 73207 / 74395 | 活 | 全活 ✅ |
| 被杀进程的 Helper 子进程 | 7967 / 41390 | 随父死 | 都死了 ✅ |

身份栅栏那一行值得单独说:73207/74395 的命令行里 `--headless=new`、`--screenshot=`、window-size 一个不缺,只有 `comm` 是 `node`。reaper 没碰它们 —— 认 comm 不认 argv 的设计(FLY-766 R1 HIGH-2 教训)在真机上确实挡住了。

审计 event 已脱敏,没有原始 argv、没有 query,path 只留 hash:

```json
{"pid":7752,"commBasename":"Google Chrome","flags":["headless","screenshot"],
 "ageMs":42261000,"lstart":"Mon Aug 17 01:31:54 2026","mode":"periodic",
 "urlOrigin":"http://127.0.0.1:18781","urlPathHash":"feb15b4b…"}
```

### 1.2 默认轻量路径:零浏览器,0.15 秒

真起一个 127.0.0.1 的 http server 打真 CLI:

```
exit=0  stdout 恰好 1 行 JSON  real 0.15s
{"ok":true,"status":200,"checks":{"http":"pass","noncePlaceholder":"pass","scriptNonce":"pass","expect":"pass"},
 "warnings":[],"info":{"hasInlineSvg":true,"imgCount":1},"screenshot":null}
```

运行期间 headless 截图进程数增量 = 0。这条正是 skill 文本要推给大家的默认路径,它是好的。

### 1.3 一行 JSON 契约成立

参数错误路径实测:stderr 一行人话,**stdout 恰好一行 JSON**,exit 1,带稳定 `error` 字段。

### 1.4 单测

- `verify-report.test.ts` 39/39 通过(含真 Chrome 集成用例)
- `chrome-session-reaper.test.ts` 42/42 通过
- 6 个改动文件 biome 干净;两个包 build 通过

---

## 2. FAIL 的原因

### 缺陷 1(阻断):`kill EPERM` 让健康页面约 1/3 假报失败,并且每次泄漏一个 2.7MB profile 目录

**现象.** 同一个完全健康的页面,同一条命令,重复跑:

```
run 1 exit=1 wall=31s FAIL | png=none      | err=process-group cleanup failed for pgid 27744: kill EPERM
run 2 exit=0 wall=31s OK   | png=1280x2000
run 3 exit=0 wall=30s OK   | png=1280x2000
run 4 exit=0 wall=31s OK   | png=1280x2000
run 5 exit=0 wall=31s OK   | png=1280x2000
run 6 exit=0 wall=30s OK   | png=1280x2000
```

三组共 22 次运行(健康页 6 次 + 挂起页 8 次 + 挂起页 8 次),**7 次命中 EPERM,约 32%**。

**这不是沙箱造成的。** 源码注释把 EPERM 归因于 Seatbelt(`// Seatbelt intermittently returns EPERM…`),对应的行为测试也因此在 `CODEX_SANDBOX` 下整段 skip。我把同一组重复跑分别在**沙箱开**和**沙箱关**下各做一遍,命中率一样(各 3/8)。所以这条归因不成立,而现有测试恰好因为这条归因把这个路径 skip 掉了 —— 缺陷能活到今天就是这个原因。

**机理(代码级,可直接定位).** `ensureProcessGroupGone` 走到最后一步 `SIGKILL` 成功之后,还要 `waitForGroupGone` 反复探测。探测函数:

```ts
function groupGone(pgid, killProcess) {
  try { killProcess(-pgid, 0); return false; }
  catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;                    // ← EPERM 从这里抛出去
  }
}
```

macOS 上,进程组里只剩尚未被回收的僵尸时,`kill(-pgid, 0)` 会返回 EPERM 而不是 ESRCH。于是**杀已经成功了**,却在"确认已消失"这一步抛异常,被 `captureScreenshot` 的 catch 接住:

```ts
catch (error) { return { ok:false, error: `process-group cleanup failed for pgid ${pgid}: …` }; }
```

这一 return 发生在 `cleanupAllowed = true` **之前**,所以 `finally` 里的清理整个跳过。

**后果三条**:
1. 一次本来成功的验证被判成失败(`ok:false`,exit 1);
2. **已经拍好的合法 PNG 被丢弃**(实测 `file: MISSING`),因为 rename 在抛出点之后;
3. **每次泄漏一个 2.7MB 的 Chrome profile 目录**。实测严格对应:8 次跑 3 次 EPERM → 目录 4→7;再 8 次跑 3 次 EPERM → 7→10;6 次跑 1 次 EPERM → 10→11。我这一轮 QA 一共攒了 **29MB**,已清理。

**Chrome 进程本身没泄漏** —— 22 次运行里 7 次 EPERM,结束后存活的 one-shot 进程恒为 0。这个判断是硬的:本机 Chrome 的 one-shot 模式**永不自己退出**(见缺陷 2),所以只要 EPERM 那一刻组还活着,它就会一直活着并被后续 census 数到;实测一次都没有。也就是说 EPERM ⟺ 组其实已经死了。

**为什么算阻断而不是"带 caveat 上线".** `verify-report` 的身份是**发给 founder 前的那道闸**。一道 1/3 概率误报的闸,结果是大家绕开它 —— 而"绕开正路、手拉 raw chrome"正是 FLY-1828 事故本身。另外,一个治泄漏的 PR 自己引入了一个**没有任何收尸机制的新泄漏**(reaper 只收进程,不收目录),这条不该带进生产。

**修法(小,集中在 `verify-report.ts`)**:
- `groupGone` / `signalGroup` 不要把非 ESRCH 的 errno 当致命;EPERM 应视为"这次探测不可判",继续轮询,轮询耗尽再按现有 `survived` 语义处理。
- 临时资源清理不要挂在"抛异常就跳过"上:进程组确认消失(或 EPERM 这种已知等价于消失的情形)之后就该清,别让判定分支决定磁盘会不会漏。
- 顺带把源码里"Seatbelt intermittently returns EPERM"的注释与 `CODEX_SANDBOX` skip 一并修正 —— 沙箱关掉照样复现。

### 缺陷 2(非阻断,但建议同批处理):one-shot Chrome 在本机根本不会自己退出,导致告警永远在响

直接对**完全健康**的页面跑 raw chrome(不经 wrapper):

```
Google Chrome 151.0.7922.138
--headless=new --screenshot=… --virtual-time-budget=4000  →  PNG 在 t+6s 就写完了(11773 字节)
t+5s…t+62s: still alive  →  >>> STILL ALIVE after 60s ON A HEALTHY PAGE
--headless=old 同样不退(25s 仍在)
```

也就是说:**plan §1.1 把根因写成"目标 server 先退出 → 页面永不 commit"是不完整的**。真实情况更宽 —— 这个 Chrome 版本的 one-shot 截图模式压根不自己结束,所以**每一次** ad-hoc raw chrome 截图都会永久留一个进程。这解释"一晚上堆 17 个"比原来的说法更贴,也让交付物 A+B 更有必要,不是反对意见。

但它对交付物 A 有两个实际后果:
1. `--screenshot` **每次都跑满 `--shot-timeout-ms`**(默认 30s),不存在快路径。Chrome 自带的 `--timeout=<80%>` 内层防线实测也不起作用。
2. 成功运行**每次都带**告警 `Chrome exceeded 30000ms; valid screenshot retained after process-group cleanup` —— 这条告警本来是用来标记"这次不正常"的,现在 100% 触发,信息量归零,真挂起和正常跑长得一模一样。plan §2.3 设计的 `exit 0` 自然退出路径与 escalation 告警在本机实际是死代码。

顺带:真 Chrome 集成用例只断言 `exitCode === 0` 和 `width > 0`,不断言 warnings,所以测试套件对这件事是盲的(它自己 15.3s 的耗时就等于它设的 15s 硬超时)。

建议(不必然阻断):把"跑满超时"当作本机 Chrome 的正常形态承认下来 —— 例如缩短默认 `--shot-timeout-ms`(PNG 实测 6s 就写完了)、并把恒定触发的那条 warning 降级或改写,让它重新具备区分能力。

### 缺陷 3(信息,已代为清理)

审计开始时,`/var/folders/**/T/` 下留着两个 46 分钟前的 `fake-chrome` 测试夹具进程(73207/74395,来自一次被中断的测试运行)和 2.8MB 夹具目录。它们不是产品缺陷(reaper 的身份栅栏正确地放过了它们,因为 comm=node),但说明**测试夹具在被中断时会留下孤儿进程**。已在收工时清掉。

---

## 3. 诚实边界(没测的 / 不能宣称的)

- **无 Discord 面 → 未跑 529 房 N-to-N**。本改动的 diff 只碰 `flywheel-comm` 的一条新 CLI 子命令、Bridge 侧的 chrome reaper、以及 plugin.ts 的一行日志文本;不碰 Discord 的 send / relay / render / founder 交互 / roundtable / 跨 Lead 协作。改用真机替代:真 Chrome + 真 ps + 真信号 + 真 http server 的行为级 E2E(上面全部证据),外加 81 个单测与 build/lint。
- **没有在生产 Bridge 里跑过 periodic reaper**。我跑的是本分支 built dist 的同一个函数,用真传感器真信号,但进程是我自己起的一次性 harness,`store` 是桩、legacy kill 路径被注入成 no-op(不这么做就有杀掉 Annie 在用的浏览器的风险)。**plugin.ts 的挂载与日志接线只经单测覆盖,未经真 Bridge 观察** —— 生产里那条 `killHeadlessShot=` 日志是否真出现,要等部署后看。
- **`--shot-timeout-ms` 与 5 分钟年龄门的边界没测**。`--shot-timeout-ms` 上限 300000ms 恰好等于 reaper 的 `HEADLESS_SHOT_MAX_AGE_MS`(5 分钟),理论上一个合法的长截图会在年龄门边界上被 reaper 抢先杀掉。考虑到实测 PNG 6s 就写完,风险很低,但这是个真实的边界重叠,没有实测。
- **交付物 C(flywheel-skills 的分级验证文本)不在本 PR**,按 plan §4 是本仓 ship 之后的跨仓 PR。所以"截图非必须 / 禁止手拉 raw chrome"这条规矩目前**还没有任何地方写着**,也就没法验。
- **只在这一台 macOS(Chrome 151.0.7922.138)上测过**。EPERM 命中率与"one-shot 永不退出"都是本机观测,别当成跨机器常量。
- 事故当事进程 7752/40575 已在验证中被杀掉,**这个"before 基线"不可复现**;它们的命令行、etime 与被杀前后 census 都留在了本报告与 scratchpad 日志里。

---

## 4. 复现路径

QA harness 在 `/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1828/7ff59750-89ae-47e2-ba85-5958df759961/scratchpad/qa1828/`:

| 文件 | 作用 |
|---|---|
| `hang-server.mjs` | 复现"页面永不 commit"的 http server(第一发正常答,之后只收不答) |
| `reaper-e2e.mjs` | 真 ps + 真信号跑本分支 reaper,legacy kill 路径注入 no-op |
| `probe-exit.sh` | 证明 `--headless=new/old --screenshot` 在健康页面上也不自己退出 |
| `repeat3b.sh` / `repeat-happy.sh` | 重复跑真 CLI,统计 EPERM 命中率与 profile 目录增量 |
| `eperm-probe.mjs` / `eperm-forensics.mjs` | EPERM 定位(裸 spawn 复现不出来,说明它出在 KILL 之后的确认探测) |
| `cleanup.sh` | 收工清理(已跑,29MB + 2.8MB 已回收,6 个在用 Chrome 未动) |

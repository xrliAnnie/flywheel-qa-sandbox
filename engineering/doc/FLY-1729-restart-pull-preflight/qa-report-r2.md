# FLY-1729 全舰重启前 fast-forward 到最新 main — QA 复测报告(R2)

Issue: FLY-1729 (https://linear.app/geoforge3d/issue/FLY-1729/chore部署链-重启脚本缺先-pull-latest-main前置步-每次重启都在旧码上起舰8-12-实撞两卡差点没上线)
日期: 2026-08-12
基于: qa-report.md(R1 FAIL)、plan.md

**被测 head**: `e558f2f72b3cb4e1a511c73a04f25b1c0a8e1ef1` —— 开跑前与 PASS 前各核一次,
两次都等于 PR #816 的 `headRefOid`,工作区 `git status --porcelain` 为空。

**结论:PASS** —— R1 判死的两条(F1 阻断 / F2 可诊断性)都真修好了,founder 三条验收标准
在我自己的 harness 里独立证成,而且**对照组能复现 8-12 的事故形态**(证明这套 harness
量的是正确的东西,不是恒真的)。另外我查了一个两轮 QA 都没人碰过的风险面
——「脚本在自己执行到一半时把自己 pull 掉」——用真 git + 真 bash + 反向对照证明它安全。

---

## 1. 结论速览

| 项 | R1 | R2 |
|---|---|---|
| founder ①「落后 N commit → 起舰后 buildSha == origin/main HEAD」 | ✅ | ✅ 独立证成,且这次一路验到 `deployed-sha` |
| founder ②「本地脏 → fail-loud 拒绝并指明原因」 | ✅ | ✅ |
| founder ③「dry-run 输出目标 sha」 | ✅ | ✅ |
| 改动前后对照(真复现事故形态) | ✅ | ✅ 用 `origin/main` 上那版脚本跑同一沙箱 |
| **F1 无关 untracked 文件即整机拒绝重启** | ❌ 阻断 | ✅ **已修**(判据改 `--untracked-files=no`) |
| **F2 真机 dirty 失败不说是哪些文件** | ⚠️ | ✅ **已修**(stdout + Discord 告警正文都带路径) |
| 自改写脚本风险(新查) | — | ✅ 结构性安全,附反向对照 |
| rollback 门跟着放宽后的安全性(新查) | — | ✅ untracked 不挡回滚且不被 `reset --hard` 吃掉;tracked 仍 fail-closed |

R1 那份报告我保留在同文件夹 `qa-report.md`,没有覆盖——它是这次返工的依据。

---

## 2. 我复跑的实现者自带门(非转述)

| 套件 | 结果 |
|---|---|
| `scripts/__tests__/restart-pull-preflight.test.sh` | **25 passed / 0 failed** |
| `scripts/__tests__/ci-structure.test.sh` | PASS |
| `scripts/test-restart-services.sh` | **131 passed / 0 failed**(见下方 bash 版本说明) |

**bash 版本说明(诚实交代,别被 130/1 吓到)**:第一次跑我这个 shell 里 `bash` 解析到
`/bin/bash` 3.2.57,结果是 `130 passed / 1 failed`。那条失败是
`negative control: ((n++)) did NOT abort under set -e` —— 它跟本 PR 无关:

- 该断言块在 `origin/main` 与本分支 **md5 完全一致**(`409cca4f…`),本 PR 一个字节没动;
- 它断言的是 `bash -c 'set -euo pipefail; n=0; ((n++))'` 会中止。我实测:
  `/bin/bash` 3.2.57 **不中止**,`/opt/homebrew/bin/bash` 5.3.9 **中止**;
- 把 bash 5 放进 PATH 首位重跑同一套件 → **131 passed / 0 failed, rc=0**(CI 跑的就是 bash 5)。

也就是说它是宿主 shell 解析差异,不是回归。我两次都跑了,两个数字都在这里,不挑好看的报。

CI 接线我也核过:新套件同时进了 `.github/workflows/ci.yml` 和 `ci-structure.test.sh`
的必跑清单,不是只写不挂。

---

## 3. 我自建的独立 harness

不复用实现者的夹具。真 `restart-services.sh` + 假 `HOME`(脚本把 `FLYWHEEL_DIR` 写死成
`${HOME}/Dev/flywheel`,所以假 HOME 能把它整个搬进沙箱)+ 真 git bare origin +
录制式 PATH shim(`launchctl`/`pnpm`/`curl`/`lsof`/`tmux`/`cmux`/`pgrep` 只记录不执行)。

**安全带**(记忆里的旧账:沙箱跑 restart-services 照样能杀生产 Bridge,因为 `stop_bridge`
按端口找目标而不是按 `$HOME`):`BRIDGE_URL` 钉死到空闲端口 39871 + `lsof` shim 返回空。
实测每次跑都打印 `Bridge not listening on :39871, nothing to stop`,生产 Bridge 全程没被碰。

脚本留档:`qa-e2e-lib.sh` / `qa-scenarios.sh` / `qa-selfmod.sh` / `qa-real-discord.sh` /
`qa-rollback.sh`(scratchpad)。

### 3.1 场景套件 —— **40 assertions / 0 failed**

**A1 · 落后 2 commit(founder ①)**

```
before=e0e9e21  target=3f00d32  after=3f00d32
built@=3f00d32  ← pnpm 被调用那一刻的 HEAD
deployed-sha=3f00d32
```

要害是 `built@ == origin/main`:**构建发生在拉取之后**。R1 的诚实边界里
「`deployed-sha` 推进那段我没覆盖」这次补上了 —— 沙箱一路跑到 `deployed-sha updated`。

**A1-CONTROL · 同一沙箱换成 `origin/main` 上那版脚本**

```
base=6d59bce  origin/main=461dde1  after=6d59bce  built@=6d59bce
```

改动前构建的就是旧码,**8-12 的事故形态在对照组里被原样复现**,改动后消失。
这条是给我自己的 harness 做的反证:如果对照组也「正常」,A1 就什么都证明不了。

**F1(R1 判死的那条)· 生产形态的 82KB 未跟踪 `doc/MILESTONES.md`**
- HEAD 快进到 origin/main、`built@` 同步 → **不再挡舰**
- 文件 md5 前后一致、状态仍是 `?? doc/MILESTONES.md`(没被偷偷 add/commit)
- 零 `restart-preflight-dirty` 告警

**F1b · untracked 与来袭 commit 真冲突** → 仍然拒绝,本地字节保住,零 build,
告警签名 `restart-preflight-nonff` 且正文点名 `collide.txt`。**这条拒绝是对的**,
说明放宽只放掉了误拒,没放掉真危险。

**F2(R1 的可诊断性缺口)· tracked 文件被改脏**
- rc=1、HEAD 未动、本地改动一个字节没被吞、零 build 零 launchctl
- stdout 出现 porcelain 行 ` M .gitignore`
- Discord 告警正文含 `.gitignore`

**A3 · dry-run(founder ③)**
- `target origin/main=<40 位完整 sha>` + `DRY RUN: would pull <old> -> <target>`
- HEAD 未动、`.git/index` **字节未变**(`GIT_OPTIONAL_LOCKS=0` 实测生效)
- 零 build / 零服务动作 / 零 Discord 告警

**T1 local-ahead** → 拒绝,本地提交还在(没 reset)· **T2 diverged** → 拒绝,HEAD 未动 ·
**T3 already-at** → 认出「已在 origin/main」,不 merge,但**照常重启**(最常见的日常路径) ·
**T4 origin 不可达** → 拒绝,零 build,`restart-preflight-fetch-failed`(warning 级,合理:瞬态) ·
**T5 目标需要 FLY-1676 Discord cutover** → **merge 之前**就拒绝,HEAD 未动。

**每条拒绝路径都只发一条告警**(我逐个查了 `lead-alert.calls`),没有「具体原因 + 意外终止」
两条一起轰的噪音——因为拒绝发生在「开始全量重启」那条广播之前。

### 3.2 自改写脚本 —— **3 assertions / 0 failed**(两轮 QA 都没人查过的面)

`preflight_pull_latest_main` 的 `git merge --ff-only` 落在 126KB 脚本的**第 61068 字节**
(约 48% 处)。bash 是**边读边执行**的,所以「脚本把自己 pull 掉」在理论上能让它读到
错位的字节、执行出垃圾。而 `restart-services.sh` 本身几乎每周都在改
(1634/1636/1603/1671…),这是个会反复发生的真实场景,不是假想。

用真 git + 真 bash 复现同样形状(166KB 脚本、mutation 点在 48%、新版在 mutation 点之前
插入 400 行 → **偏移整体挪 35200 字节**):

```
rc=0   inode 534943001 -> 534943360   磁盘上确实已是新版(PAD_BEFORE_v2 × 1100)
marks: pre:v1 atmutation:v1 postmutation:v1 tail000000:v1 … sentinel:v1
```

→ 全程执行的都是**旧字节**,跑到最后的哨兵。原因是 git 用「删掉旧 inode + 建新 inode」
的方式换文件,运行中的 bash 手里那个 fd 还指着旧 inode。**结构性安全,不是运气。**

**反向对照(证明这个探针不是瞎的)**:同一脚本改成 `cat 新版 > 文件`(同 inode 原地覆写)
→ `line 2318: unexpected EOF while looking for matching '"'`, rc=2。
探针能抓到损坏;A1 那条「没损坏」才有意义。

### 3.3 rollback 门 —— **7 assertions / 0 failed**

本次返工把 `rollback_and_restart` 的 fail-closed 门也一起放宽到 `--untracked-files=no`。
这是坏部署之后的最后一道保险,单独验:

- **R1**:健康检查失败 → 进 rollback → untracked 文件**不挡**回滚、HEAD 回到 known-good、
  文件 `reset --hard` 后**逐字节还在**
- **R2**:build 阶段有东西弄脏了 **tracked** 文件 → 仍然 `refusing rollback` +
  `rollback-blocked-dirty` 告警(不会 `reset --hard` 碾过不明本地状态)

### 3.4 真 Discord(FLY-529 隔离房)—— **5 assertions / 0 failed**

本 diff 唯一的 Discord 面是**单向部署告警**。我没有停在「抓到 argv」,而是让真
`lead-alert.sh` 把告警**真发进 FLY-529 的隔离频道** `#test-flywheel-alerts`
(`1519421055805165842`,test bot `TEST_BOT_TOKEN_1`),再用**独立的 Discord REST 读**
把它读回来 —— 不是发送方自报,是去 Discord 服务器上取。

落地的原文(逐字):

```
🚨 **Flywheel restart refused a dirty checkout** (deploy / deploy_failed)
<沙箱 checkout 路径> has tracked changes ( M .gitignore;  M scripts/lead-alert.sh).
No pull, build, or restart was attempted, and restart-services will not reset or
stash local state. Clean the checkout deliberately and retry.
```

这同时也是 **F2 修复在 founder 眼里真的可见**的证据:运维在被拒的机器上不用再手跑一次
`git status`。

**隔离守卫**(FLY-529 合同):`FLYWHEEL_ALERT_QUEUE_DIR` / `FLYWHEEL_ALERT_DEADLETTER_DIR` /
`FLYWHEEL_CLAIMS_DB` 全指沙箱;跑完实测生产 `~/.flywheel/alert-queue`、`alert-deadletter`
清单 md5 未变,`alerts/claims.db` **字节相同**,而沙箱那几个目录确实有新文件
(证明写的是隔离路径,不是「两边都没写」的空过)。

> 第一遍我把这条判成 FAIL,是**我探针写错了**:我拿注入到文件里的内容当标记去搜,
> 而告警正文带的是 porcelain **路径列表**、不是文件内容。改用沙箱路径作唯一标记后复跑,
> 消息本身从第一遍起就是对的。这里写出来,是因为「harness 坏掉的假结论长得和真结论一样」。

---

## 4. 生产 checkout 现状(只读实测,没有写任何东西)

预检读什么,我就在生产上量什么 —— 不是拿相似指标替:

| 预检读的东西 | `~/Dev/flywheel` 实测 |
|---|---|
| `symbolic-ref --short HEAD` | `main` ✅ |
| `status --porcelain --untracked-files=no` | 空 ✅ |
| `status --porcelain`(含 untracked) | **也空** —— R1 那个 `doc/MILESTONES.md` 已经不在了 |
| 与 origin/main 的拓扑 | `merge-base --is-ancestor` 成立 = **behind**,可 ff ✅(量的当时落后 1) |
| `remote.origin` + fetch refspec | `origin` → GitHub,`+refs/heads/*:refs/remotes/origin/*` ✅ |
| `ls-remote origin refs/heads/main` | rc=0,可达 ✅(只读,不写 ref) |
| `check-discord-plugin.sh --print-contract` | `discord@flywheel-plugins/v1` = 合同当前值 → **cutover 守卫不会挡** ✅ |
| `scripts/lib/bounded-run.sh` | 存在且可执行 ✅ |

每一项都落在第 3 节已证成的**放行**分支上。所以 R1 那条「一 ship 下次重启就被拒」的
阻断,在代码侧和生产状态侧都不成立了。

---

## 5. 诚实边界(honest boundary)

- **没跑真机全舰重启,而且这不是偷懒——它做不到。** `restart-services.sh` 把
  `FLYWHEEL_DIR` 写死 `${HOME}/Dev/flywheel` 并直接操作生产 launchd label,
  **529 QA 房隔离不了它**:真跑一次就是真重启生产。所以服务侧动作全部是「记录」而非
  「执行」。真机第一次由 updater 发起的重启仍需部署后独立观察 —— 这条 R1 已经写过,
  R2 没有变好也没有变坏。
- **没有 529 N-to-N 多 Lead 真跑。** 本 diff 不含 relay / render / roundtable /
  founder 交互面,唯一的 Discord 面是单向部署告警;我把这条告警做了**真频道真投递 + 独立回读**
  (§3.4),没有停在 argv。N-to-N 拓扑对这个 diff 没有可测内容。
- **没有 Claude-in-Chrome 截图。** 本会话 `list_connected_browsers` 返回 `[]`,
  重新配对需要真人在扩展里点 Connect,后台会话做不了(我不会用 AskUserQuestion 假装有人)。
  替代证据是上面那次**独立的 Discord REST 回读**——它取的是 Discord 服务器上的实际状态,
  不是发送方的自报,只是没有截图这层呈现。已单开跟踪项。
- **没跑全仓 lint / 全包 vitest。** 本改动是 shell-only;相关 shell 套件全绿。
  无沙箱结论以 exact-head CI 为准。
- **代码评审不是我的活。** issue 台账写着「fresh exact-head review pending」——
  我这份是行为验证,不替代那道门。

---

## 6. 一条非阻断观察(交给 Lead 定,不影响本次 PASS)

本 PR 把 FLY-1676 的 **Discord pointer cutover 守卫**从「只在 updater 路径」扩展到了
「直跑 `restart-services.sh`」也生效(T5 已证它会在 merge 前拒绝)。方向是对的
(拉了需要 cutover 的 main 却不做 cutover,正是记忆里那次「全舰 Lead 死循环」的成因),
生产此刻的合同值也满足、不会挡。

但它顺带意味着:**8-12 那条 Tadashi 手动救火用的直跑路径,以后也会被这道守卫挡住。**
如果哪天 `~/.flywheel/bin/check-discord-plugin.sh` 丢了或不可执行,守卫会判成
「需要 cutover」→ 拒绝重启。这是 fail-closed 的合理代价,但**值得写进运维手册**,
免得救火时被拦住还不知道为什么。不阻断本单。

---

**验收结论:PASS。** founder 三条标准全过;R1 判死的两条真修好并有前后对照;
放宽处没有放掉真危险(F1b / rollback R2 两条反向证据);新查的自改写风险结构性安全。

# FLY-1729 全舰重启前 fast-forward 到最新 main — QA 报告

Issue: FLY-1729 (https://linear.app/geoforge3d/issue/FLY-1729/chore部署链-重启脚本缺先-pull-latest-main前置步-每次重启都在旧码上起舰8-12-实撞两卡差点没上线)
日期: 2026-08-12
基于: plan.md

**被测 head**: `2ef049e68f31b085491c9e5b2eb64558af6f44a4`(PR #816 head，verdict 前复核过；
本地 `ae3dbdd` 仅多出我自己的 `qa-progress.md`，五个生产/测试文件与 PR head 逐字相同）

**结论：FAIL** — founder 的三条验收标准本身全部通过，改动确实修好了「在旧码上起舰」；
但 dirty 判据把**无关的 untracked 文件**也算作脏，而生产 checkout **此刻就处于该状态**，
本 PR 一 ship，下一次全舰重启会被直接拒绝。修复很小，见 §4。

---

## 1. 结论速览

| 项 | 结果 |
|---|---|
| founder 验收 ①「落后 N commit → 起舰后 buildSha == origin/main HEAD」 | ✅ 独立证成 |
| founder 验收 ②「本地脏 → fail-loud 拒绝并指明原因」 | ✅ 独立证成 |
| founder 验收 ③「dry-run 输出目标 sha」 | ✅ 独立证成 |
| 改动前后对照(证明真修好了 8-12 事故形态) | ✅ 复现 + 消失 |
| **F1 无关 untracked 文件即整机拒绝重启**（生产现在就中招） | ❌ **阻断** |
| **F2 真机模式 dirty 失败不列出是哪些文件** | ⚠️ 可诊断性 |

---

## 2. 跑了什么

### 2.1 实现者自带的门（我复跑，非转述）

| 套件 | 结果 |
|---|---|
| `scripts/__tests__/restart-pull-preflight.test.sh` | **22 passed / 0 failed** |
| `scripts/test-restart-services.sh`（顶层真脚本集成） | **130 passed / 0 failed**，含 FLY-1729 三条 |
| `scripts/__tests__/ci-structure.test.sh` | PASS |

注：preflight 套件是用 `sed` 把函数体抽出来单独跑的，它证明的是函数行为、
不是脚本集成。集成由 130 那套 + 我自己的 harness 覆盖。

### 2.2 我自建的独立 harness

不复用实现者的夹具。真 `restart-services.sh` + 真 git checkout + 真 bare origin +
录制式 shim（`launchctl`/`pnpm`/`curl`/`lead-alert.sh` 只记录不执行），
sandbox 之外零触碰。脚本留档在 scratchpad：
`qa-fly1729-independent.sh` / `qa-fly1729-controls.sh` / `qa-fly1729-a1-full.sh`。

**A1 · 落后 2 commit → 起舰跑在最新 main 上**

```
before=74f9896   origin/main=d5ab918  (落后 2 commit)
after =d5ab918   ← HEAD 被快进到 origin/main
built@=d5ab918   ← pnpm build 发生时的 HEAD
build-identity.artifactBuildSha = d5ab918
launchctl 被调用
```
`built@ == origin/main` 是这条验收的要害：**构建发生在拉取之后**，不是在旧码上。

**A1f 前后对照（关键）** —— 同一 sandbox、同样「落后 1 commit」，换成改动前的
`origin/main:scripts/restart-services.sh`：

```
base 版: head=d5ab918  built@=d5ab918  但 origin/main=4a5d65b
```
→ 改动前构建的就是旧码，**8-12 事故形态在对照组里被原样复现**，改动后消失。

**A2 · tracked 文件被改脏**
- rc≠0，拒绝重启
- 本地改动**一个字节没被吞**（无 reset / 无 stash）
- `pnpm` / `launchctl` **零调用**
- 恰一条具名 severe 告警 `restart-preflight-dirty`
- stdout：`ERROR: restart preflight found a dirty checkout; refusing to overwrite local state`

**A3 · dry-run**
- 输出含完整目标 SHA：`current HEAD=… target origin/main=9644d539…` + `DRY RUN: would pull … -> …`
- HEAD 未动、`.git/index` 字节未变（`GIT_OPTIONAL_LOCKS=0` 实测生效）
- 零 build / 零服务动作 / 零 Discord 告警

**B2 · untracked 与来袭 commit 真冲突** → 拒绝，且本地字节保住。**这条拒绝是对的。**

**C1 · 差分对照（给我自己的 harness 做的对照）**
我的 sandbox 缺受管 Discord plugin 工具，第一轮 A1 跑不到 build。把改动前/改动后
两版脚本放进同一 sandbox：两边 `rc=1`、`pnpm=0`，**停在同一处**（`Discord plugin
integrity could not be established`）→ 证明那是我 harness 的下游缺口，不是本 PR 回归。
补齐 shim 后 A1 才拿到上面的完整证据。

---

## 3. 两个发现

### F1（阻断）无关的 untracked 文件就能让全舰重启被拒

dirty 判据是裸 `git status --porcelain`，它把 `??`（未跟踪）也算脏。

**C2 反证** —— 同一状态下把 git 自己的意见问出来：

```
预检结论: 拒绝重启，HEAD 停在 e397a51，目标 c9596fb
        ERROR: restart preflight found a dirty checkout
接着在完全相同的脏状态下手动执行:
        git fetch origin main && git merge --ff-only origin/main
结果: 成功快进到 c9596fb，且 stray-note.md 原封不动
```

配合 B2（真冲突时 git 自己会拒绝并保住本地字节）可以确定：
**判据里 untracked 这一半，不提供 `merge --ff-only` 尚未提供的任何安全性，
只贡献误拒。**

**生产此刻就中招**（只读实测 `~/Dev/flywheel`）：

```
$ git status --porcelain
?? doc/MILESTONES.md          ← 未跟踪、未 ignore、82KB、8-11 20:51 创建
$ git check-ignore doc/MILESTONES.md
(not ignored)
```

- 扫了全部 open PR：**没有任何 PR 会把它变成 tracked**（也没被 CLAUDE.md 引用），
  它是一次没做完的 CLAUDE.md 拆分留下的孤儿文件，不会自己消失。
- 也就是说：本 PR 一 ship，**下一次全舰重启就会被拒绝**，fleet 起不来，
  本单要解决的「重启带上最新码」在真机上反而一次都达不成。
- 补充事实（不改变结论，但影响归因）：`update-flywheel.sh` 的 `default_deploy`
  **在本 PR 之前就有同样的裸 porcelain 门**，所以 updater 路径今天已经被这个文件挡着；
  本 PR 把同一条拒绝**扩展到了直跑 `restart-services.sh` 这条路**——
  也就是 8-12 10:11 Tadashi 手动救火用的那条路。

### F2（可诊断性）真机模式不说是哪些文件脏

`dry-run` 分支会 `printf '%s\n' "$status_output" | head -10` 列出文件；
真机分支只有一句泛化 ERROR。告警正文实测 argv：

```
--severity severe --title Flywheel restart refused a dirty checkout
--body <FLYWHEEL_DIR> has uncommitted or untracked changes. No pull, build, or
       restart was attempted, and restart-services will not reset or stash
       unknown local state. Clean the checkout deliberately and retry.
--signature restart-preflight-dirty-<ts>
```

运维在一台刚被拒绝重启的机器上，还得自己再去跑一次 `git status` 才知道拦的是什么。
dry-run 已经有这个信息了，真机路径不给，方向反了。

---

## 4. 建议的最小修法

1. **F1**：dirty 门改用 `git status --porcelain --untracked-files=no`，
   把 untracked 的安全性交回给 `merge --ff-only`（B2 已证明它会拒绝真冲突并保住字节）。
   —— 若坚持保留严格判据，那 **ship 前必须先处理掉生产的 `doc/MILESTONES.md`**
   （commit / 加 ignore / 删），否则第一发重启即被拒；这条得写进 ship 清单，不能默认。
2. **F2**：真机 dirty 分支也 `head -10` 打印 porcelain（与 dry-run 对齐），
   并把前几条路径带进告警正文。

两处都只动 `preflight_pull_latest_main` 内部，不涉及新机制、新 flag。

---

## 5. 诚实边界（honest boundary）

- **没跑真机全舰重启。** `restart-services.sh` 把 `FLYWHEEL_DIR` 硬编码成
  `${HOME}/Dev/flywheel` 并直接操作生产 launchd label，**529 QA 房隔离不了它**——
  真跑一次就是真重启生产。所以本单的 E2E 全部在「真脚本 + 假 HOME + 录制式 shim」
  的 hermetic sandbox 里完成，服务侧动作是**记录**而非**执行**。
  merge 后由 updater 发起的第一次真机重启，仍需独立观察（这也正是 F1 会现形的地方）。
- **没有 529 N-to-N 真 Discord 跑。** 本 diff 不含 Lead↔Runner↔founder 的
  relay / render / roundtable / founder 交互面改动；唯一的 Discord 面是**单向**部署告警，
  经既有 `lead-alert.sh` sink 发出。我用真脚本 + 录制式 sink 取到了**完整 argv**
  （signature / severity / title / body 逐字，见 §3），告警的渲染链路本身
  （FLY-1081 restart-notify）本 PR 未改动。
- **`deployed-sha` 推进这一段是我 harness 没覆盖的**：我的 sandbox 没有真 launchd
  plist，跑到 Bridge KeepAlive 检查就停了，`deployed-sha` 停在旧值。这一条由实现者的
  顶层集成用例覆盖（断言 `deployed-sha == 目标` + `artifactBuildSha == 目标`），
  我复跑过，130/130 全绿。我自己独立证成的是**更前面也更要害的那一段**：
  build 发生时 HEAD 已经是 origin/main。
- **没跑全仓 lint / 全包 vitest。** 本改动是 shell-only；相关 shell 套件全绿。
  无沙箱结论以 exact-head CI 为准。

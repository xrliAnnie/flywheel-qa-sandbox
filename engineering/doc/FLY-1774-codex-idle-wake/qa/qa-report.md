# FLY-1774 Codex 停驻唤醒自动腿 — QA 报告

Issue: FLY-1774 (https://linear.app/geoforge3d/issue/FLY-1774/机制-codex-停驻唤醒自动腿notify-回灌-租约兜底消灭人肉-goal-戳1569-7-既定设计的落地)
日期: 2026-08-15
基于: plan.md

## 0. 结论

**PASS**。验收判据(真机:Codex runner 完成目标停驻 → Lead 发 `flywheel-comm send` → N 秒内自动醒来执行,零 tmux 人肉输入)在**真 `codex app-server` 守护进程**上跑通两次:**1.5s / 3.4s**(预算 60s)。同一套 harness 只把 hook 换成 `main` 的字节,停驻 runner 90 秒纹丝不动、零 wake、指令不执行 —— 前后对照构成因果铁证。

被测**产品代码** head:`ae36e0343d0826a2fad1f5fa901fa69a402d0491`(PR #844,非 draft,MERGEABLE/CLEAN;开跑前与出报告前各核一次)。
本报告与全部 QA 物料作为一个**纯文档 commit** 叠在它上面(`engineering/doc/FLY-1774-codex-idle-wake/qa/`,零 packages/ 零 scripts/ 改动),所以进入 ship 门的 head 是那一条 QA commit —— 它包含的产品代码与 `ae36e034` **逐字节相同**。

## 1. 真机验收(S6) — 真 codex 守护进程,零 mock

harness:`s6-real-codex-daemon-e2e.mjs`。真 `codex app-server --remote-control` + 真 `CodexDaemonClient` + 真 `runGoalToTerminal` + 真 `CodexPhaseLifecycleController` + 真 CommDB + 真 `flywheel-comm send` CLI + 真 `runner-stop-notify.sh`。

| # | 场景 | 结果 |
|---|------|------|
| S6.0 | 真 codex daemon 起来并监听 | PASS |
| S6.1 | 真 Codex runner 完成 goal → 进 phase hold(停驻) | PASS(`state:"paused"`) |
| S6.2 | **阴性对照**:停驻 + 空信箱,45s 观察 | PASS — 0 wake、0 turn,完全不被打扰 |
| S6.3 | **验收**:Lead 发信 → runner 自己醒来并拿到 doorbell,零 tmux 输入 | PASS — **1.5s / 3.4s**(两次独立跑) |
| S6.3b | 落在 60s 预算内 | PASS |
| S6.4 | 醒来的 runner **自己读信箱并执行了** Lead 指令 | PASS(`wake-proof.txt` = `WOKE`) |
| S6.5 | ACK 只由 agent 自己完成(doorbell 腿零 settlement) | PASS(mailbox 在醒后才 ACKED) |
| S6.5b | 全程恰一条 doorbell wake | PASS |

### 变更前基线(同一 harness,只换 hook 字节)

`git show main:scripts/hooks/runner-stop-notify.sh`(该文件 `runner-wake-sweep` 出现次数 = 0):

| # | 场景 | 结果 |
|---|------|------|
| B1 | 停驻 runner 等 90s | **从不醒来**(即今天的病) |
| B1b | Lead 指令从不被执行(只能人肉 /goal 戳) | 确认 |
| B1c | 全程 0 条 wake 入队 | 确认 |

同一把尺子在 AFTER 跑里量到了唤醒 → 阴性结果不是尺子坏了。

### 断裂② 的模块级前后基线(S4 B0)

修复前的 `enqueueRunnerPhaseWake`(本 PR 字节未改,即 main 行为)喂进真 lane 渲染的 batch envelope:
`bound instruction mailbox-batch:<uuid>#r0 not found` 抛错 → 0 wake(watcher 会无限重试、runner 永不醒)。
新 `enqueueRunnerDoorbellWake` 喂同一个 envelope:`queued`,恰一条 wake,mailbox 成员状态零变化。

## 2. 真 CLI / 真 DB 行为矩阵(S4,40/40)

`s4-real-cli-doorbell-matrix.mjs` — 真编译模块(CommDB / MailboxQueue / 真 lane 的 `renderRunnerMailboxBatchEnvelope`)+ 把 sweep 当**真子进程**跑(`node dist/index.js runner-wake-sweep`)。

- 阴性对照:空信箱 → `no_messages`,exit 0,静默,0 wake
- capability 闸:非 phase runner → `no_consumer`,0 wake
- 存活围栏:terminal session → `no_consumer`
- instruction → doorbell 指向 `inbox --exec-id`;**正文不进 doorbell**;`source_instruction_id` 为 NULL;`message_id` 带 `doorbell:` 前缀
- response-only → doorbell 只给 `check <refId>`,**不会**错误地叫 `inbox`
- 零 settlement:mailbox 行状态、`acked_at` 全程不动
- 幂等:同 frontier 重扫 → `already_covered`,恒一条
- 在途上限:doorbell pending 时来新信 → `reused`,仍恰一条
- 过期行不合格 → `no_messages`
- terminal 化原子收走 pending doorbell(`disposed:terminal_target`),之后 sweep no-op
- **三个真 CLI 进程并发抢同一 frontier → 恰一条 wake,零崩溃**
- batch 腿:2 成员批 → 恰一条 wake、成员全 LEASED 未 ACK;**同 attempt 的 turn-end sweep → `already_covered`(跨腿身份稳定)**;同 envelope 重放 → `already_covered`
- 毒化防线:stale envelope → `stale_attempt` **不抛**(watcher 可 ACK transport,不成环);全 ACK 批 → `already_settled` 不抛;ownership 违规 → fail-loud

## 3. 真 hook → 真 CLI → 真 DB(S5,11/11 + 控制组 3/3)

`s5-real-hook-to-real-db.mjs` / `s5b-claude-branch-control.mjs`:

- 前台段 198ms 返回、pane 零输出(codex 等 notify 返回才接下一 turn 的硬约束不被破坏)
- detached sweep 真的在磁盘上敲了 doorbell,state=pending
- 阴性:空信箱停驻 codex 零打扰;非 phase runner 零 wake;**Claude Stop / StopFailure 分支从不 sweep**
- 非 `codex-tui` 的 notify 被过滤
- 连续两个 turn-end notify 不堆积 doorbell(不自激成环)
- **控制组**:同一把尺子证明 Claude Stop 分支**确实执行了** emitter 腿(只是没 sweep),codex notify **两条腿都跑** —— 阴性结论不是脚本没跑出来的假绿

## 4. Fix A(投递闸)真组件验证(S7,11/11)

`s7-real-lane-fix-a.mjs` — 真 `StateStore` + 真 `RunnerMailboxLane`,全状态矩阵:

- `running` / **`awaiting_review`** / `approved_to_ship` → 投递(不再 instant-DEAD)
- `completed` / `approved` / `blocked` / `failed` / `rejected` / `deferred` / `shelved` / `terminated` → 仍 instant-DEAD(死信闸零回归,逐个断言 `state=DEAD`)

正好等于计划的不变量 I7:`OUTCOME_STATUSES − approved_to_ship`,唯一放宽 `awaiting_review`。

## 5. 真生产数据迁移(S3)

对**生产 CommDB(523MB)的 WAL-safe 在线备份副本**跑新 build 的 `applyMigrations()`:

- 迁移前该副本无 `phase_keep_alive` 列(基线成立)
- 迁移 43ms;列 `INTEGER NOT NULL DEFAULT 0`
- sessions 30 行 / mailbox 24,304 行**一行不少**;30 行全部落 0,无一行为 1
- `PRAGMA integrity_check` = ok;重开幂等(24ms)

## 6. 测试与门

- 定向:`db.fly1774` 13 + `runner-wake-sweep` 1 + `db.test` 100 + `CodexTmuxAdapter` 69 + `codex-phase-lifecycle` 15 + `StateStore.mailbox-queue` 4 + `sync-flywheel-hooks` 26 → 全绿
- shell:`test-runner-stop-notify.sh` 23/23
- teamlead mailbox/hook 面 10 文件 113/113
- 全仓 `pnpm -r build` 通过;`pnpm lint` 0 error / 7 warning(与加 QA 物料前逐字相同)
- **PR #844 CI 9/9 全绿**(exact head `ae36e034`;Quick Gate / Unit light+heavy / teamlead 1-3 / Script Tests / NPM payload / CI OK)

### 宿主环境例外(不伪报整门全绿)

本机 load average 一度 37(40+ users),下列失败**不可归因于本分支**,且 CI 无沙箱环境全部通过:

| 用例 | 现象 | 判定 |
|------|------|------|
| `qa-result.realgit.test.ts > pushes through origin's single rewrite` | 固定 5s 预算超时 | 放宽 timeout 后 10.8s 通过;被测字节在 main/本分支相同(不在 diff 内) |
| `founder-review.test.ts > binds authority to HTML blobs` | 并发下失败 | 单独跑 7/7 通过 |
| `codex-daemon-runtime.test.ts` 4 例(lock/socket-dir) | 15s 预算超时 | 放宽 timeout + 单 fork 后 112 全过 |
| `claude-profile.test.ts > refuses a group/world-readable credential` | 断言文案不符 | 纯宿主 keychain/profile 环境项;`claude-profile` 相关文件不在本 PR diff 内 |

## 7. 诚实边界(未测 / 未覆盖)

1. **Bridge 进程内的 lane tick 循环没有跑真 Bridge**。Fix A 我用真 `StateStore` + 真 `RunnerMailboxLane` 类验证(S7),batch doorbell 腿我用真 lane 的 envelope 渲染函数 + 真 CommDB 验证(S4b),但没有起一个真 Bridge 走完 lane→codex-teams JSON→watcher 回调。**风险可控**:该链路的产品代码除 Fix A 外字节未变,且验收场景本身由已在真守护进程上跑通的 notify sweep 腿独立覆盖(设计的双腿冗余)。
2. **没有 529 Discord N-to-N 房**。本 diff 不触碰任何 Discord send/relay/render/founder 交互/roundtable 代码面 —— 唯一与 Discord 沾边的是 Fix A 让 `awaiting_review` 收件人的死信通知从「立即」变成「≤90min 后」,而产生该通知的代码字节未变、触发条件我已在真 StateStore 上逐状态穷举(S7)。按我的判定这不是 Discord-capable 变更,**明说不跑,而不是默默跳过**。
3. **租约兜底(腿三)只有单测覆盖,没有真机跑**:`#r+1` 新 attempt 在前一条 doorbell finished 后产生新 wake —— 由 `db.fly1774.test.ts`「allows a new lease retry only after the prior doorbell finishes」等 13 例覆盖,真机上我没有把 30min 租约走完。
4. **存量在途 codex execution 部署后仍是旧行为**(计划 §7 已显式选边:不回填 `phase_keep_alive`)。我确认了机制上确实如此(S4.2 capability 闸:列=0 → 两条腿恒 no-op),即不劣化、但也不改善;全部好处从**下一次 spawn 的 execution** 起生效。部署侧需要一次 Bridge 重启(Fix A/B 在 Bridge 进程内)。
5. **doorbell 文案用的是 `flywheel-comm inbox …` 这种写法,而机器上并没有叫 `flywheel-comm` 的可执行文件**(runner 实际用 `node $FLYWHEEL_COMM_CLI`)。这不是本 PR 引入的 —— 现有 `renderRunnerMailboxBatchEnvelope` 的批次投递文案早就是同一写法。真机 S6.4 里 runner 正确翻译并执行了。列为**观察项**,不是缺陷。
6. **已知可容忍噪声**(计划 §3-C 自陈):sweep 读取与 agent 下一 turn 内 ack 的竞态,至多留一条对已 ack 信的 stale doorbell。合同 2 限一条在途,agent 查空即继续。我没有专门构造这个竞态。

## 8. 复现

```bash
# 真 codex 守护进程验收(需要 CODEX_HOME 沙箱,见脚本头)
node engineering/doc/FLY-1774-codex-idle-wake/qa/s6-real-codex-daemon-e2e.mjs <sandbox-dir>
QA_BEFORE=1 QA_HOOK=<main-hook.sh> node .../s6-real-codex-daemon-e2e.mjs <sandbox-dir>   # 变更前基线

node engineering/doc/FLY-1774-codex-idle-wake/qa/s4-real-cli-doorbell-matrix.mjs
node engineering/doc/FLY-1774-codex-idle-wake/qa/s5-real-hook-to-real-db.mjs
node engineering/doc/FLY-1774-codex-idle-wake/qa/s5b-claude-branch-control.mjs
node engineering/doc/FLY-1774-codex-idle-wake/qa/s7-real-lane-fix-a.mjs
node engineering/doc/FLY-1774-codex-idle-wake/qa/s3-prod-commdb-migration.mjs <commdb-copy>
```

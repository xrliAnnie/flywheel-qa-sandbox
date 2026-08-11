# FLY-1697 全舰 lease 无出口 — QA 验证报告

Issue: FLY-1697 (https://linear.app/geoforge3d/issue/FLY-1697/全舰无出口-lease-只在建窗分支绑定launchd-native-走adopt分支-16-个-lead-全部无法-ack-任何收据已持续)
日期: 2026-08-11
基于: plan.md

**判决:PASS**(被测 head `5244864c`,PR #809)

---

## 1. 事故的"修前"实测底片(read-only,先取证再动手)

同一时刻打生产库取的三组数据:

| 证据 | 实测 |
| --- | --- |
| `lead-lease readiness --json` | `ok=false`;14 个 claude-code Lead **全部** `bound=false / holderAlive=false` |
| 记录的 holder pid | 14 个逐个 `ps` 核对,**无一存活**;lstart 全部冻在 `Mon Aug 10 08:35:59 → 08:38:37` |
| 收据结算(flywheel 项目 comm.db) | ACKED 但未结算的 Lead 收据共 **7,690** 条(claude-infra-bot 6306 / eng-lead 1129 / product-lead 179 / cos-lead 76) |

按天看结算量的塌陷,和 launchd-native 切换点严丝合缝:

| 日期 | 已结算 | 未结算 |
| --- | --- | --- |
| 2026-08-08(切换前) | 33 | 3 |
| 2026-08-10(切换当天) | 58 | 2141 |
| 2026-08-11(今天) | 98 | 4597 |

那 58/98 条"还结得掉的",正是 issue 里说的二阶效应——只能靠 `reply_to` 结清,也就是被逼着去回一条本该沉默的消息。

---

## 2. 独立 E2E 台架(自建,不是复跑实现者的测试)

台架跑的是**生产入口本身**:

```
scripts/flywheel-lead-wrapper-v2.sh   ← launchd 真正执行的那个脚本
  → 真 tmux server(隔离私有 socket)
    → 真 lead-body.sh(置 FLYWHEEL_LEAD_CARRIER=v2 + BODY_V2=1)
      → 真 claude-lead.sh v2 one-shot 块   ← 被测改动
        → 假 claude 子进程,在**真 pane env** 里跑真 flywheel-comm
           handle-receipt --action ack,打一个真 comm.db
```

只桩了两样:`claude` 子进程本身、`agent-team-transport` 探针。
**`ps` 没有桩**(所以 holder 存活是真进程表判的)、**`tmux` 没有桩**(所以 body 是真 pane 进程)、CLI / mailbox / lease store 全是真的。

> 这一点和实现者的 `fly1697-v2-lease-body.test.sh` 有实质差别:那份台架把 `ps` 换成了返回 `fixture-start-<pid>` 的桩,`holderAlive=true` 是拿假尺子量的。我这边换成真 `ps`,并额外把 lease 里记的 tuple 和 OS 进程表逐字比对。

夹具用生产形状复刻:一条 unbound、supervisor tuple 已死(`Mon Aug 10 08:36:08 2026`)的 lease 行;收据用真 Discord 消息载荷经真 `chat-ingest` 落成 inbox 载体,再走真 Bridge 侧 `claimLeadBatch → materializeForDelivery → recordLeadBatchDelivered → ackBatchByRecipient` 推到 ACKED-未结算。

### 结果 9/9 PASS(两次独立复跑一致)

| 断言 | 结果 |
| --- | --- |
| A1 lease 绑到活 body tuple,generation 1→2 | PASS `pid=35965 bound=true holderAlive=true` |
| A2 记录的 tuple 与真 OS 进程表逐字一致 | PASS `35965 / Tue Aug 11 11:12:00 2026` |
| A3 claim 穿过 `env -i` 屏障进 pane | PASS `FLYWHEEL_LEAD_LEASE_KEY` + `FLYWHEEL_LEAD_GENERATION` |
| A4 `handle-receipt --action ack`(无 reply_to)成功 | PASS `{"kind":"handled","action":"ack"}` |
| A5 收据终态结算 `processed`,且不再被重投选中 | PASS `pendingRedeliverySelected=false` |
| **B1 对照:去掉 shell 侧身份步** | PASS(pane 无 claim,ack 报**逐字**生产错误) |
| **C1 对照:只把 TS 侧条件回退到修前** | PASS(claim 在 pane 里,但 passthrough 依旧,ack 报同一错误) |

B1 和 C1 是这份报告的骨架:**两半各自都是承重墙**。C1 尤其关键——它保留 shell 修复、只把编译产物里的三个 `!env.FLYWHEEL_...` 条件抹掉,失败形态与生产逐字一致。

---

## 3. 529 QA Room 真 Discord N-to-N(必跑项)

改动碰 Discord 收据结算面 → 按标准跑真机。slot 3 部署 PR head(launchd → wrapper-v2 → 私有 tmux → body,与目标舰队同拓扑)。

| 步骤 | 证据 |
| --- | --- |
| 槽内 Lead lease | `test-slot-3-flywheel-test-3` `bound=true holderAlive=true ready=true generation=34 pid=32471` —— 与 `tmux list-panes` 的 `pane_pid=32471` **完全相同** |
| 同一时刻的负对照 | 生产 14 个未重启 Lead 依旧 `bound=false holderAlive=false` |
| 真 founder 消息 | 我用 Annie 真登录态在 `#ops-lead-test` 发了一条明说"别在频道里回,直接 ack" |
| 真收据 | `chat:flywheel-test-3:1536809347508732115`,carrier=inbox,3 分钟内 LEASED→ACKED |
| 真结算 | `processed`,evidence `{"kind":"lead_ack","fence":{"lease_key":"test-slot-3-flywheel-test-3","lease_generation":34}}` |
| 二阶效应已解 | Discord 截图:我那条消息是频道最后一条,**Lead 一个字都没回**,收据却结清了 |

`fence` 里的 generation 34 正是 v2 body 启动时绑的那一代 —— 结算权限确实来自新绑的 lease,不是绕过。

---

## 4. 仓库门

| 门 | 结果 |
| --- | --- |
| `pnpm -r build` | 全绿 |
| `pnpm lint` | 0 error(13 条既有 warning,与既有基线一致) |
| `test-lead-identity-preflight.sh` | 38 passed / 0 failed |
| `fly1697-v2-lease-body.test.sh`(实现者台架) | 5 passed / 0 failed |
| flywheel-comm lease 相关 6 个 vitest 文件 | 81 passed / 0 failed |
| 49 个引用 claude-lead.sh 的 shell 套件 | 46 绿,3 红 |

3 个红的**全部在干净 main 树上逐字复现**(用 `git archive main` 拉出独立树跑的),与本 PR 无关:

- `lead-backend-dispatch.test.sh` — main 上同为 `passed=1 failed=5`
- `claude-lead-plugin-fork-check.test.sh` — main 上同为 `args[@]: unbound variable`(套件自身 bash 3.2 `set -u` 缺陷)
- `fly1496-qa-acceptance.test.sh` — main 上同为 `aliasOpus: claude-opus-5[1m]` 契约不符(宿主 models.json 的 Opus-1M 绑定,既有环境项)

---

## 5. 顺带挖出的三个问题(都不是本 PR 造成的,建议各自立单)

### 5.1 🔴 潜伏的生产级 Lead 启动死锁 — converge 的 `mv` 会在 Lead pane 里卡死

跑 529 时 slot Lead 连续四次起不来,进程树定位到:

```
lead-body.sh → converge-flywheel-bin.sh → mv <tmp> <bin>/restart-services.sh   (卡了 3m52s 不动)
```

链路:
1. `scripts/lib/script-sanity.sh` 的 `install_script_atomic` 按设计把目标装成 **555(不可写)**;
2. 同文件第 11 行的注释断言"mv is not blocked by target file perms" —— **这句话在 macOS 的 tty 下不成立**;
3. `claude-lead.sh:1187` 用 `bash "$converger" >/dev/null 2>&1` 调用,**stdout/stderr 都丢了,但 stdin 还连着 pane 的 tty**;
4. BSD `mv`(无 `-f`)对不可写目标 + tty stdin ⇒ 弹交互式 `override ...?` 提示 ⇒ 永久等输入,而提示被吞掉,零诊断。

我做了干净 A/B 实证(pty 复现):

| stdin | 结果 |
| --- | --- |
| `/dev/null` | `mv` 静默成功 |
| pty(=Lead pane 形状) | `mv` 4 秒后仍在跑 = 卡在交互提示上 |

触发条件 = 装好的 `<state>/bin/*` 内容与当前 checkout 的源不一致(于是 converge 要重发布)。生产现在没炸,只是因为装好的副本恰好和 `~/Dev/flywheel` 一致;**任何从字节不同的 checkout 起的 Lead(QA 槽、部署窗口内的 Lead)都会永久挂死且无任何日志**。修法很轻:`script-sanity.sh` 那个 `mv` 加 `-f`(其余三处 converge 内的发布点本来就是 `mv -f`)。

### 5.2 529 框架:生产 `.env` 的 roundtable 变量半截泄漏进槽 Bridge

槽 Bridge boot 直接 fatal:
```
[roundtable] FLYWHEEL_ROUNDTABLE_CHANNEL_ID set but required config missing:
FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV, FLYWHEEL_ROUNDTABLE_BOT_USER_ID
```
根因:Runner/Lead 派生的 shell 只 export 了 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID`(+`_REPLY_IN_THREAD`),另两个在 `.env` 里但没 export。`test-deploy.sh` 非-roundtable 分支的 `env -u` 清单只清了 4 个 `TEAMLEAD_*`,没清 roundtable 族 —— 和该处注释里写的 FLY-529 教训是同一类 bug 的第二次发作。**从任何 Runner 会话跑 529 部署都会死在这里。** 修法:那条 `env -u` 清单补上 `FLYWHEEL_ROUNDTABLE_*`。

### 5.3 529 框架:槽的 lease store 没隔离

槽 Lead 的 lease 行落在**生产** `~/.flywheel/lead-lease.db`(key `test-slot-3-flywheel-test-3`)。本次是纯新增行、且生产 `projects.json` 不含该项目所以生产 readiness 不受影响,但这是真隔离缺口。manifest 的 `launchEnvironment` 已经支持透传任意 env,补一条 `FLYWHEEL_LEAD_LEASE_DB=${SLOT_DIR}/...` 即可。

---

## 6. honest boundary(没测到的、以及为什么)

1. **"真的不再重投"我只证到结算层,没证到时间层。** 我拿到的是:`processed` 结算行落库 + 该收据被 shipped 的重投选择器(`listChatReceiptPending`/`listExternalPending`)排除。我**没有**守着看几小时的真实投递周期。风险:低——所有重投谓词都以 `mailbox_log` 的 `processed/disposed` 为排除条件,这是数据层的硬条件,不是时序观察。
2. **全舰 14 个 Lead 全部拿到当代 lease,是 ship 后的观察项。** 只有舰队重启才会让活体旧 body 换代,QA 阶段无法预演。建议 ship 后立刻复跑 `lead-lease readiness --json` 确认 14/14 `bound=true`。
3. **2 个 codex-app-server Lead 不在本单验收面**(它们根本没有 lease 行,归 FLY-1632)。
4. **§5 的三个问题我只诊断+绕行,没有修**(超出本单授权范围)。绕行手段:slot bin 目录 `chmod u+w`、部署前 `unset FLYWHEEL_ROUNDTABLE_CHANNEL_ID`。
5. **529 槽 3 我至今没拆**,现场留着(Bridge 19873 + launchd Lead),以便复核证据;拆除时机请 Lead 定。清场时我停掉了两个 FLY-1655 时代的孤儿进程(pid 13226/13854/14109 的 Bridge 树、pid 82943 的 Lead),身份都逐条 `ps` 验过 cmdline 指向 `flywheel-FLY-1655` worktree,launchd 里已无对应 job,0 session。

---

## 7. 复现方式

```
QA1697_ROOT=<worktree> bash <scratch>/qa1697/qa-fly1697-e2e.sh
```
台架三个文件:`qa-fly1697-e2e.sh` / `seed-receipt.mjs` / `probe.mjs`。

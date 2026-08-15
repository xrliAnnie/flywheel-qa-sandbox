# FLY-1775 529 隔离房补 generalized-DAG 能力 — QA 复测报告(第 2 轮)

Issue: FLY-1775 (https://linear.app/geoforge3d/issue/FLY-1775/infra-529-隔离房补-generalized-dag-能力-装房路书固化14-条实测坑位收编)
日期: 2026-08-15
基于: plan.md · qa-report.md(第 1 轮 FAIL)

## 判决:PASS

上一轮两条阻塞(F1 同房第二轮起不来 / F2 teardown 非零残留)在真机复测中逐条证伪失败,
即两条都真的修好了,并且都拿到了因果证据而不只是「跑了一次是绿的」。

---

## 被测对象与环境

| 项 | 值 |
|---|---|
| PR | #847,OPEN,非 draft,MERGEABLE |
| PR head | `8e1661b9bda783b99213237f9b192642294f8205`,CI **9/9 全绿** |
| 实测 worktree HEAD | `a36d6ef80f33cd6f37059f6cf0af18229edb34d4` |
| 两者差异 | **仅 2 个 `progress.md` ledger commit**(`git diff 8e1661b9b..a36d6ef8 --stat` 只有 progress.md);产品代码逐字相同 |
| 环境 | host 真机(非 sandbox),slot 2 + slot 1,`--stub-runner --no-lead` |
| 生产影响 | 生产 Bridge 全程未重启(uptime 连续 6147s),8 个生产 cmux session 一个没掉 |

被测字节由 `--expect-head` 锁定,`/health` 双 SHA 与实测 HEAD 逐字相等(见 A1)。

---

## F1 复测:同房第二轮 —— 已修复

**上一轮病象**:第一轮走 A3 诊断出口后,QA session 永久停在 `awaiting_review`,
第二轮的 durable launch drain 判 `session_unsettled:<exec>:awaiting_review`,900s 超时退 1,
连 step 1 都进不去。

**本轮实测(同一个房,连跑两轮)**:

| 轮 | 起始 | 首个证据落盘 | 收敛耗时 | 出口 |
|---|---|---|---|---|
| run 1 (`656181ec`) | 21:26:17Z | 21:26:17Z(`replay pre-action: clean`) | — | step 1–7 全过 → step 8 A3 诊断 |
| run 2 (`7bf7db37`) | 21:29:30Z | 21:30:04Z(`replay pre-action: **converged**`) | **约 34 秒** | step 1–7 全过 → step 8 A3 诊断 |

**因果链取证(不是「跑绿了」而是「病因消失了」)**:

1. run 1 的 step-8 证据里 `closeout.action` 逐字为 `{"status":200,"body":{"success":true,
   "message":"FLY-202 terminated successfully","action":"terminate"}}`,QA session
   `2495750b` 落到 `status=terminated`、`terminal_at=2026-08-15 21:28:45`
   —— 正是上一轮永久卡住的那条 session,现在被 A3 出口自己结算掉了。
2. 第二轮 drain 因此拿到 `terminated`(在 `TERMINAL_SESSION_STATES` 内),给出 settled,
   34 秒完成收敛。**不是靠延长 timeout**(plan §7.1 明令禁止的做法)。
3. 收敛不止于库层:run 1 的 sandbox PR **#114 于 21:29:34Z 被 CLOSED**、
   其 branch `qa529-FLY-202-656181ec-...` 的 ref 查询返回 **404(已删除)**、
   run 1 的 `workflow_run.status` 变 `terminated`、implement session `3b10a716`
   在 21:29:31 结算为 `completed`。

**A2 / A3 互斥性(plan §7.1 的返工验收)已解除**:第一轮落 A3、第二轮照常开新 run 并
走完 1–7,两条验收在同一实现里同时成立。run 2 的 QA session `e6419838` 也已被同样机制
写成 `terminated`(21:32:28),即第三轮同样可收敛 —— 修的是机制不是这一次。

---

## F2 复测:teardown 残留 —— 已修复

**上一轮病象**:reap Codex stub 发生在 Bridge / 监管链仍活着时(`test-teardown.sh:860`),
stub 被立刻重新拉起,随后 Bridge 被杀,新拉起的那对成为孤儿 reparent 到 launchd。

**修法(结构性,不是加重试)**:reap 从 Bridge 停机**之前**挪到**之后**
(`test-teardown.sh` 现在 `:923 Killing Bridge` → `:968 reap`)。监管链先断,
重启窗口在物理上不存在。

**真机时间线取证**:

| 时刻(本地) | 事件 |
|---|---|
| 14:34:42–44 | Kill runner tmux session + owned display session |
| **14:34:48** | `Killing Bridge PID 21417` |
| 14:34:49 / 14:34:52 | 端口 straggler `21569` → SIGKILL |
| **14:34:5x** | `[qa-generalized] reaping 2 slot-owned Codex stub daemon(s)` |
| 14:34:56–59 | worktree remove → 清目录 → `Slot 2 teardown complete` |

**残留核验(逐 PID,到终点取证)**:teardown 前记下的 5 个 slot 进程
(`18422 18475 39297 49434 49991`)全部 `gone`;全机 `ps` 再扫
`qa-529-generalized-codex-stub|flywheel-test-slot-2` **零命中**;slot 目录消失;
`tmux list-sessions` 无 slot session;端口 19872 空闲。第二次 teardown(slot 1,带 `--alerts`)
同样 rc=0、零残留。

**为什么这次的单次跑绿可以作为依据**(上一轮我自己说过单次跑绿不算):
因为这次同时有 ① 竞态窗口被结构性消除的代码次序、② hermetic 断言
`generalized teardown stops Bridge before reaping restartable stubs` 守住这个次序、
③ 真机时间戳三者互证,而不是只有一次干净结果。

---

## A1 装房:独立复核全绿(逐项到终点取证,不读脚本自报汇总行)

| 项 | 独立取证 |
|---|---|
| 一条命令 | `scripts/test-deploy.sh 2 --generalized --stub-runner --no-lead --expect-head <sha>` rc=0,零手工 SQL、零 env 手调 |
| `/health` | `ok=true` `buildMode=built`,`buildSha == artifactBuildSha == a36d6ef8...`(= 实测 HEAD) |
| flag attestation | 5/5 全 `"1"`,`wrapperPid=21417 == bridgePid`,mode `0600`,文件内无 secret |
| bindings | 我另开 slot 库直查 `workflow_category_binding` **恰 5 行**,模板 canonical(tpl_code/tpl_prd/tpl_design/tpl_prototype/tpl_generic_menu),`retired_at` 全 null,`current_published_revision=1` |
| config | `.flywheel/config.yaml` 逐字含 `dag: true` 与 `work_kind: true` |
| menu | 我自己带 Bearer 直查 `/api/workflow/menus?projectName=test-slot-2&leadId=flywheel-test-2` → `success:true`,`code` 菜单 roles 恰 `[design,implement,qa]`,另有 `generic` |
| token | `api-token` mode `0600`,`room-info.json` mode `0600`,reply-by-issue 保持 0 |

第二次装房(slot 1,`--generalized --alerts`)同样一次到位:`readiness: flags 5/5 · bindings 5/5 · pipeline+work_kind on · menu on`。

---

## 坑位真环境命中(本轮新增覆盖:坑 5)

- **坑 2(sun_path)**:本 runner 真实 `TMPDIR` 89 字符 → 装房日志逐字
  `generalized preflight: TMPDIR socket path is too long; child processes use TMPDIR=/tmp`,自动回落。
- **坑 3 / 坑 4**:本环境真带 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` + `FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD`,
  房内 exec boundary 断言通过;`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 本环境未设。
- **坑 5(上一轮的诚实边界,本轮补上,且是阴阳双对照)**:
  - **阴性(失败必须响)**:slot 2 带 `--alerts` → 装房在任何 mutation 前停手,
    逐字 `ERROR: alert channel 1519421055805165842 inaccessible to bot flywheel-test-2 (HTTP 403).
    Invite this bot with View/Send/Read. See scripts/setup-alert-channel.sh.` ——
    点名 bot identity、给修复入口、**不打印 token**(全日志只有 `TEAMLEAD_API_TOKEN=<redacted len=26>`),
    且只占了 slot claim(4KB 目录)、零进程、零 worktree。
  - **阳性(成功必须真跑)**:slot 1 带 `--alerts`(其 bot 有邀请)→ 逐字
    `generalized alert preflight: every sender-capable slot bot passed POST+DELETE`,
    且 alert queue/deadletter 隔离到 `/tmp/flywheel-test-slot-1`。
    这一对说明该闸不是空过绿。
- **坑 14**:两轮 A3 出口都精确落 `failures=[workflow_node_pr_binding_missing]` +
  `predictedServerReason=land_head_unavailable`,PASS 未发送,诊断包完整落盘。

---

## A4 回归

| 套件 | 结果 |
|---|---|
| `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` | 25/25 |
| `scripts/__tests__/qa-generalized-helper.test.mjs` | 4/4 |
| `scripts/__tests__/qa-generalized-codex-stub.test.mjs` | 3/3 |
| `scripts/__tests__/test-deploy-generalized.test.sh` | 全 PASS(含新增的 teardown 次序断言与 A3 终态断言) |
| `packages/teamlead` 变更面 3 文件 | 96 pass / 2 skip |
| `packages/claude-runner` 变更面 2 文件 | 106 pass |
| PR #847 CI(exact head `8e1661b9b`) | **9/9 全绿** |

---

## 诚实边界(未覆盖 / 已知代价 / 不归本单)

1. **step 9 未达**:两轮都停在 A3 诊断出口(`workflow_node_pr_binding_missing`)。
   这是 plan §7 A3 明确允许的风险出口,机制修复属 FLY-1768 F2 产品侧,**不计入本次判决**。
   代价:`land` 段(founder gate → land)在 529 房内仍未被真机走过一次。
2. **A4 只跑变更面,没跑全仓 vitest**:host 上跑全量套件会压死生产 Bridge(既有教训),
   所以全仓结论以 PR CI 9/9 为准,不由我本机复述。
3. **F2 是竞态**:我给的是「结构性次序 + hermetic 守卫 + 一次真机时间戳」三证,
   不是统计意义上的多次重放。若要更强保证,需要在负载下重复 teardown 若干次。
4. **[生产现状,不归本 PR] slot Bridge 会往生产 alert-deadletter 落盘**:
   不带 `--alerts` 装房时,slot Bridge 被 teardown 杀掉会在
   `~/.flywheel/alert-deadletter/` 写 severe 的 `bridge_abnormal_exit` 记录
   (本轮观测到 2 条:PID 21569 / 6723)。这**不是** FLY-1775 引入的 ——
   该目录里同类历史记录 247 条、`flywheel-test-*` 的死信可回溯到 6 月 3 日。
   影响面是生产状态目录里的垃圾堆积,不是 founder 被 page(reason 为 `unknown-lead`,
   进的是死信不是频道)。建议另开单让 generalized 房默认也隔离 alert 目录。
5. **[既有形态] slot Runner 的 TUI pane 跑在宿主默认 tmux server 上**,
   stub socket 落在生产 `~/.flywheel/cdx-sock/`。teardown 两者都清干净了
   (窗口按 owner 精确杀、外部 owner 的 8 个生产 cmux session 一个没碰),
   但这确实是「隔离房用了生产坐标」的既有形态,本单未改变它。
6. **代码 review 记录我没查到**:PR #847 上没有 Codex code review 评论,
   plan 里只记到 design review R5 APPROVED。按 DAG qa 节点纪律我**不做** codex 复审,
   所以这一项**未经我验证**,请 Lead 确认 review 节点确实跑过。
7. **本单的 gate 前件我提前查过了**:本 run(`1120106d`)的 `workflow_node_pr_binding`
   **零行**,manifest 的 `founder_gate` 下游是 `land` 节点(mode=land)。
   若 PASS 时 Bridge 无法从我这条 QA execution 的身份铸出 binding,
   verdict 可能撞 409 `land_head_unavailable` —— 这正是本单 A3 在描述的同一类机制问题。
   若发生,我会原样上报而不改判决。

---

## 交回状态

slot 1 / slot 2 均已 teardown,全机零 slot 进程、零 slot 目录、零 slot tmux session;
生产 Bridge 未重启、生产 cmux 8 个 session 完好。
证据副本在 `~/qa-fly-1775-evidence/`(两轮 deploy / drill / teardown 日志 + run 1 的
按 run 分层 step-1..8 + owner.json)。

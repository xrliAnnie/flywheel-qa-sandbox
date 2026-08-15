# FLY-1775 529 隔离房补 generalized-DAG 能力 — QA 验证报告

Issue: FLY-1775 (https://linear.app/geoforge3d/issue/FLY-1775/infra-529-隔离房补-generalized-dag-能力-装房路书固化14-条实测坑位收编)
日期: 2026-08-15
基于: plan.md
被测 head: `90345dfe0911e2aa03202e34fc97efb923a06d3c`(PR #847 OPEN 非 draft,CI 9/9 全绿)
环境: host 真机(非 Codex sandbox),slot 2,被测字节来自本 worktree

## 判决:FAIL

两条阻塞级发现,都落在本轮点名的核心验收上(第二轮 launch 能起 / teardown 零残留)。

---

## F1(阻塞)同房第二轮 drill 永远起不来

**现象**:同一房内第二次运行 driver,卡在 pre-action 收敛的 durable launch drain,
900s 超时退 1,连 step 1 都进不去。

```
[qa529] Error: prior run 6e416b79-... durable launch drain timed out after 900000ms; last=false
    at convergePriorRun (scripts/qa-529-generalized-e2e.mjs:506)
```

**根因(用被测代码自己的分类器取证,非推测)**:把 slot 库真实行喂给
`classifyDurableLaunchDrain`,verdict 逐字为

```
session_unsettled:35e8adba-aaee-4371-91c1-dc0561204e2c:awaiting_review
```

链条:

1. 第一轮按 plan 的 A3 出口结束 —— step 8 判 `workflow_node_pr_binding_missing`,
   扣住 PASS,退 20;
2. QA stub 随后收到 exit fence 并正常退出(`stub-state` 里 `lastAction=exit`,进程消失);
3. 这条 QA execution 的 session 因此永久停在 `awaiting_review` / `terminal_at=null`,
   `workflow_run_node` 的 qa attempt 2 永久 `running`;
4. drain 要求每个 delivered launch 的 session 终态,而 actor 已死,无任何推动者。

**可证伪**:`last_activity_at = 09:12:28`,我在 `09:29:05` 复查状态逐字未变;
中间 15 分钟 drain 一直轮询同一个 false。**不是慢,是死。**

**要害(plan 级)**:A3 出口是 plan 自己写明的预期结局(F2 机制未修就必走这条),
而 A2 要求同房连跑两次且第二次走完收敛 —— **这两条验收在当前实现里互斥**。
只要第一轮落在 A3,第二轮就永远起不来。

**修法约束**(方向由 implement 定):要么让 drain 承认「actor 已死 + run 已 terminated
+ launch 已 delivered」的不可迁移会话为 settled,要么让 A3 出口在退出前结算自己的
QA session。**不可用延长超时糊过去** —— 它不是时间问题。修完后 plan 的验收节需同步,
两条验收不能在同一实现里互斥。

---

## F2(阻塞)teardown 非零残留

**现象**:teardown 之后仍有 slot-owned 的 Codex stub daemon 存活,并 reparent 到
launchd 长期赖着。

**逐秒时间线**:

| 时刻 | 事件 |
|---|---|
| 02:30:1x | teardown 日志 `reaping 1 slot-owned Codex stub daemon(s)` |
| **02:30:18** | 新 `flywheel-codex-with-fallback` wrapper(pid 87010)+ stub app-server 子进程(pid 87027)**出生** |
| 02:30:20 | teardown 才 `Killing Bridge PID 49627` |

reap 发生在 Bridge / 监管链仍活着的时候 → 立刻被重新拉起 → 随后 Bridge 被杀 →
新拉起的这对成为孤儿。

**归属无歧义**:87027 的 `writable_roots` 逐字含
`/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-202`,而该目录已被 teardown 删除。

**脚本次序对应**:reap 在 `test-teardown.sh:860`,`Killing Bridge` 在 `:928`。

**对照(重要)**:旧 head 那次 teardown 我验过是干净的 —— 所以这是**时序竞态窗口,
不是每次必现**,单次跑绿不能作为通过依据。

孤儿已由我手动清除,host 现已干净,slot 目录已消失。

---

## 通过项(真机取证)

### A1 装房 — 全项独立复核绿(到终点逐项取证,非读脚本自报汇总行)

| 项 | 证据 |
|---|---|
| 一条命令 | `test-deploy.sh 2 --generalized --stub-runner --no-lead --expect-head <sha>` EXIT=0,零手工 SQL、零 env 手调 |
| /health | `ok=true` `buildMode=built`,`buildSha == artifactBuildSha == 90345dfe` |
| flags | attestation 5/5,`wrapperPid == bridgePid`,mode 0600,无 secret |
| bindings | 独立开 slot 库查 `workflow_category_binding` 恰 5 行,模板 canonical(tpl_code / tpl_prd / tpl_design / tpl_prototype / tpl_generic_menu) |
| config | `pipeline.dag` + `pipeline.work_kind` 均 true |
| menu | `/api/workflow/menus` 解析出 `code`(design/implement/qa)与 `generic`,model 解析正确 |
| token | api-token 0600,reply-by-issue 保持 0 |

### 坑位真环境命中(不是构造出来的)

- **坑 2**:本 runner 的 `TMPDIR` 实测 89 字符 → 自动回落 `/tmp`(sun_path 安全)
- **坑 3 / 坑 4**:本环境真带 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` / `REPLY_IN_THREAD`
  → wrapper 在 exec 边界内断言通过
- **尺子的阳性对照**:分别注入 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 与 roundtable id
  各跑一次 wrapper,两次都逐名报错退 1 → 证明该断言非空过

### 九步 drill run 1:step 1–7 全过

- step 5:question gate 投递成功,且停驻的 implement 不当 holder
- step 6:QA FAIL → `wake_delivered`,`held` / `needs_lead` 零命中
- step 7:逐字 `original_body_resumed`,attempt 2 真推进 head
  (真 sandbox PR #109,branch `qa529-FLY-202-6e416b79`)
- step 8:诊断包形态正确 —— `failures=[workflow_node_pr_binding_missing]`,
  `predictedServerReason=land_head_unavailable`,PASS 未发送

### A4 回归

- 四条 hermetic 套件本机全绿:`test-deploy-generalized.test.sh` 全 PASS /
  helper 4/4 / e2e-lib 20/20 / codex-stub 2/2(load 27 实测)
- CI 在 exact head 9/9 全绿(含 Script Tests 与三片 teamlead unit)
- 上一 head 我报红的 codex-stub readiness(测试 150ms 窗 < stub 模块加载时间)
  已按建议修为「stub 自报 ready、测试等 marker」,**未改 stub 退出语义**

---

## 诚实边界(未覆盖 / 已知代价)

1. **坑 5 未走**:alert sender 的 POST+DELETE 真写预检本轮未验证(未带 `--alerts`,
   需 alert 频道 + bot 邀请矩阵)。
2. **step 9 未达**:被 F2 机制链 `land_head` 挡在 step 8,属 plan 允许的 A3 风险出口,
   **不计入本次 FAIL**。
3. **换 head ⇒ 在途 sandbox PR 孤儿化**:收敛只在同房凭 `owner.json` 认领,换 head
   必须重装房,于是在途 sandbox PR 会孤儿化(本轮新增 #109,另有 #107 / #108)。
   Lead 已裁定不加机制,**需 implement 补进路书的「已知代价」节**,官方出口是
   下一轮 driver 的 pre-action 收敛。

---

## 交回状态

worktree `git status` 干净;slot 2 已 teardown;无遗留进程;
证据副本在 QA session 的 scratchpad(`evidence-final/` 按 run 分层的 step-1..8 + owner.json)。

> 本报告未提交进分支:节点约束要求 verdict 提交后不得再产生 commit
> (accepted gate-entry head 不可变)。

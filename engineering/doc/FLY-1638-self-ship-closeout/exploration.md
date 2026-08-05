# FLY-1638 self-ship 自动化收尾 — 探索

Issue: FLY-1638 (https://linear.app/geoforge3d/issue/FLY-1638/self-ship-自动化收尾1625-修复合一单-ship-绑定修复-重试封顶-防空转-qa-ttl-预配-重启前暂停接活)
日期: 2026-08-04
基于: 无

## 1. 缘起

FLY-1625 病理报告 + 业界 DeepResearch(判词:**小而保守的对账层 + 控制面四步模型**)+ founder 收敛指令「尽量 consolidate 少建单」→ 引擎侧全部修复合到本单。消息层相关项(通知折叠、held 告警发 Lead 的展示层)不在本单,由 FLY-1569 总纲 D/E 批承接。

本单是 self-ship 自动化的收尾:目标是一个 DAG run 从 QA PASS 到 merge 到收尾级联**全程零人工**,且引擎不再产生僵尸重派 / 幽灵 rework / 刷屏告警 / 凭证误伤这四类噪音。

## 2. 六个修复面(问题陈述)

### 2.1 RC-B:ship 绑定断链(`ship_target_binding_unavailable`)

**现象**:founder 在 approve gate 批准后,verify 步骤撞 `ship_target_binding_unavailable`,ship 无法自动进行(1631 是第 17 个撞墙者),每次都要人工兜底。

**病理**:schema-v2 工作流物化 approve gate 时**没有写** `workflow_ship_target_binding` 行,而 `/head-authority` 的 `land_v1` 分支只认这张表。两个候选修法:
- (a) schema-v2 物化 approve gate 时补写 binding 行;
- (b) 让 `land_v1` 分支识别 schema-v2 的凭证链。

### 2.2 重入重试封顶(workflow_rework_delivery)

**现象**:1631/1596 两场 held 刷屏(502 代 / 980 代)——rework 投递失败后无限重试,每次失败刷 founder thread。

**目标**:重试 ≤5 次后停,状态转 `needs_lead`;终止时告警**发 Lead alert 通道**,不刷 founder thread。这是给既有机制加谓词,不是新机制。

### 2.3 防空转谓词(幽灵 rework)

**现象**:1631 implement@3 —— 零改动的幽灵 rework 被铸造(第 7 例)。head 没变、同 head 已有 PASS verdict,引擎还在铸新 rework 空转。

**目标**:rework 铸造前检查「head 未变化 且 已存在同 head 的 PASS verdict」→ 不铸。

### 2.4 QA 节点 TTL 预配(workflow_submission_credential)

**现象**:1628 真机 QA 实测 3.7h,凭证 1h 固定窗口在 00:16 过期——一天三次真机 QA 撞墙。

**目标**:credential 软窗口按节点类型预配,qa 节点默认 6h,其余节点保持现值。

### 2.5 僵尸重派根除(2026-08-05 引导潮,最贵的一条)

**现象**:6 个 generic 单(1590/1591/1597/1606/1623/1625)活全在 8-01 合入 main,8-05 集体复活重派;1590×2 / 1591×2 白烧。四个子缺陷:

1. **complete 必 500**:`workflow-menu.ts:368-371` carrier 存在时要求 ship_claims 蕴含 git-head claim(回归提交 `2ed08e54` / PR #748 引入)→ 所有 generic 单 complete 必然 500 → 完成信号永不达 → StateStore 永远 running → 每次 Bridge 重启重派。
2. **seed 无合成验证**:坏 seed(编出 `resolveWorkflowGateAuthority` 会抛的快照)能进生产。需要合成断言:每个 seed 编译出快照后跑一遍 `resolveWorkflowGateAuthority`,不抛才通过。
3. **terminated run 复活**:已 terminated 的 run 仍能经 dead-execution 重试通道 admit 新 exec(1591 实证:8-01 走完+terminated,8-05 03:50 仍 spawn runner 去做 4 天前完成的事)。
4. **generic 节点没有合法非 needs_review 出口**:取消/无产出单关不掉(route 硬绑 + 必须 --pr),1623 这类取消单只能伪造 PR 号或永远挂着。

> **注**:代码审计对子缺陷 ①③ 的前提有实质修正(① 真 throw 点在 `workflow-run-snapshot.ts:176-177` 非 workflow-menu.ts;③ terminated run 本就进不了通道,真缺陷是死亡谓词把「complete 吃 500 的诚实 runner」判成真死)—— 详见 research.md §4。

### 2.6 重启前暂停接活(admission pause)

**现象**:1634 部署期间派发 → 乱账。DeepResearch 控制面四步模型(pause → drain → swap → resume)中我们唯一缺 pause 这一步。

**目标**:restart-services 停 Bridge 前置一步「拒绝新 /api/runs/start 若干分钟」,新申请收到明确「稍后再试」而非被吞进乱账。几十行的小改。

## 3. 约束与验收

- **机制数不升**:第 2/3 条是给既有机制加谓词;不引入新守护进程、新周期 timer。
- **活体锚**(全部必须实际不再复发):
  1. 1631 ship approve 后零人工(binding 修复)
  2. 1631/1596 held 刷屏 → 重试停在 5,告警只到 Lead
  3. 1631 implement@3 幽灵 rework 同条件不铸
  4. 1628 QA 凭证 → qa 节点 6h 窗
  5. 1634 部署期间派发 → pause 生效期间明确「稍后再试」
- **追加锚(8-05 引导潮)**:
  - 6 个 generic 单同场景零重派
  - tpl_generic_menu 的 completed 计数能 >0(现为 0;tpl_code 为 8)
  - 取消类单(1623)能正常关闭,不需伪造 PR 号
  - 96 快照普查里 6 例 incoherent_ship_bundle 归零
- **真机 E2E**:一个完整 DAG run 全自动走完 QA PASS → 自 ship → 收尾级联。

## 4. 代码审计要点(摘要)

> 详细事实见同文件夹 research.md(基于五路并行代码审计)。

- ship 绑定链:`workflow_ship_target_binding` 表(StateStore)→ `/head-authority` 路由 → `land_v1` 分支 → `resolveWorkflowGateAuthority`。
- rework 链:`workflow_rework_delivery`(StateStore)+ `workflow-rework-coordinator.ts`。
- credential 链:`workflow_submission_credential` + `workflow-submission-expiry.ts` + `node-type-registry.ts`。
- 僵尸链:`workflow-menu.ts`(carrier/ship_claims)+ `workflow-seeds/` + `dead-exec-activity.ts` + complete route 校验。
- admission 链:`/api/runs/start` 路由 + `scripts/restart-services.sh`(FLY-1634 简化后的停机序列)。

## 5. 明确不做(honest boundary)

- 消息层:通知折叠、held 告警的展示形态 → FLY-1569 D/E 批。
- 不重构 workflow 引擎本体;`workflow_v2` DAG 引擎是硬红线,只做谓词级/写入级小改。
- 不动 founder-gated merge 权限模型(verify-approval 安全检查保持不变,只修它读不到 binding 的断链)。

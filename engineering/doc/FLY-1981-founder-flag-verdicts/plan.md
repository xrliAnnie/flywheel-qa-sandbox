# FLY-1981 flag 治理 founder 裁定执行批 — 实施计划

Issue: FLY-1981 (https://linear.app/geoforge3d/issue/FLY-1981/flag治理founder裁定执行批-复查结论9-条固化删除-auto-qa-整体退役-consentattribution)
日期: 2026-08-22
基于: research.md

## 0. 目标与红线

把 founder 2026-08-22 的 12 项裁定净删除落地:A 组 10 条固化(门/值写死 + 删旋钮),B 组 2 项整体退役(auto-QA 管线 + founder_milestone_report,带机制删除、先核后删),C 组「新 flag 默认纳管」守卫红线 + runbook。

红线(违反任一即打回):
1. **零新 flag**;固化只许「门在」,绝不写死「门不在」(consent 固化档 = 现网实测 `audit_only`,非 registry default off)。
2. `FLYWHEEL_MERGE_APPROVAL_GATE`(merge 门)与 FLY-1436 两条 RESERVED 不在本批,**一个字节不动**。
3. 不留死代码:固化后不可达分支净删;但 **auto_qa_record 表与其读路径是冻结历史账本,保留**(防盗门 A7 + 历史 session 落地依赖)。
4. coordinator 拆解必须按 research §2 死/活二分表 + symbol 级 caller matrix:`auto-qa-held.ts`(→`review-hold.ts` byte-for-byte)、codex 证据写入(`onCodexReviewResult`→`recordCodexReviewApproved`)、`codexHold`/`reconcileCodexHolds`、三类 ship 告警、`postThreadResult` **搬家存活**,不许陪葬。
5. 生产 `~/.flywheel/.env` 两条残值不在本 PR 直改;清理走 research §5 的**单一七步顺序**(stage → 原子删 env → static preflight → no-old-binary-restart 栅栏 → 部署 → 验证 → 回滚先恢复 env)。

## 1. 分批 commit 序列(每批 RED→GREEN,批间可独立回退)

### Batch 1 — A 组低波及 6 条固化(reports_ttl / workflow_resume / instruction_path_check / design_html_gate / ship_ci_guard / qa_done_gate)

1. RED:逐 flag 写「旋钮不存在」断言——固化值生效 + `=0`/override 不再被读(现有 gate-off 用例反转);集合守卫(§4)先注入这 6 个名字预期 RED。
2. GREEN:按 research §1 A1-A5、A7 删读点/分支/registry 行/store-policy 条目(workflow_resume:STORE_MANAGED_FLAGS 5→4、codec、wrapper、两处 plugin 注入);`resolveDefaultOnGate` 仅剩 merge 门调用方,保留不内联(merge 门零改动红线)。
3. 墓碑:`RETIRED_FLAGS` +6(retiredBy FLY-1981)。

### Batch 2 — A6 codex 硬门固化(单列,因 vitest.setup pin 波及)

1. 摸底 commit:先单独摘 `vitest.setup.ts:49` 的 `FLYWHEEL_CODEX_HARD_GATE="0"` pin,跑 teamlead 全包,清点靠 pin 绕门的存量用例(预期集中在 event-route / merge-ship-gate / fly1505 家族)。
2. 逐用例改为真证据(`recordCodexReviewApproved` fixture)或显式 `codex_skip`;**禁止**测试内重设 env 复活旋钮。
3. GREEN:删 codex-gate.ts / verify-approval.ts 的 `=0` 三级读;verify-approval.test 的 .env live-toggle 双向用例 → 恒 ON 断言(reverse-compat sentinel 合法 retarget,PR 点名)。墓碑 +1。

### Batch 3 — A9 attribution 最严档 + 529 QA 房换批准路径(Codex R1/R2/R3 三轮终形——零新 Bridge 代码)

前置事实(HEAD 源码,research §1 A9 证据链):respond.ts 对 Lead 的 approval-intent 回复在写入前即抛 `lead_ack_rejected`(旧 test-auto-approve respond 路在 HEAD 本已必死);`/api/actions/approve` 对 engine run 经 engineAuthority 准入(carrier 可 running),非 engine 要求 awaiting_review,写 writer="bridge" 回执 + 合法 FSM approve 边 + 唤醒。**不发明任何新写入面/状态推进,不弱化 verify-approval 任何检查。**

1. 529 驱动汰换到既有 `/api/actions/approve`:① engine(schema-v2)形态——ship 卡 gate 走 engine authority 直接 POST approve;② legacy 阻塞 gate 套件形态——harness 改走生产标准绑定路(runner `complete --route needs_review --question-id <qid>` 落 awaiting_review + binding)再 POST approve → 唤醒 → resume runner verify+merge。**合同测试按分支取证(Codex R4 精度注记)**:engine 分支在 guarded response 后即返回、依赖 durable workflow source projection——断言精确 holder 推进到 `approved` + automated land 激活,**不含** legacy session FSM 迁移/runner wake;legacy 分支断言 `awaiting_review → approved_to_ship` + wake + 真 `verifyApproval` 对 bound question/head 放行(不是只断言 response 插入 + wake)。对抗用例:错 owner / gate 缺失或过期 / head 漂移 / 重复回执 / 重试。deployed/cache 驱动字节与 HEAD 的偏差核查并入 FLY-1914 sweep。
2. RED:verify-approval attribution 恒 ON 用例(writer="bridge" 通过、lead-attributed 拒)。
3. GREEN:删 `resolveFounderAttributionGateOn`;删旧 respond 批准路(test-auto-approve.sh 汰换)。
4. **双冒烟**:①预删除冒烟(=0 注入仍在);②删 `test-deploy.sh:901-902` 注入后的 **final-head 冒烟(注入已不在)**——两个都过 Batch 3 才算完(顺序不可倒,否则 QA 房失去唯一批准路)。shell 合同测试更新。墓碑 +1。

### Batch 4 — A10 consent 写死 audit_only + A8 mention-gate 摘牌

1. consent:`resolveDecisionMode` → 常量 `"audit_only"`;删 env 解析 + `FLYWHEEL_FOUNDER_CONSENT_ENABLED` 别名;`resolve.ts` DECISION_MODE 特判删;`config.ts:220` off 分支净删;`gate-response-router.ts` enforce 专属写路径净删(`TRUSTED_BRIDGE_APPROVAL_WRITERS` 的 `"bridge-founder-consent"` 读侧保留);evaluator/audit/cache/prompt/reserved-endpoints 零改动。decision-mode.test sentinel retarget(PR 点名)。墓碑 +2(含 legacy 别名,从 NON_FLAG_ALLOWLIST 移出)。
2. mention-gate:删 registry 行 + `codex-lead.sh:97` `-z` 预设覆盖口(projects.json 成唯一来源);env var 进 `NON_FLAG_ALLOWLIST`(plumbing 注记);runtime/apply 脚本字节不动。**不入墓碑**。

### Batch 5 — B 组退役(先核后删;Codex R1 #2/#3/#6 修正)

1. **删前必核(结果写进 PR body,带时间戳)**:
   a. `auto_qa_record` 零新增窗口复测(最后写入 2026-07-12 的基线再确认);
   b. 全项目近 30 天 session 清点:非 DAG code-PR 活体(**必须为零才许删**;非零则停,上报 Lead——退役后这类 session 无任何补证据出口,含 founder);
   c. 消费者 sweep 三 root(主仓 scripts/packages、插件 fork `external_plugins/`、`~/.claude/plugins/cache/*/`),对象 = 全部本批退役名;查不到的 root 显式写「未检查」(FLY-1914 规矩)。
2. **symbol 级 caller matrix 先行**(research §2 死/活表是起点):coordinator 方法 × effects 方法 × routes × alerts × 冻结表读者,逐外部调用点;每步删除前置 = 生产编译过 + 零意外 caller。
3. 搬家先行(独立 commit,行为零变化):
   a. `auto-qa-held.ts` **byte-for-byte 迁 `review-hold.ts`**(共享 fail-closed 授权/founder-surface 谓词,9+ 模块 import),只删 hard-gate-off 分支;
   b. `onCodexReviewResult`(去 re-drive 尾巴)→ 新 `codex-review-ingest.ts`;`codexHold`/`reconcileCodexHolds`(plugin.ts:9359)随 review-hold 家族保留,且(Codex R2 #2)从 `onMainAwaitingReview` **前段抽出中性 codex-review hold handler**、保留 event-route/DirectEventSink 两个活体完成调用位——否则新进 review 的 session 要等 Bridge 重启才拿到 once-per-head codex 指令 requeue;codex 满足后即停,不入任何 QA policy/spawn 路径;测试:启动后新进 review session 的 hold/requeue + 既有重启对账;
   c. 三类告警(alertMergeWithoutApproval / alertShipAttemptFailed / alertCompleteMarkerHeld)→ 新告警模块;
   d. `AutoQaEffects.postThreadResult` → 中性 review-thread effect(ReviewRequestCoordinator 在用,plugin.ts:9206-9231);
   e. event-route/DirectEventSink/plugin 调用点随迁;fly1505/merge-ship-gate 集成测试全绿。
4. 杀死者:auto-qa-{policy,config-source}.ts 整删;coordinator/effects 删 spawn/retest/orphan-sweep/recovery/快照写入家族;**manual-qa-routes.ts + `/api/qa/manual-spawn*` mounts + manualQaTokens + fleet 接线 + 路由测试**;HeartbeatService stuck 巡检;lead-rules-base/auto-qa-pipeline.md + claude-lead.sh 装配;StateStore 死写面(读 API 全留);`.flywheel/config.yaml` qa 块;ConfigLoader **整个顶层 qa 路径**;registry 两行;`PROTECTED_LEGACY_FLAG_NAMES` 摘 `auto_qa_killswitch`;`FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS`(allowlist + 读点)。
5. `auto_qa_stuck` kind **保留**(episode 连续性,历史名),`GatePoller.handleHeldReviewGate` 恢复文案重写为 cancel/re-dispatch 出口(不再指向已删 manual-QA 端点);kind-contract 注记。
6. founder_milestone_report 全家谱:gate-poller / config-source / ConfigLoader **整个顶层路径** / types / registry / config.yaml 块 / **emitFounderMilestoneNotification + `founder_milestone_undelivered` kind(五处)+ 三个 FLYWHEEL_FOUNDER_MILESTONE_* tuning env** / 相关测试。
7. 墓碑:envVar +1(FLYWHEEL_AUTO_QA);新增 `RETIRED_CONFIG_PATHS` 机制(truth.ts)收**顶层 `qa` + `founder_milestone_report` 全路径**,ConfigLoader parse 后 loud-reject stale 块(含备用子键用例),drift/truth 守卫接上。
8. 退役后语义回归:非 DAG code-PR → `qa_snapshot_missing_failclosed` 的用例保留并断言(更严方向,fail-loud);唯一出口 = cancel + DAG 重派,文档与告警文案一致。
9. **2026-08-23 R1 HIGH 修订(Lead question gate `04a2cf4a-5ec9-4652-9789-20f96e21b173` 裁定):** 上一步只覆盖存量 session,不足以封住未来项目缺省 legacy。新增 RED→GREEN:ConfigLoader 缺省 `pipeline.dag=true`;Bridge boot 对无 menu 项目补只新增、不覆盖的 `* → tpl_code` binding;显式 `dag:false` 必须由 `/api/runs/start` 以 `DAG_DISPATCH_DISABLED` 拒绝;缺 schema-v2 binding 以 `DAG_ENTRY_NOT_MATERIALIZED` 拒绝,不许回落 legacy。阳性对照必须真的命中显式 false。当前在飞 legacy code-PR 清点必须为 0;陈旧 blocked 行单列披露但不冒充活 runner。QA 必跑 schema-v2 真机主路,不得退化为历史 `auto_qa_record` fixture。
10. **2026-08-23 QA 5.9 修订(覆盖第 9 条 wildcard 形状):** `reconcileDefaultDagCategoryBindings` 不再生成 `* → tpl_code`;改为从 `WORKFLOW_MENU_BINDINGS` 为每个 DAG-on、非 menu-managed 项目补齐 6 条 per-category exact binding,与 flywheel menu 矩阵同源。只补缺失行,operator 既有 exact/wildcard 均不覆盖;二次 reconcile 必须 `bound=0`。测试锁定:单项目六类解析、幂等、既有 exact/wildcard 保留、显式 `dag:false` 零行,以及 1 个 menu-managed + 5 个默认项目最终 **36 条 exact、零系统 wildcard**。dispatch 继续要求 exact binding,保持 `DAG_DISPATCH_DISABLED` / `DAG_ENTRY_NOT_MATERIALIZED` 两条 409 fail-closed 语义。

### Batch 6 — C 组守卫 + 集合守卫 + runbook(Codex R1 #4/#5/#7 修正)

1. `LEGACY_UNMANAGED_BASELINE`:不可变最大集合,按 spec 名冻结**全部**现存非纳管 spec(含存活 governance_gate 与 project_config);守卫断言当前非纳管集合 ⊆ 字面量、只许缩。
2. 新 spec 红线守卫(config 包):基线外的新 spec 必须 ∈ STORE_MANAGED_FLAGS 且具备 env-backed codec + store wrapper 读点 + seeded row(ensureFlagValueRows)+ management-route 测试;**公式不含 FLAG_EXEMPTIONS、不含 category 豁免**;项目级 store 授权出现前**机械拒绝新 project_config spec**。**FLAG_EXEMPTIONS 同步按名冻结为不可变最大基线(只许缩)**——现行 `auditFlagAccounts` 会接受字段齐全的新 exemption + 真实读点,这个旁路必须一并闭掉(Codex R2 #3);未来 invocation seam 走单独受约束的非产品 ledger。**阳性对照**(虚构新 env spec → RED)+ **两个阴性对照**(自贴 governance_gate → 仍 RED;假读点 + 字段全合法的新 exemption → 仍 RED)。
3. FLY-1981 集合守卫:**13 个 spec 名**registry 归零 + **post-count == 35** + 生产代码读点归零(grep 谓词,阳性对照);**五本账**分列(12 裁定 / 13 spec / 11 env 墓碑 / 2 config 路径 / 4 辅助 tuning env)。
4. `doc/engineer/implementation/flag-authoring-runbook.md`:「加 flag 的唯一姿势」(registry → STORE_MANAGED + codec → seeded row → store wrapper 读点 → management-route 测试 → 守卫绿);**FLAG_EXEMPTIONS 是按名冻结、只许缩的存量账,不接收任何新条目**;未来 invocation seam 走单独受约束的非产品 ledger。守卫报错文案指向此文件。
5. runbook 附「生产 .env 残值清理」单一顺序(research §5 七步:stage 新 artifact → updater 原子删 env → static preflight → **no-old-binary-restart 栅栏** → 部署新 Bridge → health/live preflight + 行为验证 → 回滚先恢复 env 再启旧 binary)。「代码 merged/staged」与「新进程已部署」两词全文区分使用。

## 2. 验收(全仓门,不许只跑 changed files)

- `pnpm lint`(biome 全仓)+ `pnpm -r build`(22 workspace)+ `pnpm test:packages:run` + 相关 `scripts/__tests__/*.test.sh`。
- 宿主已知例外(headless Terminal.app / 并发 timeout)逐项隔离复跑留证,不伪报整门全绿。
- 精确残留扫:**13 个 spec 名 + 11 条 env 名 + 2 个 config 顶层路径**在 packages/scripts 生产代码零命中(测试点名墓碑字符串除外);registry post-count == 35;**辅助退役账**(4 个非 flag tuning env:QA_RECONCILE_EVERY_N_TICKS + FOUNDER_MILESTONE_×3)单列断言零读点/零 allowlist/零写者;`lead_core_mention_gated` plumbing 面字节不变对照。
- codex 硬门测试迁移验收(Codex R1 #8):凡建模 code-PR 场景一律真 `recordCodexReviewApproved` 证据;`codex_skip` 仅限场景本就建模 sanctioned skip/no-code 合同;转换的测试家族清单入 PR body 供 review。
- Codex code review(codex:rescue,xhigh)循环至 APPROVED;三处 sentinel/合同 retarget(decision-mode / verify-approval live-toggle / vitest.setup pin)在 PR body 点名。
- 独立 QA(DAG qa 节点):529 房批准新驱动链真机腿(既有 `/api/actions/approve`,engine authority 与 awaiting_review 两形态各一)+ 防盗门/硬门恒在的对抗用例(试图 =0 绕门必须无效)。

## 3. 明确不做

- 存量 37 env flag 批量迁 store(FLY-1405 按批);merge 门与 RESERVED 两条;evaluator enforce 能力半径裁剪(仅删不可达分支);FLY-1977 重叠两条由该单缩范围,本单不动它的其余 4 条。

# FLY-1686 第五代采纳重核 — 采纳增补(design 节点交付)

Issue: FLY-1686 (https://linear.app/geoforge3d/issue/FLY-1686/bug阻塞级-流水线强制-progress-记账-1655-land-head-闸互斥-所有-schema-v2-code-run-的-qa)
日期: 2026-08-11
基于: plan.md(gen-3 governing plan,codex-approved 6 轮)+ research.md §12 + exploration.md §0

## 0. 一句话

gen-3 plan **原文不动、继续作为唯一 governing plan**;本文只做三件事:①把 doc 谱系移植到干净 main 谱系(gen-5);②按新基线(main `b0a095a8`)逐文件重核 plan 的代码锚点;③把 gen-3 定稿后到达的 Linear 更正逐条对账进设计。

## 1. 世代史(为什么会有 gen-5)

| 代 | 产物 | 结局 |
|---|------|------|
| gen-2 | reconcile/diff 对比路线(PR #807 实现,保全头 `cc6b041d`) | founder 原话整体否决(exploration.md §0);正文保全于 git 历史 |
| gen-3 | 绑定移到 terminal 直接前驱完成点(plan.md) | codex design review 6 轮 APPROVED,governing |
| gen-4 | 采纳过场 + codex 复核 R4 APPROVED(progress.md @ `2783c0a3`) | implement 起跑后 run 被 terminate(引擎停摆/重启波,与本单病同源的运维环境) |
| gen-5(本文) | 采纳重核 + 干净谱系 | run `2231a32c` design 节点;此前同 issue 4 个 run 全部 terminated(07:01 / 14:59 / 17:59 / 21:44Z) |

工程事实:gen-5 worktree 由引擎自 main tip `b0a095a8` 新建(本地分支 `flywheel-FLY-1686` 与 origin 分道);origin 分支头 `2783c0a3`(82 commits)= gen-2/3/4 完整谱系;PR #807 对 main **CONFLICTING**(gen-2 实现代码与 FLY-1655 redesign 后的 main 冲突)。

## 2. 基线重核(d6536134 → b0a095a8,7 个 merge)

方法:对 plan 触碰的 12 个文件逐一 `git diff d6536134..HEAD`(d6536134 = gen-3 设计基线,与 origin 分支 merge-base 一致)。

**结论:设计零失效,两处需要点名。**

- **10/12 文件逐字节相同**:`workflow-decision-routes.ts` / `land-executor.ts` / `event-route.ts` / `head-authority.ts` / `repository-authority.ts` / `materialized-head-authority.ts` / `workflow-docs-git.ts` / `Blueprint.ts` / `qa-result.ts` / `progress.ts`。plan 对它们的全部引用(含行号)照旧成立。
- **`StateStore.ts`:纯增量**(#805 TURN handoff durable + #812 retire/unbind):新增 `workflow_carrier_delivery` 账本 + carrier redrive / wake / turn-divergence 方法族;plan 修改的事务序列(`commitEnrolledCompletion` / `submitWorkflowDecisionByCredential` / `commitWorkflowTransitionTx` land 闸 / holder / carrier rebind / binding CTE / manifest seal)**无一 hunk 落入**,仅行号整体漂移(如 land 闸 `land_head_unavailable` 现在 :28357 区)。
  - ⚠️ **implement 集成注(唯一新交叉点)**:runner_ship 批准路径现在会 INSERT `workflow_carrier_delivery`(键含 `holder.source_execution_id` = carrier)。plan §3.2 的「binding 所有权与 carrier 解耦」实现时必须保住这条 carrier-delivery 关联不被孤儿化——解耦的是 **PR/head authority 的所有权**,carrier 作为 ship actor 的职责与账本原样(§3.2 原文语义本就如此,此处点名新表)。
- **`workflow-template.ts`:FLY-1693(#812)模板退役**:`workflowApprovalGate` 原样未动;bundled seed 机械(`loadBundledWorkflowSeeds` / `importBundledWorkflowSeeds` / `DEFAULT_BUNDLED_WORKFLOW_TEMPLATE_ID` 等)删除,新增 `RETIRED_BUNDLED_TEMPLATE_IDS` + `retireLegacyWorkflowTemplates`;`tpl_eng*` / `tpl_product_v1` / `tpl_generic` 等 12 个 YAML 物理删除。
  - plan 中 `tpl_eng.yaml:25-27,43`、`tpl_product_v1.yaml:38-45` 两处引用**降级为历史注**(结论不变:runner_ship 拓扑「decision 进 gate」的事实由引擎 authority_mode 机器承载,不依赖 YAML 存在);
  - T5b/T6 fixture 本就按 plan 要求用中性 node id;模板级 fixture 改用 **test-only 完整定义**——与 FLY-1693 定下的「历史兼容测试不偷读已删生产资产」惯例一致,零冲突;
  - runner_ship authority mode 仍在引擎(CHECK `'land'|'runner_ship'|'engine_terminal'`,`engine_terminal` 在 gen-3 基线已存在),§3.2 / T5b 继续成立。

## 3. Linear 晚间更正对账(gen-3 定稿后到达,2026-08-11 04:1x-04:3x PT)

| 更正 | 设计回答 |
|------|---------|
| FLY-1614 重新定性:拒因 = `land_head_unavailable`(第三处 head 检查,StateStore land 闸),QA 台账 commit 无 PR binding——非 PASS 物化链 bug 证据 | gen-3 结构性治愈同一形态:绑定移到进-gate 提交,T = attested QA HEAD,台账/报告 commit 被 T 自然吸收;闸本身零松动(T5a 显式断言未绑定 head 仍 `land_head_unavailable`) |
| 拒因必须回响应体/落审计(live 路丢 reason,烧掉两个 agent 几小时) | plan §3.1-2(completion 路 `detail.transitionReason` + 独立 durable refusal audit + event-route 409 透传)+ §3.6 精确 reason 词汇表——已含 |
| 「评估把 QA 判决锚定到 reviewed PR head 而非 runner live HEAD」 | gen-3 的回答是**更强形式**:锚定 attested 提交 head T **且要求 PR `headRefOid == T`**(A 型握手,§3.3)。纯 reviewed-PR-head 锚定会打开「判决时工作区版本 ≠ 被绑定版本」的窗口(QA 实际验的树与上线的树可以不同),不采 |
| QA 运营规则「land manifest 上发 PASS 时台账不骑 PR head」 | 过渡期规则;部署后废止(plan §3.9 原文已写) |
| PASS/FAIL 不对称(FAIL 可记录、PASS 才进物化链) | 与 plan §1 一致:FAIL/kickback 边不进 gate ⇒ 不绑定、零探针 |
| 鸡生蛋:本单自己的 QA 在旧 Bridge 上撞旧病 | plan §7 部署合同已含(verdict durable 在 marker + founder out-of-band 放行 + Lead 按 issue 临时手术);gen-5 无新增变化 |

另:同晚 Linear 线程中的 rework 激活 `worktree_not_ready` 两臂、`sessions` completed wedge、「原子写 6 处」合同等,plan §8 已显式划为**另族出界**(各归其单),gen-5 维持原判。

## 4. 净删除口径的 gen-5 重解释

gen-5 谱系起自干净 main:gen-2 的 reconcile 机器(`land-head-reconcile.ts` 等)**不在树上**(已核:absent)。

- plan §3.8「净删除」在 gen-5 语境 = **不移植**;gen-2 可复用件按 plan 指名从 git 历史单独取材(C1 凭据/push 分离、C2 marker 先行、严格 push-endpoint 解析器、admission preflight exact-replay 补写);
- plan §6.4 验收基线句(「以 gen-2 保全头 `cc6b041d` 为基线,gen-3 实现 delta 为净删除」)不再按字面适用;**T9 symbol-zero 守卫原样保留**(断言最终 tree 无 reconcile / diff-whitelist 符号——在 gen-5 中它是防重引入守卫);
- **谱系保全与分支处置**:origin 旧头 `2783c0a3` 先 push 到备份分支 `flywheel-FLY-1686-gen4-preserved`,随后 `flywheel-FLY-1686` 以 gen-5 谱系 force-with-lease 更新(保引擎分支名连续性);PR #807 因此自动变为 docs-only diff——关闭另开或原 PR 续用由 Lead 定,plan §7「gen-2 代码不合入」语义不变。

## 5. 本节点交付边界

本文 + 移植的 gen-2/3 doc 谱系 + 更新的 `design-gen3.html`(加 gen-5 采纳注)= design 节点全部交付。实施(含 §2 的 integration note)归 implement 节点;本节点不触碰 `packages/` 代码。

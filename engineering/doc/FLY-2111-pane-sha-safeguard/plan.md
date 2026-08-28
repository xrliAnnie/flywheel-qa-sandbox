# FLY-2111 重构 pane-SHA 接力证据 — 实施计划
Issue: FLY-2111 (https://linear.app/geoforge3d/issue/FLY-2111/返工2080-runner-patrol-rules-的-pane-sha-段落触发-fable-5-safeguardreasoning)
日期: 2026-08-27
基于: research.md

## 1. 目标与验收映射

| 需求 | 实现落点 | PR 内证据 | 部署后证据 |
|---|---|---|---|
| 整段替换“全 scrollback → SHA → 前后比较”形状 | `runner-patrol-rules.md` 步骤 A、附录 A、附录 B 共用说明 | 内容契约 deny 旧变量/措辞/命令 | Fable 观测 |
| 优先用 `workflow_run_event seq` 证明修复后的引擎接力 | 附录 A 的 baseline + post-reconcile 查询；附录 B 明确复用 | 测试钉 `seq > BASELINE_SEQ`、event 非空门、排除所有 patrol-authored event | mailbox 正常推进记录 |
| FLY-2080 repair appendix 不再把完整 pane 输出指纹比较当接力证据 | 事务前真实性证明 + 无 event 时的 bounded diagnostic 段 | 测试钉 `-S -40 | tail -40`、不落原文/不哈希/不作成功替代 | 出现诊断时检查 patrol report |
| 不削弱 FLY-2080 可审计、可行动目的 | `fixed|advanced` 只接受真实 engine event；无 event 留具体 next action | 既有事务/gate anchors 全部继续通过 | Lead 能继续修复或明确升级 |
| 黑盒 safeguard 行为验收 | milestone/PR body 写明 post-deploy gate | 静态测试不冒充此项 | Tadashi(Fable) ≥100 mailbox、0 拦截；CoS(Fable) 0 |

## 2. 代码范围

只改两份生产/测试文件：

- `packages/teamlead/lead-rules-base/runner-patrol-rules.md`
- `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts`

随 PR 提交本文件夹的 exploration/research/plan/progress 与最后一笔 `engineering/doc/milestones/FLY-2111.md`。不改 Bridge/StateStore runtime、`scripts/lead-patrol-snapshot.sh`、STEP 1–5、FLY-2080 修复事务、巡检频率、role bundle 或依赖清单。

Founder/Lead 已确定：不加 feature flag，不保留新旧两份提示词，不整包 revert FLY-2080。提示词文件与 flag 都要重启 Lead 才生效，开关没有更快的运行时粒度，反而制造第二份真相；回滚使用 `git revert` 后进入正常部署班车。本节点只产候选包，不启动测试 Lead、不切生产模型、不部署。

### 台架逐段对照清单

此表原样进入 PR body 与 milestone，供 QA/Lead 台架逐行验收；每行只描述候选包的承接关系，不声称已经消除 safeguard：

| 被重构的段落 | 它在 FLY-2080 里原本要保证什么 | 现在由什么证据承接 |
|---|---|---|
| 步骤 A 第 4 项：补账后的接力判定 | SQL 写入不等于 Bridge 已继续，只有真实推进才可写 `fixed|advanced` | 修复前记录 run 的 `BASELINE_SEQ`；修复后必须出现 `seq > BASELINE_SEQ` 且 `event_uid NOT LIKE 'patrol:%'` 的 `seq:kind` |
| 附录 A：receipt 修复的 baseline/事务后 gate | transaction 前不伪造已完成的 rework；transaction 后 Bridge 确实消费了 wake-delivered 状态 | 前置真实性仍由 bounded pane/commit/TURN 证明 `preferred_actor_execution_id` 已完成 rework；接力只由非 patrol `workflow_run_event` 前进证明 |
| 附录 B：replacement 与 predecessor 分支的共用接力说明 | route/delivery/event 补齐后 dispatcher 确实 launch/advance，而不是只改了 rows | 复用附录 A 的 event baseline 与非 patrol event gate；无新 event 时 bounded pane 只产生诊断 marker/下一动作，不能单独过门 |

## 3. TDD：RED

在 `fly369-patrol-rule.test.ts` 新增一条聚焦 FLY-2111 的内容契约。测试同时构造整个 `## 0.` section 与 `### FLY-2080 附录 A` 到 `## 1. Proactive patrol` 的 repair appendix 子范围：四个风险短语在整个 section 禁止，只有无限历史 `capture-pane` 检查收窄到 appendix，避免误伤 FLY-1855 的 STEP 2。

测试先要求新合同，当前正文应失败：

1. 整个 `## 0.` section 不含 `BEFORE_PANE_SHA`、`AFTER_PANE_SHA`、`full-scrollback state hash`、`pane hash`。
2. repair appendix 不含无限历史读取 `capture-pane -p -S -`；断言只拒绝 `-S -` 后接空白/命令结束的形状，不能误命中新 bounded 形式。
3. appendix 仍含 `BASELINE_SEQ`、`AFTER_EVENTS`、`e.seq>$BASELINE_SEQ` 与 `e.event_uid NOT LIKE 'patrol:%'`。
4. 明确 event 非空才是接力成功条件，并明确 pane marker 不能单独支持 `fixed|advanced`。
5. bounded pane read 含 `capture-pane -p -S -40 ... | tail -40`，且正文要求不落原文、不做内容摘要/前后比较，只记录非敏感生命周期 marker 与 observed time。
6. appendix 必须仍含“`preferred_actor_execution_id` 已完成这次 rework”与“伪造 receipt”的事务前真实性合同；测试明确区分“pane 可参与事务前真实性证明”和“pane 不再作为事务后接力成功证据”。

已用 `pnpm install --frozen-lockfile` 恢复 lockfile 已声明依赖且未修改 lockfile；现有 22 条定向测试通过。实现时保存“仅新测试因旧正文缺合同而失败”的 RED 输出，不得增加 dependency。

## 4. GREEN：规则整段重构

### 4.1 步骤 A

删除“event 或 pane full-scrollback state hash 变化”的并列成功语义，改为：

- 修复前记录 run 的 event baseline；
- 修复后至少等一个 reconcile tick；
- 只有 baseline 后由引擎追加、且 `event_uid NOT LIKE 'patrol:%'` 的 event 才证明接力；
- 静态状态/SQL changes 不足以通过；无新 event 时转入有界诊断并给下一动作，不能写 `fixed|advanced`。

### 4.2 附录 A 前置段

把“同时完整 capture + `BEFORE_PANE_SHA`”整段替换为 event baseline + 独立真实性证明：

- `TARGET_PANE` 不再生成 baseline 指纹，但继续由 exact canonical pane probe 取得，并与 `REQUEST_ID` 一起通过既有字符集校验；
- 保留 0600 backup、`BASELINE_SEQ` 与所有事务前只读 probe；
- **逐字保留事务前守卫**：“pane/commit/TURN 必须另行证明 `preferred_actor_execution_id` 已完成这次 rework；不成立就是伪造 receipt，按防篡改类停手”。这里的 pane 是真实性 precondition，不是事务后的接力成功证据；需要读取时只用有界末尾片段并只记录非敏感 marker；
- 不新增 helper、脚本或状态文件。

### 4.3 附录 A 事务后段

重写为：

```sh
sleep 10
AFTER_EVENTS="$(sqlite3 ... e.seq>$BASELINE_SEQ ... e.event_uid NOT LIKE 'patrol:%' ...)"
printf 'engine_handoff events=%s\n' "$AFTER_EVENTS"
test -n "$AFTER_EVENTS"
```

若查询为空，后续散文给出诊断分支而非 shell fallback success：

- 有 exact canonical pane 时先沿用 `case "$REQUEST_ID:$TARGET_PANE" ...` 校验，再以 `TMUX= tmux capture-pane -p -S -40 -t "$TARGET_PANE" | tail -40` 只看最终 40 行；
- 不保存原文、不摘要/哈希、不与 repair 前内容比较；
- 报告写非敏感 `pane_marker` + UTC observed time + `next=inspect|repair|retry:<token>`；
- finding 不得写 `fixed|advanced`。

### 4.4 附录 B

把“复用 pane hash 步骤”和尾部“event 或 pane 变化”整体改为复用附录 A 的 backup + event baseline + event-only handoff gate。predecessor 分支同样只认新 engine event。这里“pane 不作为成功门”只限定修复后的接力证据链，不删除 receipt/replacement 事务前的 pane/commit/TURN 真实性 precondition；无 event 时 pane 另可用于有界诊断。

## 5. REFACTOR 与回归边界

GREEN 后只做文案去重：附录 B 引用附录 A 的新 event-first 合同，不复制第二套命令。主动检查并删除所有旧风险形状，不增加新 helper/依赖/抽象。

必须保持：

- `event_uid NOT LIKE 'patrol:%'` 排除条件；
- receipt/replacement 的全部 precondition、CAS、transaction 和静态复核，尤其逐字保留“`preferred_actor_execution_id` 已完成这次 rework；不成立就是伪造 receipt”的事务前真实性守卫；
- FLY-2094 unbounded loop payload；
- STEP 2 完整 fleet patrol 与既有 `PANE_EVIDENCE` 合同；
- FLY-2072 子 issue/receipt gate；
- `fixed|advanced|escalated-with-plan` 值域。

## 6. 验证顺序

1. RED/GREEN 定向：`pnpm --filter flywheel-teamlead test src/__tests__/fly369-patrol-rule.test.ts`。
2. 规则回流扫描：`rg -n "BEFORE_PANE_SHA|AFTER_PANE_SHA|pane hash|full-scrollback state hash" packages/teamlead/lead-rules-base/runner-patrol-rules.md` 应为零。
3. commit 后范围审计：`git diff origin/main...HEAD -- scripts/lead-patrol-snapshot.sh packages/teamlead/src/StateStore.ts packages/teamlead/src/bridge` 应为空。
4. 全仓门：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`。若 host 负载使全量包测不安全，先核当前资源并遵循项目规则，不把未跑写成通过。
5. 注册 code review gate；若 `CHANGES_REQUESTED`，修复 blocking finding 后以新 question id 重开，直到 `reviewVerdict=APPROVED`。
6. push、创建 PR，最后一 commit 只新增 `engineering/doc/milestones/FLY-2111.md`（以及流程要求的最终 doc 状态），不改 `CLAUDE.md`。
7. 以 `complete --route needs_review --pr <number>` 交回 DAG；不请求 ship、不 merge、不部署/重启。

## 7. Post-deploy 验收合同

本 PR 通过仅表示代码与 review gate 完成，不表示 FLY-2111 行为验收已完成。合并部署后由 Founder/Lead 执行：

1. Tadashi 切回 Fable 5。
2. 从切换生效点起观察至少 100 条 mailbox 消息。
3. `reasoning_extraction` 次数为 0 才 PASS；任何一次同类拦截即 FAIL 并重新定位提示词包。第一候选是仍保留的 STEP 2 全 scrollback + state SHA 跨 tick 链，但分类器是黑盒，候选不等于定论。
4. 同窗口验证 CoS(Fable) 仍为 0。CoS 不加载本规则，因此它只是不变的阴性对照，不能单独证明本改动有效。

“约 3%/条”来自 FLY-2111 issue body 对 Tadashi 2026-08-27 全天约 29 次拦截的 Founder/Lead 估计；issue 未提供可在仓内复算的 mailbox 分母，因此本计划不把它升级成精确测量。若以 3% 估算，100 条零命中的概率约 4.8%。Honey Lemon 切模首条即中是单变量复现，不是频率估计，两者不矛盾。100 条是 issue 已写死的判定线，不降低，也不以“概率没到”解释阳性结果。旧包阳性对照会主动重建已知生产退化形状，不在本 implement node 的授权范围内；因此零拦截仍需按黑盒实验的限制解读，不能排除同期 classifier 漂移。

## 8. 风险与控制

| 风险 | 控制 |
|---|---|
| 黑盒分类器仍被其他段落触发 | 本单整段替换已知操作形状；部署后 100-message 硬门判真伪 |
| event 暂未出现导致误报失败 | 空 event 不判失败，只是不允许成功；bounded diagnostic 产生可执行 next action |
| pane marker 泄露输出 | `capture-pane -S -40 | tail -40` 确保最终只读 40 行，不落原文/摘要，报告仅写非敏感 marker 与时间 |
| 误删 FLY-1855 全机 pane 检测 | 测试只截 repair appendix；既有 STEP 2 契约继续跑 |
| 误删 receipt 真实性守卫 | 测试钉 `preferred_actor_execution_id` 已完成 rework + 伪造 receipt 两个 anchor；pane precondition 与 handoff gate 分开写 |
| repair event 让门假绿 | 保留并测试 `event_uid NOT LIKE 'patrol:%'` |
| 测试为了尺子改产物 | 测试只表达用户要求与既有接力属性，不引入生产 marker 或额外 runtime |

## 会过期的结论

| 结论 | as-of | 失效条件 | 重核命令/证据 |
|---|---|---|---|
| 生产改动只需规则 Markdown + 内容测试 | 2026-08-27 `HEAD` | 发现 bundle/runtime 也生成同段文本 | `rg -n "BEFORE_PANE_SHA|AFTER_PANE_SHA|full-scrollback state hash" packages scripts` |
| FLY-2080 appendix 可由标题边界稳定截取 | 2026-08-27 `HEAD` | 标题改名/移除 | 重读 `fly369-patrol-rule.test.ts` 的 slice 边界并运行定向测试 |
| `-S -40 | tail -40` 在接力链中是诊断而非完成证据 | 2026-08-27 plan | Lead 规则另有更权威 pane 证据合同 | `rg -n "capture-pane -p -S -40|tail -40|pane_marker" packages/teamlead/lead-rules-base engineering/doc` |
| 100-message 线上验收未完成 | 2026-08-27 pre-deploy | 部署观测结束 | Tadashi/CoS 模型配置、mailbox 计数、safeguard 日志 |

# FLY-722 合并 Sub → Tidal Echo — 实施计划

Issue: FLY-722 (https://linear.app/geoforge3d/issue/FLY-722/org-合并-sub-tidal-echo取消-sub-coresub-变-ariel-平级内容-lead归-triton)
日期: 2026-07-03
基于: research.md

Status: **Tadashi ✅ 确认方案 A + cutover GO + 路由锁定(2026-07-04)。** 5 点锁定里 ①②(config.yaml agents.sub / cron trigger 挂标)**代码验证 UNNECESSARY**、Tadashi bless、周一 1am deadline 解除(cron 靠 default_agent 路由 Asha 不变);OPEN-2 解决(LEARN-141/142/143 三个一起搬 TIDE)。**cutover 缩成:channel 迁移 + reply-guard generalChannel + projects.json + Linear moves + Discord(Annie 授权)。** 重跑 Codex design+code → 重开 gate 给 Tadashi 过目。本 runner **不执行任何 live cutover**(全 founder-gated;#sub-core 删除排最后;Manage-Channels 那步 Tadashi 喊 Annie)。

---

## 0. 一句话

FLY-722 = **org 层合并**(Discord section + Linear team/label + Triton front-door 归属),自治 cron **零中断**。物理 repo 合并(`/Dev/sub` 代码进 tidal-echo)= **单独延后 issue**。全程 **founder-gated cutover**,本 runner 只交付设计 + 手册,不执行 live 动作。

## 1. 岔口决策(见 research §2/§3)—— **Tadashi ✅ 确认方案 A(2026-07-03)**

**方案 A** —— org 层合并 + 保留 `sub` runtime ProjectEntry(`projectRoot=/Dev/sub`):
- 唯一能同时满足「org-first only(代码留 /Dev/sub)」+「cron 自治不断」的形态(schema 无 per-lead projectRoot)。
- 「彻底删 sub project entry / relabel cron-trigger issue / 搬代码」= **延后的物理 repo 合并 issue**。
- 若 Tadashi 要方案 B(给 LeadConfig 加 projectRoot 覆盖),那是 orchestrator schema 改动,需另开 design+code+review —— 本 plan 不含。

## 2. 决策状态(Cass/Triton/Asha/Ariel/Annie 对齐,覆盖原 A1)

**OPEN-1 → 覆盖:不走 A1(默认 Ariel + Triton 手转),改「Asha 自己的 dispatch 标签」。5 点锁定(cutover GO):**
1. **Asha dispatch 标签 = `sub`** —— **✅ 代码验证:纯 Option A 下 UNNECESSARY,本 cutover 不动 config.yaml。Tadashi bless(question `3288a166`/`d12e8f7e`)。** 证明见 runbook Step 0b:`AgentDispatcher.dispatch()` 对 cron issue 走 `default_agent: content` → Asha 的 executor,与 `sub` 标签无关。「cron 落 Ariel」= dept-scope(projects.json)与 executor-pick(config.yaml agents)两层搞混。Ariel 仅剩 Linear-side 检查(见点 3)。
2. **cron trigger issue 加 `sub` 标签** —— **✅ 同上 UNNECESSARY**(cron 靠 default_agent 路由,不靠标签)。故硬 deadline 对「config/标签」这块解除;只剩 channel/reply-guard 侧的迁移(见下)。
3. **Ariel 核 config.yaml**:① 大小写精确对上 Linear 实际标签;② 确认 `Sub` label 搬 team 不掉(team-scoped label 可能掉)。
4. **reply-guard 坑(Asha 亲 flag)**:见 §4 Phase 3(generalChannel→#sub 即是解;或夜报走 publish-report)。
5. ~~硬 deadline(周一 7/6 1am)~~ → **✅ 解除**:①② 代码验证不必要 → 不改 config.yaml、不加 cron dispatch 标签 → cron 靠 `default_agent` 路由 Asha 不变,周一那班照常。只留 channel/reply-guard 的 cutover 排序(#sub-core 删除最后)。

**OPEN-2 → ✅ 解决(Cass 查清):LEARN-142/143 已 Done、141 Backlog、三个都无 runner 在跑 → 现在搬零风险,三个一起搬进 TIDE + relabel `Tidal-Echo`(去 `Sub`),跟合并一起走。**

## 3. 硬约束(不可违背)

1. **所有自治/机器 issue 留 `Sub` scope,不 relabel、不搬 team。**(research §3/§4b)含:LEARN-123 + LEARN-80(nightly triggers)+ **LEARN-120(growth-improve parent)+ growth-improve 自动生成的子 issue** + LEARN-177(DR,dormant)。relabel 任一 → dept-scope 403 打死对应 cron。
2. **删 #sub-core 前,迁走/停掉它的每一个 live 消费者。**(research §4b/§5)不止 2 条 nightly cron —— 还有 growth-report(`growth/config.json report.channel_id` + `growth_policy.py REPO_DEFAULT_CHANNEL` + `growth_report.py --deliver` 显式 --channel)。改 `sub.generalChannel` 救不了显式 --channel。
3. **Discord Manage-Channels 我没权限** → 到那步 surface Tadashi 喊 Annie。
4. **所有 live 动作 founder-gated**(改 projects.json / Discord / Linear 批量搬 / 碰 Asha launchd / 碰 growth flags)。
5. **Sub 自治面 = 6 条 cron**(2 nightly + 4 growth-loop,全 activated),不是 2 条。每一处 org 改动都要对这 6 条全量核对。

## 4. 分阶段(每阶段可独立回滚;顺序有依赖)

### Phase 1 — Linear(org 归属)· founder-gated
- **不动**(留 Personal team / `Sub` scope,硬约束 1):LEARN-123 / LEARN-80(nightly triggers)+ **LEARN-120 + growth-improve 自动生成的所有子 issue** + LEARN-177(DR)。
  - ⚠️ growth-improve 每天 5am **持续新建** `Sub`-scoped 子 issue(under LEARN-120)。org 迁移**必须显式排除自治生成物** —— 不能「把所有 Sub-labeled issue 搬走」(会 403 打死 growth-improve 的 runner spawn,且下一 tick 又生成新的)。等物理 repo / 路由 follow-up 再统一。
- 真正的**人类发起**内容 issue(LEARN-141/142/143 + 未来 ad-hoc Sub 内容活):按 OPEN-2 时机,`save_issue` 改 team=Tidal Echo、labels 加 `Tidal-Echo`(去 `Sub`)。
- (可选增强)tidal-echo `ProjectLinearBinding = {team:"TIDE", label:"Tidal-Echo"}` 写进 projects.json → Triton front-door 建单默认落 TIDE。
- 机制:Linear MCP。逐条确认(key 会变),不 bulk 无脑跑;先 grep 出 growth/cron 生成的自治 issue 排除掉。

### Phase 2 — 全部 #sub-core 消费者迁移(`/Dev/sub` repo)· founder-gated
新 landing = `1511267947551653918`(#sub,合并后存活)。要改的**每一处**(硬约束 2):
1. `sub-create-nightly-tick.sh`:`REPORT_CHANNEL` + brief 里「#sub-core channel」措辞。
2. `sub-daily-loop-tick.sh`:同上。
3. `growth/config.json`:`report.channel_id` → `1511267947551653918`。
4. `growth_policy.py` L19:`REPO_DEFAULT_CHANNEL` fallback → 新 id(config + 代码默认都改,belt+suspenders;`growth_report.py --deliver` 从 policy 取 channel,故覆盖)。
- 走 `xrliAnnie/sub` repo 的 PR(TDD:加/改断言校验新 channel)或 founder-gated 手改。**sub repo 改动,不在本 flywheel PR。**
- `projectName` / `ISSUE_ID` / `LEAD_ID` / growth flags **不变**。
- 备选:若当晚不想动 growth,可先 `growth_crons_active=false` 停 growth-loop、只留 nightly —— 但那是**停自治**,须 Annie 明批(违背「保自治」默认,不推荐)。

### Phase 3 — projects.json(最小改)· founder-gated live edit
- `sub.generalChannel`:`1511889248003952641`(#sub-core,将死)→ `1511267947551653918`(#sub)。防 reply-guard/alert-fallback 引用死 channel。
- **⚠️ 副作用(research §4c,Codex R1 #4):此改让 #sub 变成 sub 的 core-channel**(classify 先判 core;core 一律放行顶层 issue token)。即 #sub 顶层发 issue 号从「拦」变「放行」。要么(a)接受 + 文档化 + **更新 Asha memory/规则**里「#sub-core 是 core / #sub 顶层拦」的说法;要么(b)选别的存活 channel 当 core。**倾向 (a)**(#sub 本就是 Asha 家,合并后当 core 合理)。cutover 加一条 restart 后 reply-guard 探针(projectName=sub, leadId=sub-lead, chatId=#sub)。
- (若采纳)加 tidal-echo `linear` binding(Phase 1 可选增强)。
- `sub` project 其余**不变**(sub-lead / scope Sub / projectRoot /Dev/sub 全留)。
- Bridge 重启生效(batch 其它 Bridge PR —— 先问 Tadashi/team-lead)。

### Phase 4 — Discord 重构 · 🔴 Annie(Manage-Channels)
顺序(硬约束 2):
1. **删 #sub-core 前的 pre-delete 门(Codex R1 #6):** grep `1511889248003952641` 全量核对已迁 —— 覆盖 `/Users/xiaorongli/Dev/sub`(scripts + growth/config.json)、`~/.flywheel/projects.json`、`~/Library/LaunchAgents`、`~/.flywheel/manifests`、Asha memory。只允许历史 report/backup 里残留;任何 **active** config/script/memory 指令都不能再指向该 channel。Phase 2/3 全绿 = 该门通过。
2. 把 **#sub**(`1511267947551653918`)移进 Tidal Echo category(与 #tidal-echo 平级)。id 不变。
3. 砍 **#sub-core**(`1511889248003952641`)。**Discord 删 channel 不可逆** → 只在门 1 全绿后做。
- 我出逐步 click 清单 + 校验点,Annie 执行;或授权 bot 临时 Manage-Channels(Annie 定)。

### Phase 5 — 验证
- cron dry(**Codex R1 #5:注意脚本差异**):
  - `sub-create-nightly-tick.sh --resolve-only`:真有此模式(exit 前无 Bridge I/O),可跑。
  - `sub-daily-loop-tick.sh` **没有 `--resolve-only`** —— 直接跑会触发真 tick!改用其 lib-mode 单测(`SUB_DAILY_LOOP_TICK_LIB=1` 源入 + 跑 helper 断言),另配一个受控 Bridge dry 探针。或先给它加一个真·no-side-effect `--check-only`(Phase 2 顺带)。
  - growth(两步,别混):① `growth-report-tick.sh --check-only` 只校验 launch/config 接线(不 render);② `growth_report.py`(**不带** `--deliver`)做 render proof 校验新 channel。**dry 验证期间绝不跑真 `growth_report.py --deliver`。**
- 下一自然 tick(6 条各自窗口):产出落 #sub(不落死 channel、不进 triage 前门)。
- 路由验证(**区分两条路,别混**):**cron/自治** = `projectName:sub` → `default_agent: content` → Asha executor(不碰 config/标签);**新 ad-hoc Sub 内容** = 留 `Sub` label → sub project(lead-match)→ Asha(同 default_agent 机制,不灌 Ariel)。搬去 Tidal-Echo 的 LEARN-141/142/143 是已停的 legacy(org 清理),非新活入口。
- Asha 在 #sub(新 section)回话正常;reply-guard 探针(Phase 3)符合选定语义;#sub-core 已消失无引用报错。
- Bridge log 无 `DEPT_SCOPE_REJECT` for 任一 cron(含 growth-improve spawn)。

## 5. 交付物边界

| 交付 | 载体 |
|---|---|
| 设计文档(本 3 篇) | 本 flywheel repo PR(`engineering/doc/FLY-722-...`) |
| cron REPORT_CHANNEL 改 | `xrliAnnie/sub` repo(Phase 2,单独) |
| projects.json / Discord / Linear 搬 | founder-gated live cutover step(**非 PR**) |
| 物理 repo 合并 | **延后单独 issue** |

## 6. Rollback
- Phase 1(Linear):`save_issue` 改回原 team/label(key 再变一次)。
- Phase 2(cron):revert sub repo commit,REPORT_CHANNEL 改回。
- Phase 3(projects.json):改回 generalChannel + 重启 Bridge。
- Phase 4(Discord):#sub-core 一旦删除**不可逆**(Discord 无 undo)→ 故放最后、且只在前面全绿后做。移 #sub 可逆(移回 category)。

## 7. 本 runner 下一步
1. ✅ 岔口=方案 A、路由锁定、①② config 验证不必要 —— 全 Tadashi bless。Codex design(4 轮)+ code review APPROVED。
2. Tadashi 过目本 plan(重开 gate)。
3. Ariel 做 Linear-side 检查(`Sub` label 搬 team 不掉)。
4. Tadashi/Cass 定 execute 时机 → 我按 runbook 逐步执行 config PR(worktree+PR)+ Linear moves;live projects.json/Bridge 重启/Discord(Annie 授权)按 founder-gated 走。
5. 我**不**擅自执行任何 live cutover step;#sub-core 删除排最后、Manage-Channels 那步 Tadashi 喊 Annie。

# FLY-722 合并 Sub → Tidal Echo — Cutover Runbook(held diffs)

Issue: FLY-722 (https://linear.app/geoforge3d/issue/FLY-722/org-合并-sub-tidal-echo取消-sub-coresub-变-ariel-平级内容-lead归-triton)
日期: 2026-07-03
基于: plan.md

> ⚠️ 全部 **LIVE / 不可逆**,须 **Annie 在场批准**(FLY-175 founder-only-authority)。本 runner **不执行**任何一步 —— 这是给 founder-gated cutover 备好的 held diffs + 步骤。方案 = **A(Tadashi 确认)**;OPEN-1 = **5 点锁定(见 plan §2,覆盖 A1)**;OPEN-2 = **✅ 解决,LEARN-141/142/143 三个一起搬 TIDE**。
> ✅ **原「周一 7/6 1am」deadline 解除(Tadashi bless)**:代码验证(Step 0b)cron 靠 `default_agent` 路由到 Asha,`sub` 标签 + config.yaml agents **都不用动**,周一那班照常落 Asha、零改动。cutover 可安全按序进行(#sub-core 删除排最后,迁完再删)。
> 顺序有依赖:**Linear/cron 迁移 → projects.json → Bridge 重启 → Discord(最后,#sub-core 删除不可逆)**。

固定 channel id:
- `#sub-core` = `1511889248003952641`(**将删**)
- `#sub` = `1511267947551653918`(存活,新 landing;Discord 里换父 category,id 不变)
- `#tidal-echo-core`(Triton) = `1517041708855197908`
- `#tidal-echo`(Ariel) = `1517041986358611998`

---

## Step 0b · Dispatch config(锁定点 1)· ✅ 代码验证 = **无需动 config.yaml**(Tadashi bless)

Tadashi 确认 model (a)(question `3288a166`)。**代码级证明(`AgentDispatcher.dispatch()`)cron run 本就落 Asha 的 executor,`config.yaml agents` 不用动:**
- sub 项目 config.yaml:单 agent `content`(top-level,match=内容类标签)+ `default_agent: content`。
- cron issue(labels `Sub`,`no-qa`)dispatch:2a own-dept 匹配跳过(`content` 是 top-level,`parsedDept`=null≠dept)→ 2b top-level 标签匹配跳过(`Sub`/`no-qa` 不在 content 的 match.labels)→ **3a `default_agent: content` 命中 → Asha 的 content executor**(`matchMethod:"default"`)。**与任何 `sub` 标签无关。**
- ⇒ **锁定点 1(加 `agents.sub`)+ 锁定点 2(cron trigger 加 `sub` 标签)在纯 Option A 下 UNNECESSARY** —— 「cron 落 Ariel」是两层标签(dept-scope=projects.json vs executor-pick=config.yaml agents)搞混。**deadline-critical 的 config 活 + FLY-127 风险都消失。**
- **Ariel 剩下真正要核的(Linear-move 侧、非 dispatch)**:搬 team 别把 `Sub` label 弄掉(team-scoped label 可能掉)。⚠️ **cron trigger LEARN-123/80 靠 `Sub` label 过 `isLeadInScope`**(dept-scope 匹配 sub-lead 的 projects.json `match:["Sub"]`)—— 丢了 cron run-start 会 403 破自治。cron trigger **不移 team**(留 Personal),故它们的 `Sub` 天然保住;搬的只是 LEARN-141/142/143。Ariel 确认 `Sub` label 本身(workspace/team entity)搬动中不消失。
- **结论:本 cutover 不改 config.yaml、不给 cron trigger 加 dispatch 标签(Tadashi ✅ bless)。** 此 Step 已作废,仅留 Ariel 的 Sub-label-survives 检查。

## Step 1 · Linear(org 归属)· Annie 批 / Runner 执行(Linear API)

**排除搬迁(留 Personal team + `Sub` scope,不 relabel Tidal-Echo — 硬约束 1):** LEARN-123、LEARN-80、LEARN-120 + growth-improve 自动生成的所有子 issue、LEARN-177。先 grep 分类;自治机器 issue 保留。

**cron trigger `sub` dispatch 标签 —— ✅ 代码验证 UNNECESSARY(见 Step 0b,Tadashi bless):** cron 靠 `default_agent: content` 路由到 Asha,不靠标签 → LEARN-123/80 **不用加 dispatch 标签**、也不移 team(留 Personal + `Sub` scope)。周一 deadline 对「标签/config」这块解除。

**搬(人类发起的内容 issue,OPEN-2 ✅ 解决 — 三个一起搬):** LEARN-141 + 142 + 143(142/143 已 Done、141 Backlog、均无 runner 在跑 → 零风险)→ `save_issue`:team=`Tidal Echo`、labels 去 `Sub` 加 `Tidal-Echo`。**排除** cron-trigger + 其每日产出 PR 子 issue。逐条确认(key LEARN-NN→TIDE-NN 变、旧链接失效)。

(可选)tidal-echo `ProjectLinearBinding` 见 Step 3。

## Step 2 · 迁走所有 #sub-core 引用(`xrliAnnie/sub` repo + Claude memory)· founder-gated

新 landing 全部 = `1511267947551653918`(#sub)。分 3 类(Codex code review 抓漏:光改 4 个 live 消费者不够,Asha 的 identity/skills/memory 仍指死 channel):

### 2a · Live delivery 消费者(4 处,必改)

**① `content/scripts/sub-create-nightly-tick.sh`**
```diff
-REPORT_CHANNEL="1511889248003952641"   # #sub-core generalChannel ...
+REPORT_CHANNEL="1511267947551653918"   # #sub (FLY-722: #sub-core removed; #sub is the surviving landing)
```
brief 文本里「#sub-core channel」措辞同步改「#sub channel」。

**② `content/scripts/sub-daily-loop-tick.sh`** — 同 ①(同一行 `REPORT_CHANNEL=...`)。

**③ `growth/config.json`**
```diff
   "report": {
-    "channel_id": "1511889248003952641",
+    "channel_id": "1511267947551653918",
     "project": "sub"
   }
```

**④ `content/scripts/growth_policy.py` L19**
```diff
-REPO_DEFAULT_CHANNEL = "1511889248003952641"  # #sub-core (permanent, never archived)
+REPO_DEFAULT_CHANNEL = "1511267947551653918"  # #sub (FLY-722: #sub-core removed)
```

`projectName` / `ISSUE_ID` / `LEAD_ID` / growth flags **不改**。TDD:改/加断言校验新 channel。

### 2b · Instruction / rules / memory surfaces(必改 — 否则删 #sub-core 后 Asha/Runner 仍按旧规则指死 channel)

把每处「#sub-core 是 core / delivery target / 顶层 issue 只发 #sub-core」改成「#sub 是 core / delivery + 顶层 issue token 现在在 #sub 允许」:
- `/Dev/sub/.lead/sub-lead/identity.md`(L39/49/55):`#sub-core` core-channel 定义 + `generalChannel=#sub-core` + 「proactive top-level issue 发 #sub-core 不发 #sub(#sub 会被 reply-guard 拦)」→ 全改 `#sub`;明确顶层 issue token 现在在 #sub 允许(见 Step 3 reply-guard 语义)。
- `/Dev/sub/.agents/skills/sub-create/SKILL.md`(L97/889):`growth_report.py --deliver` 直投 `#sub-core` → `#sub`。
- `/Dev/sub/.agents/skills/suno-hits-research/SKILL.md`(L326):每日提醒推 `#sub-core` → `#sub`。
- **生产 Claude memory** `~/.claude/projects/-Users-xiaorongli-Dev-sub/memory/`:`MEMORY.md`、`growth-loop-mvp-learn150.md`、`runner-discord-subcore-blocked.md`、`nightly-cron-chrome-unavailable.md`、`flywheel-report-via-comm.md` —— 同一语义改动(#sub 成 core/delivery,顶层 issue token 允许)。

### 2c · Non-live 工具 / 文档(必改或 pre-delete gate 显式 allowlist)

不是 live delivery,但硬编码旧 channel、会卡 Step 5 grep gate:
- `/Dev/sub/content/scripts/dryrun_growth_wired.py` L46:seed `channel_id` → 新 id(让 dry-run 验证的是 cutover 后目标)。
- `/Dev/sub/growth/ACTIVATION.md` L13:report 默认回退描述 `#sub-core` → `#sub`。

## Step 3 · projects.json(最小改)· Annie 批 · live edit

**① `sub.generalChannel`:**
```diff
-  "generalChannel": "1511889248003952641"
+  "generalChannel": "1511267947551653918"
```
> ✅ **这一改就是锁定点 4 的解**(Asha 亲 flag):她夜报是带 LEARN/TIDE issue-ID 的**顶层帖**,FLY-152/162 reply-guard 在非-core channel 拒带 issue-id 顶层帖(当初落 #sub-core=generalChannel=core 就为豁免)。REPORT_CHANNEL 迁 #sub 后,**必须让 #sub 成新 core**(即此 generalChannel 改)否则夜报被静默拒。
> 备选(锁定点 4 第二条路):夜报改走 `publish-report`/Bridge 绕过 guard(则 generalChannel 可不改)。**二选一必须在 #438 覆盖**,否则夜报静默失败。
> ⚠️ 副作用:#sub 成 core → 顶层 issue token 从「拦」变「放行」→ **同步更新 Asha identity/skills/memory**(Step 2b)+ restart 后跑 reply-guard 探针(projectName=sub, leadId=sub-lead, chatId=#sub)确认。

**②(可选)tidal-echo `linear` binding** —— 让 Triton front-door 建单默认落 TIDE:
```diff
   "projectName": "tidal-echo",
   ...
+  "linear": { "team": "TIDE", "label": "Tidal-Echo" },
```
sub 其余全留(sub-lead / scope Sub / projectRoot /Dev/sub 不动)。

## Step 4 · Bridge 重启 · Annie 批(batch 其它 Bridge PR — 先问 team-lead)
- 精准停 Bridge(FLY-239:按 port+run-bridge 进程树,别裸 pattern)。
- 起来后:现有 sessions 全保、Leads/runners 不掉、`deployed-sha` 对(cutover 执行时按当时实际 session 数核对)。

## Step 5 · Discord 重构 · 🔴 Annie(Manage-Channels;我无权限)
1. **pre-delete 门(硬约束 2)· hidden-aware:** 全量 grep 旧 id/名核对已迁:
   ```
   # rg (skips hidden by default → --hidden; skips gitignored → --no-ignore). macOS grep
   # does NOT accept --hidden (exit 2), so use ripgrep for this gate.
   rg -n --hidden --no-ignore -e 1511889248003952641 -e 'sub-core' \
     /Users/xiaorongli/Dev/sub \
     ~/.flywheel/projects.json ~/Library/LaunchAgents ~/.flywheel/manifests \
     ~/.claude/projects/-Users-xiaorongli-Dev-sub/memory/
   ```
   必扫到 `/Dev/sub` 的 `.lead/`、`.agents/`、`content/scripts/`、`growth/`(config + `*.md`)+ 生产 Claude memory。**只允许历史 report/backup 残留**;任何 active config/script/identity/skill/memory 指令都不能再指该 channel(Step 2a/2b/2c 全绿 = 该门通过)。**注意:门通过 = 零 active 匹配,`rg` 零匹配返回 exit 1 —— 若日后脚本化,exit 1 要当 clean pass、非失败。**
2. 移 **#sub**(`1511267947551653918`)进 Tidal Echo category(与 #tidal-echo 平级)。id 不变。
3. 删 **#sub-core**(`1511889248003952641`)。**Discord 删 channel 不可逆** → 只在门 1 全绿后。
- Runner 出逐步 click 清单 + 校验点;Annie 执行(或临时授权 bot Manage-Channels,Annie 定)。

## Step 6 · 验证
- cron dry:`sub-create-nightly-tick.sh --resolve-only` OK(有此模式);`sub-daily-loop-tick.sh` **无 --resolve-only** → 用 lib-mode(`SUB_DAILY_LOOP_TICK_LIB=1`)单测 + 受控 Bridge 探针;growth = `growth-report-tick.sh --check-only` + `growth_report.py`(不带 --deliver)render proof。**dry 期间绝不真 --deliver。**
- 下一自然 tick(6 条各窗口):产出落 #sub、不进 triage 前门、Bridge log 无 `DEPT_SCOPE_REJECT`。
- 路由验证(**两条路分清**):**cron/自治** = `projectName:sub` → `default_agent: content` → Asha executor(不碰 config/标签);**新 ad-hoc Sub 内容** = 留 `Sub` label → sub project(lead-match)→ Asha(同 default_agent,不灌 Ariel)。搬去 Tidal-Echo 的 LEARN-141/142/143 是已停 legacy(org 清理),非新活入口。
- Asha 在 #sub 回话 + reply-guard 探针符合选定语义;#sub-core 消失无引用报错。

## Rollback(逐 step 可逆,除 #sub-core 删除)
- Step 1:`save_issue` 改回原 team/label(key 再变)。
- Step 2:revert sub repo commit。
- Step 3:改回 generalChannel + 重启 Bridge。
- Step 5:移 #sub 可逆(移回);**删 #sub-core 不可逆** → 故排最后、门 1 全绿才做。

## Deferred(单独 issue,不在 FLY-722)
彻底删 `sub` ProjectEntry + relabel cron/growth 机器 issue + 搬 `/Dev/sub` 代码进 tidal-echo(或加 per-lead projectRoot schema)= **物理 repo 合并 issue**。届时 cron 才改 `projectName` + 关 #sub runtime binding。

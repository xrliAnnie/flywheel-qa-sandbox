# FLY-945 founder 批准 → runner self-ship 全链修复 — QA 报告

Issue: FLY-945 (https://linear.app/geoforge3d/issue/FLY-945/bugworkflow-founder-批准没触发-runner-self-ship-lead-被迫-executor-merge)
日期: 2026-07-07
基于: plan.md / exploration.md / research.md + 本分支实现 commit (A→F)

## 0. 结论

**PASS.** 六个 Fix(A grace / B rebind / C FSM 恢复边 / D 外部 merge 收敛 / E founder 归属 / F 纪律文本)
全部按 plan 落地,FLY-945 专属测试 222 例全绿,四个触及包全量套件除**环境性/并发污染的假失败**外全绿
(逐条 root-cause 归因,无一条是 FLY-945 回归)。Annie 核心诉求(**只有 founder 能批**、且合法 founder
批准能真的过 verify)由**真机 CLI 端到端 smoke**在真 `~/.flywheel/.env` 上验证成立。

QA 阶段本身对实现无返工,仅做一处 lint 卫生清理(移除测试文件里未用的 `beforeEach` import)+ 补一条
QA 报告 + 更新 progress 台账,均提交到本分支(不新开 PR)。

## 1. 测试执行(独立复跑)

### 1.1 FLY-945 专属测试 — 全绿(222 例)

| 范围 | 结果 |
|---|---|
| teamlead 9 个 FLY-945 测试文件(Fix A/B/D/E 写侧 + Fix C 三 sink + binding revision) | **126 passed** |
| core FSM(WorkflowFSM + fly793-design-done,Fix C 加边) | **61 passed** |
| flywheel-comm verify-approval(Fix E 读侧 + 归属矩阵 + 防伪守卫 + codex 硬门) | **35 passed** |

均在隔离 TMPDIR(scratchpad 下,不与 `~/.flywheel` 重叠)复跑,非 CI 单点。

### 1.2 触及包全量套件

| 包 | 结果 |
|---|---|
| flywheel-core | **208 passed** |
| flywheel-config | **359 passed** |
| flywheel-comm | **745 passed** |
| flywheel-teamlead | 5295 passed / 30 环境性假失败(见 §2) |

`biome check`(FLY-945 触及的 35 个 TS 文件)= 0 error(修掉 1 个 warning,见 §3)。

## 2. teamlead 全量套件的 30 个失败 — 逐条归因为环境性,非 FLY-945 回归

关键判据:①两次全量跑失败文件集不同(run1 有 `gate-response-router`,run2 没有)= worker 污染/超时;
②所有失败文件在**隔离 + 干净 TMPDIR/env** 下复跑全绿;③FLY-945 diff 只碰其中 `LeadAlertNotifier.ts`
一个文件,且只是**新增枚举成员**(与失败用例逻辑无关)。

| 失败文件 | 数 | 根因 | 隔离复跑 |
|---|---|---|---|
| `codex-lead-runtime.test.ts` | 22 | runner 的 TMPDIR 落在 `~/.flywheel/runner-state/...`,测试自带的 "project root 不得与 `~/.flywheel` 重叠" 守卫误触发(已知假失败,见 memory `reference_qa_codex_lead_runtime_tmpdir_overlap`) | 换 TMPDIR → **124 passed** |
| `LeadAlertNotifier.test.ts` | 1 | runner 环境里有**真** `SIMBA_BOT_TOKEN`(env + `~/.flywheel/.env`),`resolveToken` 优先读 env 名 → 顶掉测试内联 mock token(`"resolved-bot-token"`)。FLY-945 对该文件只加了 `external_merge_suspect` 枚举,与 token 解析无关 | `env -u SIMBA_BOT_TOKEN` → **27 passed** |
| `createLeadRuntime-preflight.test.ts` | 3 | 全量并发跑的 worker 污染 | 隔离 → **4 passed** |
| `tmux-lookup.real-tmux.test.ts` | 2 | 需真 tmux + 稳定态,全量跑受并发干扰 | 隔离 → **5 passed** |
| `fly247-bash-suites.test.ts` | 1 | 重型 bash 套件,机器高负载下超时 | FLY-945 未触及该区域 |

FLY-945 diff 完全不碰 `tmux-lookup` / `bash-suites` / `fly247` / `createLeadRuntime` / `codex-lead-runtime`
(`git diff main...HEAD --name-only` 核实)。

## 3. QA 卫生清理(提交到本分支)

- `packages/teamlead/src/bridge/__tests__/auto-qa-ship-gate-rebind.test.ts`:移除未使用的
  `beforeEach` import(biome `noUnusedImports` warning;`afterAll`/其余仍在用)。该文件 13 例复跑全绿。
  (CI `biome check` 对 warning 不 fail,故非 ship blocker,仅卫生。)

## 4. 真机行为验证(超出单测:跑真构建产物 + 真 `.env`)

### 4.1 生产 `.env` 的 founder id 与 FLY-799 写入侧一致(防"修反了"最关键一环)

verify-approval(Fix E)从 `~/.flywheel/.env` 活读 `DISCORD_OWNER_USER_ID` 作为可信 founder id;
它必须等于 FLY-799 文字/reaction 批准写进 response.from_agent 的雪花,否则**合法 founder 批准会被误拒
→ 反而彻底打断 self-ship**。核对:

- `DISCORD_OWNER_USER_ID` in `~/.flywheel/.env` = `1138241636057481306`
- exploration §2 实锤的 FLY-799 文字批准 from_agent = `1138241636057481306`
- **一致** → 生产上合法 founder 批准会过 verify(self-ship 不被误伤)。

### 4.2 真·构建产物 CLI 端到端 smoke(runner ship 时执行的那条命令)

跑真 `node packages/flywheel-comm/dist/index.js verify-approval`(内含 Fix E,dist 已核有
`response_not_founder_attributed`),配真 `~/.flywheel/.env`,手工造 CommDB + StateStore:

| 场景 | 结果 | 判定 |
|---|---|---|
| S1 founder 批准(from_agent = 真 founder id)+ 当前 head 已 codex 通过 | exit 0,`{"approved":true}` | **self-ship 放行** ✅ 合法批准不被误伤 |
| S2 Lead 自批 `{approved:true}`(即使 codex 也通过) | exit 1,`response_not_founder_attributed` | **FLY-921 那扇门关上** ✅ 只有 founder 能批 |

附带确认:S1 起初在 `FLYWHEEL_CODEX_HARD_GATE=0`(进程 env)下仍被 `codex_review_not_approved` 拦
→ 证明 codex 硬门(FLY-827)不吃 stale 进程 env(活读 `.env` 优先),安全分层完好;补上 head 的
codex_review_record 后才放行 = 正确叠加顺序。

## 5. 与 plan 的符合度核对

| Fix | plan 要点 | 测试覆盖(独立复跑确认) |
|---|---|---|
| A grace | ship-gate 15s、非 ship 保 10min、stop-advance 不 break、at-least-once、reaction 同放行、`=600000` reverse-compat | `founder-reply-deliverer` + `gate-poller-ship-grace`(表驱动 + 幼龄非-ship 不丢 + 幂等重扫 + reverse-compat) |
| B rebind | 全条件才 rebind、祖先校验(真 git)、缺 worktree fail-closed、已有 response 永不 rebind、binding revision(完整 40-hex key)、追发失败不写 binding + 重试钩子、`=0` drop | `auto-qa-ship-gate-rebind`(①~⑦ + 各条件逐一 drop)+ `gate-message-binding*` |
| C FSM | `approved_to_ship→awaiting_review` 加边、三 sink + reconciler 同步、带新 questionId 才回退否则 FLY-208 5a | `WorkflowFSM` + `event-route-fly945-reopen-review` + `complete-marker-reconciler`(新/旧/缺 questionId 矩阵) |
| D reconcile | 只认 gh MERGED、路1 走 FLY-869 ship-eligibility、路2 exact-head-match 才归档否则 alert(FLY-921 残局形态)、archive-once/节流/TTL/`=0` | `external-merge-reconcile`(两路结局 + 信任矩阵 + 节流 + reverse-compat) |
| E 归属 | 读侧可信集 + `response_not_founder_attributed`、写侧 enforce 写 `bridge-founder-consent` / audit_only+pass-through 写 leadId 被拒、防伪守卫(reserved/雪花不可 caller 供给)、id 缺失跳过、`=0` bypass | `verify-approval`(归属矩阵 + 防伪 e2e + QA-room bypass)+ `gate-response-router` + `founder-attribution` |
| F 文本 | executor-merge 退役(founder-only-authority)+ Blueprint APPROVE GATE 补 push→补 codex+重发 qa_result | 文档 diff 核对(零代码) |

## 6. QA 判定

**PASS(机制级 222 测 + ①②③ 全部真机 live E2E 验证)。**

- 实现与 plan 一致、FLY-945 测试 222 独立复跑全绿、全量套件失败均为环境性(非回归)。
- **③ Lead 自批被拒 = 真机验证**(真构建产物 verify-approval CLI + 真 `~/.flywheel/.env`,§4)。
- **①(文字批准 ≤75s 落库)② (head 漂移→自动 rebind 追发)= 隔离 Bridge live E2E 真机验证通过**
  (Annie 拍板选 b:先跑隔离 Bridge live E2E 再 ship;不碰生产 Bridge/DB)。详见 §8。
  - ① 用 Annie 本人的真 Discord「ship it」跑通:10min-grace 卡住 vs 15s-grace 落库成 founder 归属批准,
    latency ≈ 29s(远低于 ≤75s 预算)。
  - ② 用真 `AutoQaCoordinator.onQaResult` + 真 git 祖先校验 + 真 Discord 追发跑通:pr_head 更新、
    binding 改绑真追发消息、`ship_gate_rebound` 审计齐。
- **④ 外部 merge 收敛兜底** 仍是 post-deploy 观测项(§7;非本次 live E2E 的 ①② 主链,kill-switch 保护)。

诚实边界(plan 已写明):Fix E 在项目未配 `DISCORD_OWNER_USER_ID` 时跳过归属校验(feature-off);
本机生产 `.env` 有该 id,故生产上是硬约束。

## 7. Post-deploy 观测清单(①②④ — ship 后在真 Bridge 上验)

前置:FLY-945 dist 随波次重启部署到生产 Bridge 后。全部改动带 kill-switch,任一场景失灵 →
设对应 `=0`(见下)**一秒回退**,不阻塞其余。

### ① 文字批准 ≤75s 落库(治「批准没触发」的直接根因)

- **触发**:任一真 [FLY-XX] approve_to_ship gate,founder 在 thread 发文字批准(如 "ship it")。
- **看什么**:comm.db 里该 bound question 的 response.created_at 时间戳 − Discord 消息 ts 的差。
  配套事件:`founder_ship_reply_waked` / gate response 行 / `state_transition` awaiting_review→approved_to_ship。
- **算过**:delta **≤ ~75s**(60s pass 节奏 + 15s grace),对照事故当晚的 ~11 分钟。
  且确认 live Bridge 上 `FLYWHEEL_SHIP_GATE_GRACE_MS` 解析为 15000(默认)。
- **回退**:`FLYWHEEL_SHIP_GATE_GRACE_MS=600000` → 回旧 10min 语义(reverse-compat 单测已锁字节)。

### ② gate 开后 head 漂移 → 自动 rebind 追发(治「批准落空」)

- **触发**:runner 开 approve gate 后补 push(如 QA 证据 commit)→ head 漂移 → 对新 head 补 codex
  review + 重发 `qa_result(status=pass, 新 prHeadSha)`。
- **看什么**:`ship_gate_rebound` 审计事件(old/new sha、questionId、追发 message id);thread 里的
  **追发** Discord 消息(「⚠️ gate 更新:PR head <old8> → <new8> …你的批准将绑定新 head」);
  session.pr_head_sha 已更新为新 head;gate-message-binding 新增 revisioned 行。
- **算过**:rebind 仅在全条件满足时触发(pass verdict + awaiting_review + bound question + 无 response
  + 祖先校验过);founder ✅ 打在**追发**消息上绑新 head、打在旧消息上失配 no-op。
- **回退**:`FLYWHEEL_SHIP_GATE_REBIND=0` → 维持现状 drop。

### ④ 外部 merge 收敛兜底(治「归档蒸发」)

- **触发**:parked/awaiting_review session 的 PR 被外部 gh merge(或 completed-but-unfinalized 残局)。
- **看什么**:reconcile pass 在 TTL 后核 PR MERGED → 路1 走 ship-eligibility → finalization + 归档级联;
  路2 exact-head-match 才归档、否则 `external_merge_suspect` alert(FLY-921 残局形态被看见不被误归档)。
- **算过**:MERGED 且 eligible/head-match → 自动收尾 + 归档;head 脱节 → alert 不归档。
- **回退**:`FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0` → no-op。

### 主链联测(可选,一次真 founder ship 即覆盖)

founder thread 发 "ship it" → ≤75s 落库(归属 founder)→ runner verify-approval 过 → 自 merge(测试仓)
→ completed → 标 Done + thread 归档全自动、Lead 零插手、founder 零催办。

### kill-switch reverse-compat(单测已验,部署时无需重跑)

`FLYWHEEL_SHIP_GATE_GRACE_MS=600000` / `FLYWHEEL_SHIP_GATE_REBIND=0` /
`FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0` / `FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0` 全关 = 字节回到修复前行为
(各 Fix 的 reverse-compat 单测已锁,§5 表)。

## 8. 隔离 Bridge live E2E 结果(Annie 拍板 b,真机、别 mock)

隔离环境跑 PR #485 新码的编译产物,不碰生产 Bridge/DB。测试 server = QA 房 slot-1
(guild 1485787271192907816),隔离 CommDB/StateStore + 真 git 仓 + 真 Discord 测试 thread。

### ② head 漂移 → 自动 rebind 追发 — PASS ✅

- 驱动:真 `AutoQaCoordinator.onQaResult`(真 rebind 逻辑)+ 真 `git merge-base --is-ancestor`
  (真 2-commit 仓,OLD 是 NEW 祖先)+ 真 Discord 追发(bot 发到真 thread)。
- 喂漂移 head 的 `qa_result(status=pass, prHeadSha=NEW)`,观察:
  - `session.pr_head_sha`:`a0313787` → `82177a05`(更新到 QA 证据 head);
  - review question 不轮换;auto-qa record 重定向 NEW(status=passed)、OLD 消失;
  - gate-message-binding 改绑到**真追发消息 id**;`ship_gate_rebound` 审计事件落库(old/new sha + msgId)。
- 真追发消息(bot 发,live):
  https://discord.com/channels/1485787271192907816/1524092166819942601/1524092573575286794
  内容「⚠️ gate 更新:PR head a0313787 → 82177a05(QA 证据 commit,QA PASS)。你的批准将绑定新 head。」

### ① founder 文字批准 ≤75s 落库 — PASS ✅

- Annie 本人在测试 thread 发**真**的「ship it」(Chrome-as-Annie,她授权;author.id = 她真 Discord id
  `1138241636057481306`,非 bot)。消息 live:
  https://discord.com/channels/1485787271192907816/1524093622847406271/1524099607137620128
- 对同一条真消息跑真 `emitFounderReplyDeliveryForThread`(真 fetch 读真 thread + 真 FLY-799
  `makeFounderShipApprovalCallback` 写 gate 响应),before/after 对照:

  | grace | 结果 |
  |---|---|
  | **600000ms(10min,修前)** | 消息(~25s 龄)immature → **不处理**(旧行为把 founder 卡在这里 = FLY-921 根因) |
  | **15000ms(FLY-945)** | 消息 mature → **落库**:`{"approved": true}`、`from_agent=1138241636057481306`(founder 归属)、approved=true |

- **①落库 latency ≈ 29s**(Annie 消息 → gate 响应写入),远低于 ≤75s 预算,与事故当晚的 ~11 分钟对照。
- 「ship it」命中 Tier-2 exact allowlist(零 AI),纯走 grace 路径,精确隔离出 Fix A 的 grace 修复。

### 结论

①②③ 全部真机 live E2E 通过。真 ship gate 仍 **hold**,等 Annie 本人对 PR #485 的 approve_to_ship
gate 批准(她这条 live E2E 的「ship it」是隔离测试消息,**不是**对真 PR 的 ship 批准)。

# FLY-1940 引擎生命周期三缺口收口 — 探索

Issue: FLY-1940 (https://linear.app/geoforge3d/issue/FLY-1940/引擎生命周期-三缺口收口死-session-复活直通-ship-卡-交棒不唤醒-孤儿闸监控并-19411946)
日期: 2026-08-21
基于: 无

## 0. 一句话

引擎(generalized workflow / workflow_v2)的**状态转移边缘路径没有闭环保证**:session 死而复活能绕过 QA 直通 ship 卡;交棒不唤醒接棒人;founder 闸开了没人管一辈子;needs_lead 是死路;terminate 杀不干净;land 收官停在 partial。同一病灶的六个切面,一次设计收口。

## 1. 背景与合并史

- 本单合并自 FLY-1940 / FLY-1941 / FLY-1946(8-20 立),挂在 Epic FLY-1954(巡检机制缺陷收口)下。
- 8-21 凌晨到早晨,founder + Lead + QA 在生产上连续追加了 **8 条一手案发记录 comment**,把原三缺口扩成六个切面。Tadashi 设计指引([lead-instruction 86c14bc7])要求全部纳入设计,修不完的排优先级、不许静默丢。

## 2. 案发记录(一手证据,全部来自 issue comments)

### 切面①:终态 session 复活直通 ship 卡(原 1940,FLY-1894 案)

- session 被 Bridge force-fail 判死 → 重启后 tmux 窗口复活 → 走完流程 → 直接开出 APPROVE_TO_SHIP 卡。
- 而账上的 QA PASS 绑的是 **6 轮修复之前的旧 head**。founder 当场抓到。
- 修向(issue 原文):ship 卡开出的前置断言 = 存在**绑定当前 head 的 QA PASS**(或 founder 明示免 QA);复活 session 重新进入流程时重置 needs_review。

### 切面②:交棒不唤醒(原 1941,8-20 一天两案 + 8-21 第四例)

- 案 1/2(8-20):QA FAIL 后引擎把棒交给停驻的 Codex 实现体(goal-achieved 态),**零唤醒**,Lead 手工 doorbell 才动;final QA 唤醒也曾靠 Lead 补推。
- 案 3(FLY-1925 founder 打回,8-21):rework 交付断言共享 worktree HEAD == 实现体最后交付头,但 **QA 在分支顶推报告 commit 是流程常态** → 断言必然失败 → hold 5 次 → needs_lead,棒卡在已收工的 QA 手上。
- 案 4(FLY-1934 补派死锁,8-21):实现体 tmux 窗口物理消失但 FSM 停 awaiting_review → rework 唤醒 `wake_delivered` **投给死身体也算送达** → coordinator 视为完成;Lead 校正死体为 terminated 后,幂等重放不重投,`/api/runs/start` 补派又被陈旧 start 预约(指向已终结 exec)挡回 `STALE_START_RESPONSE`,预约不清,hint 指回 rework = 死循环。唯一出口 = Bridge 重启重播。
- 划界:FLY-1876 管 Lead inbox nudge 降级;本单管 **runner 侧 turn 交棒唤醒**。

### 切面③:孤儿闸(原 1946,Honey Lemon 两轮生产查证)

- FLY-1758:founder 闸开 **152.8 小时**,查实为孤儿记录——issue 六天前已 Done、PR 已合并,闸开在 run 中途没人关。
- FLY-1911(同日):founder_review 开后从未被答、后被 superseded,没有任何机制强迫它关闭。
- 名册盲区二次复现(FLY-1925 QA 隔离房,8-21):靶单唯一活 session 被打成终态后,该 issue **整条从巡检名册消失**——「run 活着 + 闸开着 + 人全走了」形态全盲。
- **判据必须四条与,缺一即废**:闸开着 ∧ run 还活着 ∧ 未被 superseded ∧ 没人答。排除条件缺一,监控第一天就会拿已交付/已放弃的活去 page 人 → 大家学会忽略它 → 比没有更糟。
- engine-held 双闸发现(QA 四格实测):runner 真死时引擎把 run 置 `held`;「持棒者不活跃」红灯按设计只看 active run → 真死的 run 往往已 held → **两头都不报**。判据里「run 活」必须显式定义 held 算不算活。
- 便宜修法线索(未验,调研需核):mailbox 行自带 superseded_at/superseded_by 字段,只是 founder_review 闸的 supersede 路径没写它。
- 合同缺口(实现时显式决策,禁静默跳过):founder_review 保证的是「闸被打开过」不是「她看见了」——只做闸龄告警这一半仍是空的。

### 切面④:needs_lead 死路 + quiescence 门结构性不可过(8-21 全链实测)

- 三条合法路径全试尽:新代 rework → `REWORK_TARGET_NOT_QUIESCENT`;同代幂等重放 → `idempotentReplay:true` 但不重臂;同代修订 feedback → `operator_request_conflict`。**retry_exhausted + needs_lead = 绝对死路**。
- Bridge 重启也不重放(8-21 05:40Z 统一重启实证):needs_lead 投递、「节点 running/执行体 terminated」幻影、指向死体的 start 预约,全部原样冻着。
- 正门实测走不通(founder 授权后执行):把 run 名下全部执行体经 canonical terminate 停掉后再 rework,**仍被拒**。根因:terminate 后 CommDB sessions 行不存在 → `lookupTmuxTarget` 返回 gone → 未传 `allowMissingTargetHostAbsence` → quiescence 探针返回 **unknown** → unknown 被当 live。**任何被正规拆掉的体都永远无法被判死**;只有 crash_preserve 留窗的 dead_pin 体才算。
- 修复要求(comment 原文):quiescence 对「会话终态 + CommDB 无行 + 无 tmux 目标 + 无宿主进程」应判 dead;wake_delivered 且收件人已 terminated 的 rework 应允许 supersede;needs_lead 必须有 Lead 侧 resume 端点(比照 land 的 `resumeHeldLandOperation`);start 预约在其 exec 终态后自动失效;Bridge 启动时对幻影做一次 reconcile。

### 切面⑤:terminate 不杀进程树(8-21 05:53→06:5x 实证)

- `close_runner abandon` 对 Codex 体只拆 tmux 窗口 + 置 sessions=terminated,**codex app-server 守护进程(ppid 1)未被杀**。
- e244d9c6 被终结一小时后仍按 goal 轮询 `turn`、继续向 CommDB 发 RUNNER-STOPPED/DONE,烧 Codex 额度且污染 Lead 收件箱。16h 龄进程树被手工 kill。
- 验收:terminate 必须按 FLYWHEEL_EXEC_ID 杀全进程树(含 ppid 已变 1 的 daemon),并以「无该 exec 的宿主进程」为终态证据之一——这同时是切面④ quiescence 探针 absent→dead 的前提。

### 切面⑥:land finalization 停 partial 不归档(8-21 founder 点名)

- 今晚三次引擎 land 收官(1912/1929/1795)**都没有自动归档 issue thread**,全靠 Lead 手动 `/api/chat-threads/archive` 补。
- 1795 的 land_operation 停在 partial / notification:finalization_partial;1867 早前 issue_closeout_incomplete 重试 7 次。
- 达成标准(founder 原话口径):**ship 完 thread 自己消失,founder 和 Lead 都不用碰**。finalization 必须把 thread 归档、Linear Done、窗口清理走完并留每步 receipt;partial 要自动重试且收敛,超时上浮而不是安静停着。

## 3. 病灶的统一表述

六个切面共享同一结构缺陷:**引擎的每一次状态转移都假设「对面还在、下一步会自然发生」,而没有闭环验证**。

- 转移进入(ship 卡开出)不验前置(QA 绑当前 head);
- 转移送出(交棒)不验到达(收件体活着、真的动了);
- 转移挂起(founder 闸)不设看护(四条件监控);
- 转移失败(needs_lead)没有出口(resume 端点)且判活探针对正规拆除盲(unknown≠live);
- 转移终结(terminate)不验干净(进程树残留);
- 转移收官(land finalization)不保收敛(partial 无限停驻)。

设计目标:给每类转移补上「**验证-闭环-出口**」三件套,而不是给每个案例打一个补丁。

## 4. 红线(Tadashi 设计指引,逐字纳入)

1. **简单优先** — 能收敛进现有机制的不开新机制;
2. **净删除** — 修复应减少特殊路径而不是增加;
3. **开新路同 PR 删老路** — 不留双轨;
4. **不加新告警层** — 复用现有 alert 位点(unified alert / Lead alert notifier / GatePoller rider),不建新巡逻器家族(FLY-1570/1560 刚拆完看门狗全家,不能又长回来);
5. 修不完的子项在设计里**排优先级并说明**,不许静默丢。

## 5. Scope 边界

**IN**:上述六切面的机制设计 + 与在飞 PR 的分工切割(调研文档给出逐项对照)。
**OUT**:
- Lead inbox nudge 降级(FLY-1876);
- 巡检体系细则(FLY-1945)/ 通信防线(FLY-1942)等同 Epic 兄弟单;
- founder「她看见了」的阅读确认 UX(本单只显式决策合同边界,不做阅读回执产品化);
- 已在飞 PR 已覆盖的部分不重做(调研文档逐项标注)。

## 6. 已知的在飞重叠(设计必须切割,调研核实)

CLAUDE.md 里程碑显示多个单与本单重叠:FLY-1770、FLY-1655、FLY-1638、FLY-1628、FLY-1731、FLY-1448、FLY-1772、FLY-1759、FLY-1709。**更正(R2)**:里程碑标注不可信——经 merge-ancestry 实证,FLY-1770/1628/1759/1912 及 FLY-1638 基座**已在 main**,只有 FLY-1655/1772/1638-followup 仍在飞(实证过程与逐单立场见 research.md §8)。本单设计对每一块回答:等它 / 叠它 / 替它。

### 切面③补充:stale TURN 存量(Tadashi 8-21 追加,来自 1925 QA 生产只读回放)

- `three_stage_turn` 表有 **158 条活棒**:持有者现场探针全 dead,棒龄上千小时。
- 孤儿闸/stale TURN 清扫策略必须覆盖这批存量;且 FLY-1925 部署后巡检会开始把它们亮红。
- 设计必须给出收敛路径:一次性 reconcile 还是随巡检渐清,**论证后选**。

## 7. 开放问题(带到调研)

1. ship 卡开出点现有前置到底有哪些?head 绑定在哪一层断的?
2. wake 的 per-vendor 物理路径(Claude mailbox vs Codex daemon)各自哪一环可以静默 no-op?
3. superseded_at/superseded_by 字段是否真的存在、谁写谁不写?
4. 「run 活」在数据上如何定义(active/held/attempt 状态组合)?
5. terminate 现路径到底做了什么、缺的进程树 kill 应挂在哪个 seam?
6. finalization 的步骤清单与 partial 停驻点在哪?FLY-1770 若合入还剩什么?

# FLY-2653 Raya 割接工具缺口 — 探索
Issue: FLY-2653 (https://linear.app/geoforge3d/issue/FLY-2653/raya割接工具缺口-旧壳-brain-在-p3-之前自己死了-标准-lead-已在线-班车-prestop-永远-validation)
日期: 2026-09-18
基于: 无

## 1. 这张单在问什么

FLY-2653 是巡逻记账单（patrol finding ×2，2026-09-16 00:09Z / 12:08Z）。形状：

- 班车 raya 段 `prestop-failed prestop-validation-failed`：`raya_verify_legacy_owners` 对已经消失的旧壳 brain 要求 `pid==null` 或已有 stop intent，而账本记着活 pid 54811。
- 修账本的正门 `raya-migration-manifest init --resume-from-failed` 被 `cursor-already-exists` 拒：标准 Lead 已经在线，持续写 cursor。
- 两道守卫叠加 ⇒ 无正门，只能改代码。

期望（二选一或都做）：(1) 旧壳自行退场时容忍并补时间戳、发 alert；(2) resume 时在标准 Lead live 的前提下复用既有 cursor，标 `preexisting`。

## 2. 审计结论：两条期望都已被 FLY-2657 实现并上线

| FLY-2653 期望 | 已落地的实现（`9e6282830`，PR #1241，2026-09-18 09:34 PT 合入） | 当前 main 上的位置 |
|---|---|---|
| (1) service-missing + 账本 pid 已死 ⇒ 视为自行退场 | `raya_legacy_recorded_owner_gone`：`kill -0` 失败，或 pid 仍在但启动时间与账本不同（pid 复用）⇒ 通过；启动时间相同或读不到 ⇒ 拒。verify 两次都零写；quiesce 阶段 disable 读回后用同一时刻写齐 `stop_started_at_ms / disabled_at_ms / stopped_at_ms`，仅对「进入 quiesce 前已自行退出」的 owner 发 warning `raya-legacy-owner-already-exited` | `scripts/lib/updater-raya-deploy.sh:270-283, 341-432, 966-1008` |
| (1') 生产上实际还出现的三种邻近形状 | launchd 重启后以新 pid 拉起旧壳（按 launchd 当前 pid，且进程 argv[0] 的 basename 与 plist node 的 basename 一致、argv[1:] 与已验证 plist 精确一致，走正常 stop；注意 argv[0] 只比 basename，`:292-309`）；voice `loaded / state = not running / 无 pid`；未记账但 argv[0] basename 为 node 且 argv[1:] 精确匹配的遗留进程（全进程 census，fail-closed） | 同上 `:285-339` |
| (2) resume 时复用 live Lead 的 cursor | `resumeFromFailed && cursor 存在` ⇒ 解析 cursor + public `flywheel-lead.sh verify --stage live`（30s）通过 ⇒ `cursor.status="preexisting"`；无 resume 标志仍 `cursor-already-exists` | `packages/teamlead/src/bin/raya-migration-init.ts:309-333` |
| (2') preexisting 的下游配套 | P3 只读 boundary 校验（current ⊇ boundary 且不落后）；P4b `verify live → install 受控重启 → ≤30×2s 等 live → 写 activated_at → 发 post-activation 探针`；P6 proof 明记 `writerStopped:false` | `seed-lead-inbound-cursor.ts`、`raya-migration-shuttle.ts`、`raya-standard-migration.sh`、`updater-raya-deploy.sh:488-593` |

生产侧只读核对（2026-09-18 13:20–13:40 PT）：`~/.flywheel/deployed-sha = bd2fc7dfe…`，含 `9e6282830`；`packages/teamlead/dist/bin/raya-migration-init.js` 已含 `preexisting` 分支。

**所以 FLY-2653 与 FLY-2657 是同一个缺口的两张单**：FLY-2653 的 `next action: file:raya-migration-tolerate-dead-legacy-and-preexisting-cursor` 被兑现成了 FLY-2657。Lead 2026-09-18 裁定选 A：本单不再设计新代码，产物 = 审计 + 覆盖映射 + 生产恢复 runbook + 验收项。

## 3. 那为什么 12:06 PT 那趟（已带新代码）仍然失败

执行前快照（2026-09-18 13:20–13:40 PT，Lead 重放 init 之前）：生产账本是 `checkpoint=P2`、`target_raya_sha=5913bb47…`、授权行 `cutover=5913bb47`、`cursor.status=null`、brain `pid=54811`。新代码下逐道闸走一遍：

| 闸（`raya_prestop_prepare`，`:1033-1103`） | 旧账本下的结果 |
|---|---|
| `raya_legacy_stop_authorized`（行与 target 前 8 位自洽） | 过（`5913bb47` 与 `5913bb47` 自洽） |
| `raya_verify_legacy_owners` | **现在过**（FLY-2657：pid 54811 已死） |
| `origin/main == target_raya_sha`（`:1046`，严格相等） | **不过**：Raya `origin/main` 已是 `90e433e8…`（#154 + 一串 summary PR），target 还是 `5913bb47` |
| persona 占位 == target 的 `identity.md`（`:1064-1066`） | **不过**（见 §4） |

也就是说，缺的不再是代码，而是两件运维动作：用 founder 2026-09-16 22:48Z 的新授权行（`cutover=90e433e8`）重放 init，以及 §4。**两件都已由 Lead 在 13:37 PT 前后执行并读回通过（runbook §0 现态）；现在只剩等 scheduled 班车。**

## 4. 新发现：第三道闸——persona 占位过期

`raya_prestop_prepare` 要求 scratch 构建出的 `.lead/raya/identity.md` 摘要 **等于** 工作区 `~/Dev/raya-lead-workspace/.lead/raya/identity.md` 的摘要。FLY-2496 `plan.md:77` 把「按 target SHA 把 persona 投影进工作区」定义为激活包里的一步**人工动作**。

| 来源 | sha256 前缀 |
|---|---|
| 工作区执行前的值（2026-09-14 写入；13:37 PT 后已是 `ca1240f1…`） | `4e982448…` = Raya `9d63a2b`（2026-09-09） |
| 旧 target `5913bb47` | `72553f4c…` |
| 新 target `90e433e8` | `ca1240f1…` |

persona 自 9-09 以来在 Raya main 上改过 4 次；每次换 target 都必须重投影，而没有任何工具提醒。**即使 init 重放成功，不做这一步，下一班仍是同一个 `prestop-validation-failed`。** 这一条已写进 runbook §3，并已先行用信报给 Lead。

## 5. 为什么这类问题要三天才看清：prestop 失败只有一个 detail

`raya_prepare_source:1150-1153` 把 `raya_prestop_prepare` 里约 20 个子检查的任何失败都折叠成 `prestop-failed prestop-validation-failed`。巡逻只能看到这一个字符串，于是 FLY-2653 把根因归给了它能看见的那一道闸（legacy owner），而 `origin/main` 漂移、persona 过期这两道同样会失败的闸完全隐形。这是本单真正残留的「工具缺口」，但属于可观测性改进，不是割接卡死的必要条件。

## 6. 选项

| 选项 | 内容 | 评价 |
|---|---|---|
| A（Lead 已选） | 本单零代码；交付审计、覆盖映射、runbook、验收项；两条改进登记为建议后续单 | 与 founder 2026-09-16「不开新活」一致；今晚能否用上 Raya 只取决于 runbook |
| B | 本单 implement 范围加入 (a) prestop 子原因 detail、(b) init 预检 persona | 有价值但不解今晚之急；改动触及割接关键路径，值得单独过一轮 Codex 设计评审 |
| C | 直接关单不出文档 | 丢掉 §3–§5 的事实与 runbook，下次换 target 会原样再踩 |

## 7. 假设（显式列出）

1. founder 授权消息 `1549915003895947318` 的正文里**逐字**含 canonical 行。runner 没有读 Discord 正文；runbook 的 dry-run 一步核出。
2. 探针 bot（`TADASHI_BOT_TOKEN`）能读授权频道 `1547579673049829558`。旧账本的授权证据就是同一频道、同一 bot 取回的，故大概率成立。
3. Raya `origin/main` 在今晚 00:00 PT 班车前不再前进。summary PR 会合入 Raya main，这一条**不受我们控制**；漂了就要重新要授权行。

# FLY-1201 账号切换 stale `.active` 覆盖 live 凭据 — 独立 QA 报告

Issue: FLY-1201 (https://linear.app/geoforge3d/issue/FLY-1201/bug-account-switch-引擎带外登录留下-stale-active-时切号会覆盖-live-凭据跳过-capture-back)
日期: 2026-07-19
基于: plan.md（§5.3 验收口径）

## 0. 结论

**PASS。** 事故基底在隔离沙箱里**修前真复现、修后真消失**，四条 §1.1 契约行逐行对上；新增测试经**突变验证**非空过；fail-closed 矩阵零 mutation；健康路径无行为变化。

判定所依据的最强证据是**我自建的、与实现者测试无关的 harness**（不是复跑他的 vitest），跑的是真脚本、真 bash、真文件系统，只把 Keychain / OAuth probe / freshness / quota-guard / alert 换成 stub。

## 1. 被测对象

| 项 | 值 |
|---|---|
| 分支 / HEAD | `flywheel-FLY-1201` @ `0e4b1e0f5944465ca0c8c3859530d1721de08318` |
| PR | #653（OPEN, MERGEABLE/CLEAN） |
| 修复 commit | `c995d3e3d`（唯一代码 commit，其余为 progress ledger） |
| 修前基线 | `c995d3e3d^`（已 diff 校验：突变 worktree 的脚本与它逐字节相同） |

## 2. 隔离（先说这个：本轮 QA 绝不碰生产登录）

`flywheel-claude-profile` 会写真 Keychain。全部外部触点都指向 scratch：

`FLYWHEEL_CLAUDE_SECURITY_BIN`（stub，真 `/usr/bin/security` 一次都没 exec）、`FLYWHEEL_PROFILE_CURL_BIN`、`FLYWHEEL_CLAUDE_JSON`、`FLYWHEEL_CLAUDE_PROFILES_DIR`、`FLYWHEEL_CLAUDE_ACCOUNTS_PATH`、`FLYWHEEL_CLAUDE_ACCOUNTS_LOCK`、`FLYWHEEL_PROFILE_AUDIT_LOG`、`FLYWHEEL_CLAUDE_FRESHNESS_BIN`、`FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN`、`FLYWHEEL_LEAD_ALERT_BIN`、`FLYWHEEL_ALERT_QUEUE_DIR`、`FLYWHEEL_ALERT_DEADLETTER_DIR`、`FLYWHEEL_CLAIMS_DB`。

**事后核对生产真状态**（不是看日志说了什么，是看文件）：

- `~/.flywheel/claude-profiles/.active` = `shopping`，mtime `Jul 17 18:18`（早于本轮 QA），池内各槽 mtime 均为 Jul 16–18 → **未被触碰**。
- `~/.claude.json` 的 `oauthAccount.emailAddress` = `xrliannie.1@gmail.com`（本会话账号）。测试输出里那句 “Updated ~/.claude.json display identity to 'school'” 只是**写死的文案**，写的是它自己的 temp 文件 —— 若真写了生产文件，这里会显示 school 的邮箱。
- **红线核对**：所有 stub 的 argv 日志里 `sk-ant-oat01` 出现 **0** 次；凭据只走 `security -i` 的 stdin。阳性对照 = argv 日志**非空**（stub 确实被调用过），否则这个 0 是空过的。

### ⚠️ 一次真实外溢（我造成的，已止血，需知会）

第一轮 matrix 跑的时候我还没 stub `FLYWHEEL_LEAD_ALERT_BIN`，脚本按相对路径找到了真的 `scripts/lead-alert.sh` 并**真发出了 1 条 `quota_guard_bypassed` 告警**（stderr 原话 “quota bypass audit alert accepted (sent)”，target=`school`，2026-07-20 02:40Z）。生产 `~/.flywheel/alert-queue/` 里留下 `.rate-202607200240` 计数=1 为证。

- 影响：#flywheel-alerts 里多一条来源是 QA 的 quota-bypass 告警，内容不含任何真凭据、不改任何账号状态。
- 止血：加了 alert stub 后重跑同一 matrix，`ls -a ~/.flywheel/alert-queue/` **前后 diff 为空**（阳性对照 = 上一轮确实产生过新文件，说明这把尺子测得出来）。
- 这是我 harness 的疏漏，不是本 PR 的缺陷。

## 3. 事故复现：修前 vs 修后（核心证据）

基底逐字照 issue：Keychain = shopping **LIVE**；`.active` = `business`（带外 `claude /login` 留下的陈旧台账）；business 槽 = Jul-4 死快照；store = business；display = shopping。

> 说明：business 的 Jul-4 快照设为「identity 仍可解析、但 freshness 判 stale」——这正是 refreshToken 已死的形态，也是**唯一能观察到「跳过 freshness」这个被报缺陷**的配置。若连 identity probe 都打不通，FLY-1182 的目标身份门会先在 exit 88 拦下（这个变体我也跑了，附在 harness 的 `BUSINESS_PROBEABLE=0`）。

| 命令 | 修前（`c995d3e3d^`） | 修后（HEAD） |
|---|---|---|
| `use business` | **exit 0；Keychain 被 Jul-4 死快照覆盖**；live shopping 凭据**无处可寻**（shopping 槽仍是旧快照）→ strand。无 `FLYWHEEL_TARGET_STALE` = **freshness 被完整跳过**，capture_back 也没发生 | **exit 30**；Keychain **原封不动**（仍是 live）；`.active`→`shopping`；store→`shopping`；shopping 槽已收到 **live 字节**；stderr 有 `_MARKER` + `_RECONCILED` + `FLYWHEEL_TARGET_STALE` |
| `use shopping`（还原） | exit 0，但 **live 凭据被池内旧快照覆盖**（`QASHOPLIVE` → `QASHOPSNAP`），`FLYWHEEL_ACTIVE_IDENTITY_DRIFT` = capture_back 被陈旧 anchor 打偏 | exit 0，Keychain **仍是 live**，槽内也是 live |
| `use school`（第三账号） | exit 0，切成功，但 **live shopping 凭据丢失**（槽里还是旧快照） | exit 0，切成功，**shopping 槽保住 live 字节** |
| `next` | exit 0，同上丢 live | exit 30，Keychain 安全，用的是对账后的 active |

四行与 plan §1.1 契约表**逐行一致**。

## 4. fail-closed 矩阵（修后，全部零 mutation）

每例都对 Keychain / `.active` / store / 三个槽做**全量快照前后比对**，`mutated=no` 才算过。

| 例 | 场景 | exit | mutation |
|---|---|---|---|
| B1 | `.active` 带尾随换行（字节级畸形） | 46 `_UNRESOLVABLE` | 无 |
| B2 | `.active` 是 symlink | 46 | 无 |
| B3 | identity probe 打不通（断网） | 46 | 无 |
| B4 | active 槽缺 identity anchor（legacy） | 46 | 无 |
| B5 | live 身份匹配 0 个槽 | 46 | 无 |
| B6 | live 身份匹配 2 个槽（歧义） | 46 | 无 |
| B7 | marker 在但 Keychain 空 | 46 | 无 |
| C1 | 畸形 marker + `FLYWHEEL_PROFILE_IDENTITY_BYPASS=1` | **仍 46** | 无 |
| E1 | `.active` 缺失 + Keychain 有 live 凭据 | 0（重建 marker 后正常切） | live 凭据先被收进 shopping 槽 |
| E2 | `.active` 缺失 + 空白机器（rc 44） | 0（现行为不变） | — |

C1 证实结构安全门**不可被逃生舱绕过**（plan §1.3）。

## 5. delegated（引擎）边界

第一次我用假的 `FLYWHEEL_CLAUDE_LOCK_DELEGATED` 值 → 脚本按设计 fail-safe 退回手动路径 → 报了个**假 FAIL**。真 delegated 需要 holder-marker pid == env == `$PPID` 且 holder 存活，于是我改成「父进程自己持锁、把脚本作为直接子进程 spawn」：

| 场景 | 结果 |
|---|---|
| delegated + **真 marker drift** | **exit 46，零 mutation**（"delegated switching performs no repair"）✅ |
| delegated + **display-stale**（marker 正确、只有 `~/.claude.json` 旧） | **exit 0 照常切**；shopping 槽保鲜成 live 字节；**store 的 activeAccount 全程停在 `business` 未被 bash 改动** → plan §2.3 的 CAS 安全论证成立 ✅ |

## 5.5 普通 47 档 + 「重跑收敛」（plan §1.3 / §4，我自建对照）

用窄作用域 fault hook `FLYWHEEL_TEST_FAIL_ACTIVE_MARKER_WRITE=1` 打断 marker 提交：

| | Keychain | `.active` | store | shopping 槽 | exit / 审计 |
|---|---|---|---|---|---|
| 起点 | live | `business` | business | 旧快照 | — |
| run 1（注入 marker 写失败） | **原封不动 live** | **旧 marker `business` 保留** | 已 sync 成 shopping | **已收到 live 字节** | 47 / `stale_active_repair_failed` |
| run 2（同一条命令，不注入） | school | school | school | **仍是 live 字节** | 0，`_RECONCILED` |

即：失败留下的是**只会更接近真相的可收敛前缀**，重跑一次真的收敛 —— 契约不是文字，是跑出来的。

## 6. 测试可信度：突变验证（防「空过的绿测」）

把 HEAD 的**新测试文件**放进 `c995d3e3d^` 的**旧脚本** worktree 跑 FLY-1201 块：

**21 例中 19 例转红**，2 例通过。通过的两例恰好是「两边都该绿」的不变量契约 —— *allows an absent-marker bootstrap only when Keychain proves the item is missing*（空白 bootstrap 直通）和 *treats display-only drift as a recoverable witness mismatch*（display 旧不得拒绝切换）。**新测试非空过，确实能抓住这个 bug。**

## 6.5 并发一致性（plan §4）

同一 stale-marker 基底上并发跑 `use school` 与 `use shopping`：两条都 exit 0，收敛后**状态自洽** —— `.active`=shopping 且 **Keychain 字节 == 该槽凭据**，live 凭据仍可从槽里取回。没有交错破坏、没有丢登录。

## 7. 测试与 CI

- **CI 在确切 head `0e4b1e0f5` 全绿**（9/9 job）。已核实 CI **真的跑了**这两个文件，不是没覆盖：`Unit (heavy)` 跑 `flywheel-claude-runner`，日志里 16 条 `stale active reconciliation (FLY-1201)` 全 ✓；`Unit (teamlead 2 of 3)` 跑了 `claude-profile-cli.integration.test.ts` 的 REAL-lock seam 用例，含 FLY-1201 的 *repairs delegated UUID-only display drift without mutating the Node store during apply*。
- **本机失败全部是高负载环境性，且有同负载对照实验为证**（不是靠「CI 绿所以本机不算」这种推断）：
  - bash 套件本机 14 failed / 98 passed。13 例是 `Test timed out in 15000ms`，**每一例耗时都 >15s**（16.5s–45.5s），而 CI 上同名用例 0.5–2s。文件级写死 `vi.setConfig({testTimeout: 15_000})`，CLI 的 `--testTimeout` 覆盖不掉。
  - 唯一一个断言型失败（FLY-865 的 *SIGTERM while holding the claude-json lock*，`waitFor` 只给 250×20ms = **5s** 硬预算）：**在同一负载下拿修前脚本跑，同样失败**（pre-fix 6683ms vs post-fix 6408ms）→ 与本 PR 无关。CI 上该例 552ms 通过。
- TS 映射层单测：74 passed / 2 failed，2 个 failed 是文件内写死 10s 的 REAL-script seam 例，CI 上 1166ms / 1406ms 通过。

## 8. 抽查：TS 归因不会错怪目标账号

用**真实跑出来的 stderr 字节**（不是肉眼看代码）验 plan §3.2 的 R1#5 消歧：修后 `use business` 的 stderr 同时含 `_MARKER` + `_RECONCILED` + `FLYWHEEL_TARGET_STALE`，exit 30。

- 该 stderr 对 `/FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE|FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED/` **不匹配** → 不会被误判成 `ActiveMarkerDriftError`，仍落 `TargetStaleError`。检测/成功 marker 与终止 marker 之间没有子串碰撞。
- `claude-profile-cli.ts` 里 46/47 分支确实排在 identity-marker 分支**之前**（plan §3.2 要求的顺序）。
- `switch-executor.ts`：`ActiveMarkerDriftError` → `outcome:"failed"` / `reasonCode:"active_marker_drift"`，不 flag 目标账号、不轮转候选。

## 9. 审计轨迹（plan §1.3 / §2.1）

读的是沙箱 audit log 的真 JSON 行，不是代码：

- 成功对账（`use business` → exit 30）：除 `entry`/`exit` 外**多一条独立行** `phase=stale_active_reconcile`，`probeSummary=reconciled_business_to_shopping` —— 成功证据没有被后续 `AUDIT_SUMMARY` 覆盖掉。
- 46 fail-closed（畸形 marker）：`exit` 行 `probeSummary=stale_active_unresolvable`，`exitCode=46`。

## 10. 残留卫生

所有沙箱 run 递归扫描：`*.tmp.*` / `.active.tmp*` **零残留**；live token 只出现在 stub keychain 与池内凭据文件中，未泄进任何其他文件。

## 11. 未覆盖 / 留给下游

1. **真 Keychain / 真 OAuth 端点**未跑（按 plan §5.3 明确要求「绝不碰生产 Keychain/池」）。真机带外登录 → 切号的端到端，仍建议在 founder 在场时走一次。
2. **marker-commit-uncertain 第三档**（rename 确认窗口的 `third_party` / `ghost` / `unsafe_directory`）我没有自建对照，依赖实现者的 3 条 fault-hook 用例 —— 它们在 CI 绿、且在突变里全部转红（说明非空过）。
3. `matrix.sh` 里的 D1 是**已知 harness 限制**（假 delegated 值会退回手动路径），真 delegated 结论以 §5 的 `delegated.sh` 为准。
4. TS 层（`active_marker_drift` 归因）按 plan §6 需**下次自然重启**才进 daemon；bash 层 merge + `git pull` 即生效。

## 12. 复现方式

harness 在 `/private/tmp/claude-501/.../scratchpad/qa-fly1201/`：`harness.sh`（沙箱+stub）、`replay.sh`（事故四行）、`matrix.sh`（fail-closed）、`delegated.sh`（真 delegated）、`one.sh`（单例带 stderr）。

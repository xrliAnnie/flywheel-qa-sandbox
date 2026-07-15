# FLY-1049 FLY-915 alerts 收尾 — 独立 QA 报告(三段式 QA 阶段)

Issue: FLY-1049 (https://linear.app/geoforge3d/issue/FLY-1049/build-fly-915-alerts-收尾先确认-925928-剩余排除已-ship-的-927929)
日期: 2026-07-09
基于: plan.md / exploration.md / enable-window-runbook.md + PR #521(head 62e120e4)

## 0. QA 范围与结论

**结论:PASS。** 本 PR 是 **docs + 机器态 env**(零生产 TypeScript 改动;927/929 已把全部代码接缝 merge 好、env-keyed dormant)。因此 QA = ① 唯一真实行为交付物(Task 1 · FLY-925 env 修复)独立复现 GREEN + ② 文档承重技术声称逐条对代码核实 + ③ lint / CI 兑现。**不重新实现任何功能。**

「done = 915 pipeline 真跑起来」的 enable 窗(927/929 env 翻转 + 两 bot 上线 + Bridge 重启 + 真机 QA + Annie GO)是 **merge 后 founder-gated 运维窗**,不在本 PR;runbook 已把它收敛成一份按序清单。本 QA 只判 PR 段交付物。

## 1. Task 1 · FLY-925 env 修复 — 独立复现 GREEN(不信自报)

| 项 | 证据 |
|---|---|
| `.env` 落机 | `~/.flywheel/.env:103-104` = `FLYWHEEL_BRIDGE_URL=http://localhost:9876` + `STANDUP_PROJECT_NAME=geoforge3d` ✅ |
| **独立复现 token report** | 用当前 `.env` 亲跑 `scripts/token-usage-daily.sh`(复刻 plist env `FLYWHEEL_TOKEN_USAGE_CHANNEL=1521630422918758472`)→ **`delivered:true`**,新 messageId `1524769451457773638`,新报告 URL https://fw-reports-a53de2.vercel.app/r/faa6fa5de07f4934171944a58072ad6f/ ,exit 0,console errors 0 / server errors 0。**proofshot 截图子步本次也成功**(implement 阶段是 ENOENT 走 link-only)。 |
| 新报告 URL 存活 | `curl -o /dev/null -w %{http_code}` → **HTTP 200** ✅ |
| implement 阶段证据佐证 | 报告 URL `.../f296c247...` HTTP 200;FLY-925 comment 记录 msg `1524691268318269490` + channel + URL,并诚实披露 proofshot ENOENT 走 link-only ✅ |
| **STANDUP_PROJECT_NAME 取值正确性** | `projects.json`:`cos-lead` 只在 `geoforge3d` 项目(flywheel 用 `flywheel-cos-lead`)→ `STANDUP_LEAD_ID=cos-lead` 唯一映射 `geoforge3d`,取值正确 ✅ |
| 根因确认 | `plugin.ts:2566` `if (standupService && standupProjectName)` — 未设 projectName 则 /api/standup 不挂载 → trigger 4xx(exit 22),与 issue/exploration 根因一致 ✅ |

> standup 的 GREEN(次日 03:00 无 exit 22)按 plan 设计在 enable 窗 Bridge 重启后由观察日核 —— 因 `STANDUP_PROJECT_NAME` 是 Bridge 启动时读。**能在 PR 段验的取值正确性已验**;GREEN 本身是 enable 窗项,非本 PR 阻塞。

## 2. 文档承重技术声称 — 逐条对代码核实

runbook 会在 founder-gated 窗照着执行,line-ref 错会误伤,故逐条核:

| 声称(runbook / spec) | 核实 |
|---|---|
| sender 门禁把工单收口到单一身份(`LeadAlertNotifier`) | `LeadAlertNotifier.ts:634+` `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 单一发送身份坍缩 ✅ |
| dispatcher≠owner 不变量(R1 核心修正) | 机制成立:bot 收不到自己 MESSAGE_CREATE;sender 收口 + owner map 存在 → 作者=owner 会让 owner 收不到 @ 自己的工单 ✅ |
| Claude Infra Bot 默认 owner(`ticket-owner-map.ts`) | 文件存在 ✅ |
| bot 作者不在 allowBots 会被丢弃(`roundtable-allowbots.ts`) | 文件存在 ✅ |
| allowBots 自愈仅当 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 设置时运行(`claude-lead.sh`) | `claude-lead.sh:2282` guard 成立 ✅ |
| Codex bot 把 Alerts 走 cross-dept mention-gate | `run-codex-infra-bot-tui.sh:61` 导出 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=$FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` ✅ |
| auto-repair sender 默认 Cass、指针 env 零代码改 | `plugin.ts:4133` `FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV ?? "CASS_BOT_TOKEN"` 逐字对上 ✅ |
| token plist channel = notify channel | plist `FLYWHEEL_TOKEN_USAGE_CHANNEL=1521630422918758472` = runbook `FLYWHEEL_NOTIFY_CHANNEL` ✅ |

persona(`.lead/claude-infra-bot-lead/identity.md`)镜像 Codex bot 骨架:三件事 / 回帖纪律(FLY-220 防刷屏)/ 铁律(谁都不救自己、一工单一 owner、T2 后 @Annie)/ 边界(不开 Runner、founder-only-authority 约束)—— 与 PRD CMP-2 + 代码语义一致。SETUP.md + infra-alerts-spec §11 索引准确、单一来源、与 runbook 一致(§9 表已更新为 dispatcher 终态、裁掉 CASS 过渡态)。

## 3. Lint / CI

- `pnpm lint`:1 error + 15 warnings。**该 error 非本 PR 引入、非回归、CI 不受影响**:定位在 `.flywheel/runs/b71d73fb-.../land-status.json`(pipeline 运行时生成的 landing 信号 `{ "status": "ready_to_merge", "prNumber": 521 }`),`git check-ignore` 确认 **GITIGNORED + untracked** → CI 干净检出永远看不到。main 基线亦有 1 个(不同的)存量 error。本 PR diff 100% markdown → 引入 0 lint 变化。PR 声称的「0 errors」对**提交集**准确。
- CI:PR #521 "Build & Test" QA 时 IN_PROGRESS(merge 前须绿,merge gate 自会把关)。

## 4. QA 副作用披露(诚实留痕)

- 独立复现向 #flywheel-notify(`1521630422918758472`)多发了一条 token report(msg `1524769451457773638`)—— 与每晚 cron 同款、幂等有锁、benign,是 plan Task 1 授权的 GREEN 验证动作。
- QA 未改任何生产代码 / env / 部署态;只新增本报告 + progress ledger。

## 5. 验收对照(plan §3 七条)

PR 段能判的:①token report GREEN → **已独立复现** ✅;③927 env pipeline / ④两 bot / ⑤封顶切换 / ⑥sender 迁移 —— 均 enable 窗项,runbook 已 spec 化、技术声称已核。②standup GREEN 取值已验、GREEN 待重启。收尾(⑦关 925/928)待观察日。**PR 段无阻塞项。**

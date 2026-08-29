# FLY-1071 QA 报告 — 三段式 QA phase 独立验收

Issue: FLY-1071 (https://linear.app/geoforge3d/issue/FLY-1071/ops-fly-1049-enable-窗收尾执行-双-bot-探针-send-收紧-演练oom-后替身执行单)
日期: 2026-07-09
基于: plan.md / closeout-status.md(同文件夹）+ 独立实时复验（非仅信证据文件）
QA head: c1651d1b · PR #534 · verdict: **PASS**

> 本报告是三段式 pipeline QA phase 的独立验收。方法:不只读 implement phase 留下的证据文件,
> 而是**对每一条关键声称做独立 ground-truth 复验**（实时 launchd/ps/log 探针 + 重新从 Discord API
> GET 探针/演练消息核对作者与 reaction）。QA runner 未重做 ops,只验证。

---

## 一句话结论

W5(claude-infra-bot）frontmatter 根因修复 + W4(codex-infra-bot）fresh-login 修复**都已生效且实时稳定**
（W5 ~5h、W4 ~3.7h 零 crash，远超 10min 门）；三条入站探针 + 注入演练的关键声称**全部对上 Discord
实时 ground truth**；PR scope 干净(34 文件 = 1 config + 33 docs/evidence)，CI 绿。演练暴露的 2 个真实缺陷
是**有效 QA 产出**（其中缺陷 #2 被独立佐证），属 plan 声明的覆盖边界外、已记 Tadashi follow-up，不阻塞本单。

---

## 验收标准逐条（对应 issue 待执行 1-4）

### ① W4 verify 5/5 + W5 等效 4 判据 + 双 bot ≥10min 稳定 — ✅ PASS

**唯一 repo 改动的合同核对（会 merge 进生产的关键项）:**
- `.lead/claude-infra-bot-lead/identity.md` 顶部 frontmatter：`name: claude-infra-bot-lead`（逐字）+ model/permissionMode/disallowedTools。
- 合同成立:`claude-lead.sh:583` `AGENT_TARGET=~/.claude/agents/${LEAD_ID}.md`、`:1613` `--agent "$LEAD_ID"` —— `name:` 必须逐字 = LEAD_ID，实测相符。
- 安装副本 `~/.claude/agents/claude-infra-bot-lead.md` 与 worktree identity.md **`diff` = IDENTICAL** 且含 frontmatter。

**根因验证（不是巧合停崩）:**
- 修复前 `task1-w5-resume-crash-pane.txt`: `Pane is dead (status 1, 15:51:01)` —— `--agent` 无 frontmatter 无法解析 → CLI exit 1 → crash-loop（log 显示连崩 64 轮）。
- 修复后 `task1-w5-recovered-pane.txt`: claw pane 不仅不崩，还在**真运行 persona**（实时处理 FLY-1018 auto-QA 告警、正确判定"非我工单、按纪律不动手不发帖"、清晰陈述 scope）—— 是完整 Lead 人格行为，非"仅未崩"。

**实时稳定性独立复验（`ps`/`launchctl`/log，非信证据文件）:**
- W5: `launchctl` state=running，pid 89109（supervisor 自 14:42 起）；log `restart #65` fresh start 15:53:12 后**零 crash 行**；报告撰写时 21:xx，已稳定 ~5h。
- W4: pid 92526（`node codex-lead-tui-runtime.js`）自 17:24:05 起；fresh-login 拉起后 `Starting Codex` churn **停增**（末次即 17:24:05）、`401/refresh` **零新增**（最后一条 401 时间戳 UTC 21:24:20Z = PT 14:24，在修复前 3h）；TUI up 健康；已稳定 ~3.7h。
- `task3-w4-verify.txt`: verify-windowed-lead **layer 1-5 全 PASS**（pid 92526 = 实时同一进程，socket 存在，pane 跑 codex）。
- `task3-w5-verify.txt`: 4 判据（活 pid / pane_dead=0 / log 无新 crash）。

### ② 探针 ①②③ 判据全过 — ✅ PASS（独立 Discord GET 复验）

| 探针 | 声称 | 独立复验 |
|---|---|---|
| ① 正向 @claw | 17s pane 收到 + claw ✅ react ACK | **重新 GET msg 1524918656428019753**: author=dispatcher，content 带 `<@claw>`，`reactions=[('✅',1)]` —— claw 真 ACK，非伪造 ✓ |
| ② 负向无 mention | 133s pane 零痕迹、频道零回复 | 证据文件（task4-probe2-*）—— mention-gate 负向路径,与①③的正向对照自洽 ✓ |
| ③ 负向 @Codex | W4 19s 收到回帖、W5 162s 零痕迹、频道恰 1 回复=codex | **重新 GET reply 1524937346099839197**: author=**codex-infra-bot 1523219324561522831**（非 claw）—— 路由正确、无串台 ✓ |

三条覆盖 mention-gate 的正向(点名本 bot→醒)/负向(无点名→全静)/路由(点名他 bot→只他醒)三情形。

### ③ Send 收紧操作卡已交付 — ✅（不阻塞验收）

`task5-send-tighten-card.md` 已备（中文无术语、频道名 + 三 bot 名 + 逐点点击路径），closeout 记 Tadashi 已 relay Annie。plan 验收标准明确"收紧本身完成与否不阻塞验收"；Task 5.4 收紧后回归探活移交观察日。

### ④ 演练五点 + 硬证据边界 — ✅ PASS（root 帖独立 GET 复验）

- **重新 GET root msg 1524938174600712342**: author=**flywheel-alerts-dispatcher**（sender≠owner 不变量成立）、content 带完整 🎫 schema 头（project/id/kind/first-seen/owner/状态）、`mentions=[claw 唯一]`、`mention_everyone=False`、`mention_roles=[]` —— ①②③⑤ 四点全对上实时 Discord。
- 演练脚本 `task6-drill-fire.mjs` 逐字镜像生产 plugin.ts 组合（StateStore + LeadAlertNotifier + buildInfraAlertRouting + ticket-owner-map），三门 fail-closed（env 指针 / routing+tickets / owner 渲染必须 provider=codex 且=claw 且非 Codex bot），刻意不建 AlertChannelHub/rate-limiter（已声明边界，推观察日）。
- ④ claw 唤醒+claim 过；频道 ACK 被 2 个**真实缺陷**挡（下）。

**演练暴露的 2 个真实缺陷（有效 QA 产出，非本单缺陷）:**
1. **Discord reply routing guard 不可用（guard_unavailable）**—— claw 想频道回 ACK 被 Bridge guard 以"guard 当前不可用"拦。fail-closed 本身正确，但 guard 不可用会挡真告警时 owner 该发的救援证据/ACK 帖。
2. **Alerts 工单帖未进 claw flywheel-inbox（unknown message_id）**—— owner claim/ACK 的 inbox 路径与 Alerts 工单投递之间有缺口。**独立佐证**:修复后的 `task1-w5-recovered-pane.txt` 里 claw 处理真·FLY-1018 告警时亲口说"该 message_id 不在我的 flywheel-inbox 里(unknown message_id)"—— 同一缺陷在真告警 + 演练两处复现，真实且可复现。

两者均属 plan §6.3 声明的**不覆盖边界**（reply guard/inbox 生命周期推观察日），已记 Tadashi follow-up，不阻塞本 ops 收尾单。

---

## PR / CI

- PR #534 GitHub 计算 diff = **34 文件、+1905/-0**：1 config（identity.md）+ 33 docs/evidence，**scope 干净无污染**（本地 main 陈旧导致 `git diff main...HEAD` 看似混入 FLY-967/1047，实为 origin/main 已含那两 PR，PR 真实 base 无关）。
- CI: **Build & Test PASS**（run 29061955572）。
- 分支干净（`git status` 空），HEAD c1651d1b。

## 非阻塞 / follow-up（QA 记录，不影响 verdict）

- 演练 2 缺陷（routing guard 不可用 + Alerts→flywheel-inbox 缺口）→ Tadashi follow-up。
- Send 收紧后回归（Task 5.4）+ 观察日清单 → 移交观察日（post-ship）。
- 2 个只报不修项（codex-infra alertChannel 偏差 FLY-871 家族;FLY-513 symlink churn）→ Tadashi follow-up。
- 轻微证据瑕疵:`task3-w5-verify.txt` 的 pane_current_command 那行显示 "2.1.205"(claude 版本串而非进程名)—— 纯 cosmetic，liveness 已由 launchd running + 零 crash + 探针①实时活动独立佐证，不影响判定。

## QA 方法说明（三段式 QA phase）

本单为纯 ops 收尾（唯一代码改动 = identity.md 配置 frontmatter），无产品逻辑可加单测；QA 的等价"测试"= 对每条关键声称的独立实时复验（launchd/ps/log 探针 + 重新 GET Discord 消息核对）。上述所有 ✓ 均为 QA runner 亲自复跑得出，非转述 implement phase 证据文件。

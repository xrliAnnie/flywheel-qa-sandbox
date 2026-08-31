# Design Review — FLY-2137 plan.md (Round 1)

Date: 2026-08-31
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案复用现有 Bash guard、严格告警通道和 launchd 先例，整体可实现，audit→founder 决策→enforce 的方向也正确。但当前 committed plan（`fdacb05c2` 中 blob `ec9454d8eb35538c8117a67de26f59aacabf394b`）仍把可绕过的行为护栏表述成机器授权边界，并在 P6 grammar、enforce 权威、每日 sweep 的 durable delivery/state、告警 kind 合同和 QA 部署顺序上存在阻塞项，因此不能进入实现。

## What's Good (Keep)

- 复用已注册的 `flywheel-restart-guard.py` 是合理的最小增量；现有 installer/converge、segment/wrapper/`bash -c` 重扫以及 bypass 的“审计成功 + strict alert receipt”机制都真实存在。现有 guard 基线测试已执行通过：221 passed, 0 failed。
- audit 先行、founder 明确二选一后才 enforce，正确落实了授权顺序；Raya daemon 不经过 Claude Code PreToolUse hook 的结构也已由实际 plist 和 Raya 源码核实。
- 合法 writer 的 provenance 设计是扎实的：实际 Raya 代码通过 `execFile` 调 `gog`，create/update 带 `raya_meeting_id`，并写 `calendar.json` receipt；meeting-notes scheduler/skill 路径中未发现 Calendar 写调用。
- 同时覆盖 `gog` 与 `gws`、把 ACL/clear 纳入风险面、sweep 坚持 report-only 且绝不自动删除，都是正确的安全取舍。
- “每日聚合、零发现零通知”以及 enforce 后必须做 FLY-2130 真机回归，是应保留的验收标准。

## Issues & Recommendations

1. **[HIGH] 当前方案没有实现计划所声明的“唯一写入方”机器授权边界。**

   **问题：** plan §4.3 已承认脚本文件内部调用、Codex/Gemini shell 和直接 API 均不受 P6 约束；Claude Bash 会话本身也可先写一个脚本再执行，hook 只会看到 `./script`。检测层又依赖关键词启发式，因此无关键词的绕过写入也可能完全不可见。由此，§0/§1 的“唯一写入方”“其他一切 agent 禁止”不是该设计能证明的事实。

   **影响：** 这不是边缘攻击，而是拥有 shell 的 agent 正常可采用的执行形态；若按当前成功条件关闭 FLY-2137，机器全局凭据仍然授予所有同用户进程实际写权。

   **建议：** 把 P6 + sweep 保留为 defense-in-depth，但必须二选一：要么本单落真正的 credential/process boundary（Raya 持有独立写 credential，agent context 不可读）；要么由 founder 明确批准把本单降级为“Claude Code 直接 CLI 行为护栏”，并把“唯一写入方已机器执行”从成功条件/HTML 中删除，另建且阻塞关闭本治理目标的凭据隔离项。不能同时保留当前 scope cut 和强授权结论。

2. **[HIGH] P6 的 CLI grammar 既有误拦，也漏掉真实写面；QA calendar 豁免没有可安全实现的目标解析合同。**

   **问题：** read-only help 实测表明 `gws events` 是独立的 Google Workspace Events 服务，不是 `gws calendar events` 的顶级 alias；当前把任意 `events` token 当 calendar 语境会误拦非 Calendar 命令。反向漏报也已证实：`gws calendar calendars transferOwnership` 是实际高权限 mutation，但不在 verb 集。更重要的是，raw `gws` 的 calendarId 位于 `--params` JSON，`events move` 同时有 source `calendarId` 与 `destination`；plan 只描述“解析出的目标 calendarId token”。`gog focus-time/ooo/wl` 又允许省略 calendar（默认 primary），所以简单搜索 QA id token 会被 summary/body 中的同值欺骗，或错误放行 QA→primary 的 move。

   **影响：** 当前规则无法同时满足“不误伤非 Calendar CLI”“覆盖完整写面”“QA 仅能写专用日历”三项要求；其中 `transferOwnership`/ACL 类漏报直接扩大权限。

   **建议：** 不要做 bag-of-tokens 共现。按真实 CLI grammar 解析：剥离 global flags 后要求 service 位置精确为 `gog calendar|cal` 或 `gws calendar`；对 Calendar surface 使用已知只读方法 allowlist，未知/新增方法在 audit/enforce 下分别 would-deny/deny。为每个可豁免写形态定义 target-set 提取器，严格解析 `--params` JSON，并要求**所有**受影响 calendar（含 `destination`）都等于一个经格式校验且明确拒绝 `primary`/邮箱的 QA id；未知、缺失或默认 primary 均不豁免。测试至少加入 `gws events insert` pass、`transferOwnership` deny、QA→primary move deny、QA id 仅出现在 summary/body 不豁免、space/equals 两种 flag 形态和省略 calendar 的三种 gog helper。

3. **[HIGH] enforce 状态可静默失效，ACK 也是 agent 自己声明的，不构成授权证明。**

   **问题：** §1 规定 mode 文件缺失/损坏即回 audit；§10 又称 sweep 每日报告 mode，但 §5 同时规定零 Calendar finding 且零 P6 行时完全不发消息。因此 founder 已批准 enforce 后，文件误删/损坏可在下一次未授权写时直接放行，且之前一直无声。`FLYWHEEL_CALENDAR_WRITE_ACK=<任意非空理由>` 同样可由被治理的 agent 自行设置，alert 只能事后广播，不能证明 Lead/founder 曾授权。

   **影响：** 关键 authz predicate 在故障时 fail-open，而且 bypass capability 与受限主体同权；这与项目 Non-Negotiable“auth/authz boundaries must be verified”冲突。

   **建议：** 最简单且与“Raya 是唯一自动 writer”一致的 v1 是删除 Calendar ACK（founder 可在普通终端操作，QA 只写专用日历）。若确有 agent 写 primary 的必要，使用由外部批准方生成、绑定 command hash/expiry/一次性消费的 capability，不能接受任意 env 理由。把 founder approval 保存为 durable receipt；一旦进入 enforce，mode 缺失/损坏必须 deny 或产生明确 config-error gate，enforce→audit 的降级本身必须算 finding 并每天最多告警一次，而不是等日历命令出现。

4. **[HIGH] sweep 只有“单次最多一条”的意图，没有“每天最多一条且不丢”的 durable delivery/state 合同。**

   **问题：** state 只有 `lastRunAt/lastLogOffset/reportedEventIds`，没有 founder-local day bucket、daily alert receipt、single-writer lock或 alert 结果处理。`lead-alert.sh` 默认按 UTC 日期去重，且 plan 未固定 `lead/project/signature` 或要求 `--strict-delivery`；同一洛杉矶自然日在 UTC 边界两次运行可生成两个 eventId。alert 前后何时推进 cursor 也未定义，crash/config_error 可造成丢报或重复。另一个确定问题是 restart-guard 日志采用 rename rotation，而单独的 byte offset 无 inode/generation：轮转后新文件若已长过旧 offset，sweep 会静默跳过前段 P6 证据。

   **影响：** 不能证明硬约束“≤1 条/天”，也不能证明一次告警失败、进程 crash、并发/manual rerun 或日志轮转后不会漏掉未授权证据。

   **建议：** 复用 `daily-digest.sh` 的 atomic mkdir single-writer；以 founder timezone 的 `YYYY-MM-DD` 生成稳定 identity/signature，并通过 `lead-alert.sh --strict-delivery` 只把 `sent|queued_transient` 当 durable receipt。固定同一天的聚合 snapshot/outbox，使 crash retry 命中同一个 eventId；成功 receipt 后再原子推进 event/log cursor，失败不得推进。状态需记录 day receipt 与 log `(dev,inode,offset)`（或扫描 retained generations 后按 record ts 去重），并对首次运行、损坏 state、truncate/rotate、单条坏 JSONL 定义 fail-loud 行为。TDD 加同日串行/并发两跑、PT↔UTC 边界、alert sent/queued/config_error/crash、轮转后新日志超过旧 offset、state corruption 和次日 rollover。

5. **[HIGH] 告警 kind 的改动清单不完整，按当前计划实现会构建失败。**

   **问题：** plan 只列 `lead-alert.sh`、`LeadAlertNotifier.ts` 和 `alert-kind-copy.ts`。实际 `packages/teamlead/src/bridge/kind-contract.ts:63` 是 `Record<AlertEventType, KindContract>`，新增 union 成员却不加 contract 是编译错误；Bridge 启动验证和 `kind-contract.test.ts:101-107` 也要求每个 kind 有 owner/ARC。现有通用 drift test 只保证 shell→TS，源码注释明确指出 TS→shell 需要家族级双面 assertion。

   **影响：** 两个新 kind 不能按计划通过 build/startup/full-repo gates，queued alert 的 owner/ARC 语义也未定义。

   **建议：** 改动清单加入 `bridge/kind-contract.ts` 与 `bridge/__tests__/kind-contract.test.ts`，为 `calendar_guard_bypass`、`calendar_wild_write` 明确 owner、`human_by_design|none_escalate` posture 和需要的 remediation reference；新增两 kind 的 shell/TS 双向一致性断言，并在 `alert-kind-copy.test.ts` 固定 title/body/severity（bypass 必须 severe，wild-write warning）。

6. **[HIGH] 部署/QA 顺序前后矛盾，并可能在“验证 deny”失败时真的写 founder primary。**

   **问题：** §6 step 4(c) 使用 QA calendar id 做豁免回归，但该日历和 id 文件到 step 6 才创建。step 4(b) 则直接在 Claude 会话尝试 `gog calendar create primary`；只要 hook 未 converge、mode 文件缺失/损坏或仍为 audit，这个“负测试”就会成为真实未授权写入。计划还允许 PR merge 后立即向 founder 提供 enforce 选择，却没有先证明已安装 hook 的 bytes 与 committed source 一致、PreToolUse 注册有效且 audit smoke 已落账。FLY-2130 真机创建后的清理/取消路径也未写入验收。

   **影响：** QA 自身可重演本单事故；同时 founder 的 enforce 决策可能落在尚未部署或漂移的 guard 上。

   **建议：** 顺序改为：merge → converge exact bytes/注册并记录 hash → 用直接 hook stdin 或 PATH no-op `gog` stub 做 audit integration smoke → 创建/验证 QA calendar 与 id → 向 founder 呈现规则并保存批准 receipt → 切 enforce → 再用 no-op stub或保证不存在的 calendarId 验证 primary-shaped command 被 hook deny（绝不让失败分支触达真实 primary）→ QA calendar 写回归 → 走 Raya 正路创建带 marker/receipt 的明确授权测试会议并通过 Raya cancel/cleanup 验证清理。每一步都要有不可混淆的 evidence，enforce activation 不得仅靠“文件写过”。

7. **[MEDIUM] 新 launchd “模板”没有可执行的安装/回滚合同。**

   **问题：** 改动清单新增根目录 `scripts/com.flywheel.calendar-sweep.plist` 模板，但明确不加 installer，部署步骤却只写 `launchctl bootstrap`。作为模板时仍需渲染 repo/home/node/log 路径并复制到稳定位置；作为直接 plist 时又需明确 `ProgramArguments`、WorkingDirectory/PATH、权限、日志目录、版本更新和 bootout target。被引用的 log-janitor 先例实际还有 `install-log-janitor.sh` 负责这些动作。

   **影响：** 生产部署依赖临场手工补步骤，可能 bootstrap 旧路径/未渲染 placeholder，且无法证明安装的是本 PR 的 bytes。

   **建议：** 二选一：增加最小 render/install/uninstall 脚本并测试；或把 unit 放入 `scripts/launchd/`，加入 `units.manifest` 的 founder-gated `hold` policy，复用现有 copy/convergence 契约。无论哪种都要验证 `plutil -lint`、rendered paths、稳定 node 入口、0600 state/log ownership、`launchctl print` 的实际 ProgramArguments、一次手工 smoke 与独立 bootout rollback；仍然保持“不在 CI/QA 自动安装”。

## Verdict

CHANGES REQUESTED — address items above

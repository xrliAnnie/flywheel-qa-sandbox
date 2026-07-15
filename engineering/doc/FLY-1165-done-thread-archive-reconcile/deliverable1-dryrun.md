# FLY-1165 deliverable 1 — done-thread sweep report

- Mode: DRY-RUN
- Channel: 1516209714097291335
- Started: 2026-07-11T07:22:05.622Z
- Finished: 2026-07-11T07:22:15.784Z

## Summary

- **archived**: 0
- **would_archive**: 28
- **skipped_active**: 6
- **skipped_live_session**: 1
- **would_finalize**: 7

## would_archive (28)

- FLY-583 — [bug] Belle 回复哑火：起草了回复但不调 discord:reply 工具发 → Annie 收不到（只有 Belle，FLY-574 后复发） [thread 1519874200037363905]
- FLY-599 — QA · FLY-583 — discord-reply prompt 3-bot eval 测试台（漏发率 + 人性化，Claude-in-Chrome，529 Room） [thread 1520160161635762357]
- FLY-631 — QA · FLY-560 — tmux-attach 置顶 real-machine 验证（529 Room：置顶存在 + 格式 + 命令能 attach + 真 pin 403 解） [thread 1520515078418464838]
- FLY-636 — QA · FLY-626 — state-aware stall 看门狗 real-machine 验证（529 Room：classifyQuiet 分类 + park/busy marker + backoff + stuck 保留 + FLY-324/253/369 没破） [thread 1520566415281619110]
- FLY-663 — sql.js / StateStore WASM 损坏的【真根因】—— 为啥会损坏（不只 639 抗崩） [thread 1521028653083787265]
- FLY-712 — QA · FLY-541 — 独立验证 DR skill 全链真机 E2E（flyview-skills PR #13 @ 8ac11a3） [thread 1521573281130614935]
- FLY-723 — QA · FLY-541 re-test — headed-browser DR 全链 E2E + binding 稳定性（commit 841217a / PR #13） [thread 1521664785962504316]
- FLY-733 — QA · FLY-293 — 独立验证 orphan cmux-pin reaper（PR #404、隔离 orphan→reap、活的不动、fail-closed） [thread 1521778940891500657]
- FLY-742 — Cron silently blocked forever by a done-but-uncleared runner session (2nd occurrence) [thread 1521955578665242865]
- FLY-748 — QA · FLY-742 — Cron silently blocked forever by a done-but-uncleared runner session (2nd occurrence) [thread 1522021591385505853]
- FLY-739 — QA · FLY-727 — [founder-UX] Daily digest — 每天一条『今天谁完成了啥』（fleet-wide 完成汇总） [thread 1522033735128842322]
- FLY-756 — [infra] cmux-sync heal/reopen 注入竞态 → runner pane 里出现 nested-attach 报错（sessions should be nested with care） [thread 1522076142910181478]
- FLY-761 — QA · FLY-752 — [infra·P0] Auto-QA 重复 spawn 是错的 — 一个 issue 一个 QA + fix-loop 复用 + 铺到所有项目 [thread 1522117728142495887]
- FLY-767 — [728-phase2] 强制 Lead 分拣 — 没 tag 的 issue 派发前必过 Lead 模型判断，判不了才落 default（Lead 判断、非 ML classifier） [thread 1522253699743744143]
- FLY-792 — QA · FLY-752 — verify auto-QA dedup: 一个 issue 一个 QA + fix-loop 复用 (529 Room) [thread 1522317132023468083]
- FLY-794 — QA · FLY-766 — [infra·P0] claude-in-chrome QA 会话是内存尖峰真根 — Chrome 生命周期回收 + 并发上限（751 覆盖不到） [thread 1522366519785291868]
- FLY-786 — QA · FLY-756 — [infra] cmux-sync heal/reopen 注入竞态 → runner pane 里出现 nested-attach 报错（sessions should be nested with care） [thread 1522367018865524756]
- FLY-796 — QA · FLY-751 — [infra] Runner memory footprint 太重 → 20G swap 撑爆(runner memory slimming） [thread 1522368134189813830]
- FLY-814 — QA · FLY-807 — 验证 auto-QA 的 QA thread 按 label 路由到对 Lead 频道 + @founder(不落 #core) [thread 1522534368860700804]
- FLY-826 — QA · FLY-793 E2E — 529 Room 真机跑通三段流程（Design→Implement→QA 分 3 runner + 3 phase-thread），founder 可见，793 merge 前必过 [thread 1522721732845375659]
- FLY-866 — QA · FLY-793 — three-stage pipeline 真机 E2E（529 Room）：真 issue 拆成 Design→Implement→QA [thread 1523069080217583861]
- FLY-901 — 产品 Lead 派活路由问题:product 部门 Lead 自动派活够不着「产品/设计」执行器角色 [thread 1523712888483872798]
- FLY-903 — QA·E2E · FLY-898 core-room 纪律 — 529 Room 真 Discord 端到端（no-@→只 CoS / 裸名不达 / 真@达） [thread 1523715488952225792]
- FLY-913 — [infra·guardrail] 部署护栏 — PreToolUse hook 硬拦手动 Bridge/lead 重启，物理强制走 restart-services flow [thread 1523777181812129792]
- FLY-944 — [bug·routing] shared 频道 reply-gating 漏掉 lead-to-lead @-mention — 只有 founder 消息触发（今晚 HL 的 FSM @ 漏收、要 founder 手动 relay） [thread 1523893594740756642]
- FLY-968 — [voice·research] 实时语音模型选型横评 — OpenAI Realtime vs Gemini Live vs 其他 + multi-session per-Lead 声线可行性 [thread 1524139853313216544]
- FLY-1041 — Founder-approval binding glitch — thread reply won't bind to gate under multi-gate ambiguity (blocks ship) [thread 1524654765496340530]
- FLY-1049 — build · 告警系统收尾（token report 修复 + Infra Bot 物料 + 统一上线 runbook） [thread 1524678903493558292]

## skipped_active (6)

- FLY-718 — 看门狗 per-project 真实 runtime 状态核实 + 统一启用 + 可见性（Annie: 其他项目感觉没 enable） [thread 1521656084694044765]
- FLY-962 — [bug·display] issue thread 标题不显示阶段线（🎨设计✅·🔨实现▶·🧪QA◾）— 892+907 已上线仍不翻，founder 看不出在哪个阶段 [thread 1524090798872858694]
- FLY-1062 — build · Buddy onboarding 分发层 — 客户 npm install 安装包，零仓库访问（替代 curl→git clone） [thread 1524854276159963136]
- FLY-1073 — build · FLY-1048 PR-B/PR-C 续跑 — #525 重开 gate + PR-C 统一升级流实现（OOM 后替身单） [thread 1524898596816818226]
- FLY-1159 — [voice·B] /gemini-advanced 语音接线（route A）— delegate 挂 /gemini 引擎 [thread 1525349094367690793]
- FLY-1165 — [infra·cleanup] 扫清 #flywheel-engineer 已完成但未归档的 thread 积压 (~48) + 根因修 auto-archive-on-Done 不可靠 [thread 1525385691884814397]

## skipped_live_session (1)

- FLY-1160 — [voice·架构] 统一常驻 Claude Session 大脑 — 每场对话一个持久 session（仅 /glaw + /eleven）+ 会后纪要落地 [thread 1525343649251070012]

## would_finalize (7)

- FLY-756 — [infra] cmux-sync heal/reopen 注入竞态 → runner pane 里出现 nested-attach 报错（sessions should be nested with care） [thread 1522076142910181478] (682c5100-a07e-4619-8217-b8ee38f6887f)
- FLY-901 — 产品 Lead 派活路由问题:product 部门 Lead 自动派活够不着「产品/设计」执行器角色 [thread 1523712888483872798] (bb40e3cb-ddaf-497f-9180-d662404c2674)
- FLY-913 — [infra·guardrail] 部署护栏 — PreToolUse hook 硬拦手动 Bridge/lead 重启，物理强制走 restart-services flow [thread 1523777181812129792] (6427b222-54f9-467c-92bf-eb46035ef8cf)
- FLY-944 — [bug·routing] shared 频道 reply-gating 漏掉 lead-to-lead @-mention — 只有 founder 消息触发（今晚 HL 的 FSM @ 漏收、要 founder 手动 relay） [thread 1523893594740756642] (9fd568ca-eb9a-40f6-b9a2-0c10a705bb4d)
- FLY-968 — [voice·research] 实时语音模型选型横评 — OpenAI Realtime vs Gemini Live vs 其他 + multi-session per-Lead 声线可行性 [thread 1524139853313216544] (db34a4ea-837b-4990-93eb-cfe92b3f4ee0)
- FLY-1041 — Founder-approval binding glitch — thread reply won't bind to gate under multi-gate ambiguity (blocks ship) [thread 1524654765496340530] (d695d08c-f197-40f4-85fe-20404d678049)
- FLY-1049 — build · 告警系统收尾（token report 修复 + Infra Bot 物料 + 统一上线 runbook） [thread 1524678903493558292] (db288c8e-a1ed-4309-9828-4a577a50f980)

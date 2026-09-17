# FLY-2701 语音按需启动 — 调研
Issue: FLY-2701 (https://linear.app/geoforge3d/issue/FLY-2701/语音按需启动-语音进程平时不常驻开耳机模式-会议到点时才由系统启动空闲后自行退出founder-2026-09-17)
日期: 2026-09-17
基于: plan.md

R1 gate 7edeef52-f88f-4488-8f30-a28e045a38db，request 94c7d167-cb8c-4c69-9ce5-716c9b719c7f，有效CHANGES_REQUESTED。原始结构化结果保留review-r1.json。没有采用overrule。

| findingKey | 处置与最终位置 |
|---|---|
| restart-storm-gate-brakes-on-demand-launches | 接受；§6撤除voice按需路径上的旧常驻boot计数，保留其它service及显式停用；同需求有限失败预算，§10要求6次正常启动及3次失败对照 |
| launchd-throttle-interval-unaddressed | 接受；§6显式ThrottleInterval=1和installer断言；§10测短命退出后多个间隔的真实spawn延迟，不用accepted代替spawn |
| drain-fence-lease-cannot-survive-bridge-stop | 接受；§8 stop前commit持久fence，无自动expiry；跨Bridge停机/新启动/voice刷新持续封门，崩溃需要有证据接管 |
| prewarm-budget-collides-with-60s-ready-alert | 接受；§2预约在T未ready告迟到，明确故障即时告警、正常持续准备不按60秒错报 |
| manifest-setup-policy-has-no-byte-drift-check | 接受；§8新增voice专用contract check共用于setup/census/installer/waker |
| startup-refusal-alerts-on-benign-exit-race | 接受；§6健康旧owner锁冲突留证，2693统一故障源；meta-alert只作源不可用fallback |
| verification-command-list-omits-impacted-suites | 接受；§9完整补converge、host-tmux、storm、新restart-voice suite及CI枚举 |
| no-human-reason-whitelist-not-named | 接受；§7点名allowed-map、ended白名单、live额外reason限制和VoiceEnd |

修订后需新gate/request-review；本处“接受”只是作者处置，不是评审批准。

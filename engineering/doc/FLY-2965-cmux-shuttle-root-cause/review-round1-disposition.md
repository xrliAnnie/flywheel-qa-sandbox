# FLY-2965 首轮评审处置 — 实施计划
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md

R1 effective verdict CHANGES_REQUESTED，request b815ef28-95a7-40e8-8d45-57bcb2d40eea。全部10条已纳入R2，不申请overrule、不把advisory当批准。原始structured findings存evidence/review-round1.json（不含delivery nonce）。

| findingKey | R2处置 |
|---|---|
| patrol-coverage-gap-non-dept-leads | 接受HIGH。保留17/17，逐项列7个dept巡检外目标；撤回patrol替代责任。共享批次采集修性能，先版本/普通派工后全体复核。Lead在question ebebee54-3be9-480e-baf1-207653825040明确同意，要求补锁和耗时，已写。 |
| retry-marker-semantics-change | 保留merge及retry marker全部原语义，包括host-wide cmux absent特例；矩阵F新增失败/未知/空缺/下一班触发断言。 |
| refresh-background-launchd-teardown | 明示best-effort，不能靠长barrier存活；验收K检查受管退出形状和实际watcher/receipt恢复；不可恢复即阻断，不能只靠日志或加等待。 |
| test-inventory-and-ts-contradiction | 明确config truth.ts属于TS改动，补具体config测试/related/build以及host-tmux-selection和4个rescue测试；保留本地只跑具体相关文件政策。 |
| tempfile-failure-rc-mapping | 统一基础设施故障125；禁止默认1触发不存在语义/new-session，加入目录与IO失败负控。 |
| shared-offset-seek-race | 固定fstat长度、os.pread，不seek共享偏移；明确不承诺对并发写的原子字节快照。 |
| secret-argv-at-rest | 明确argv短暂落盘机密面；0600、立即unlink、显式TMPDIR或/tmp，不自动fallback cwd，异常125，无副本。 |
| status-consumer-sweep-naming | 点名Raya rebind和FLY-2264 verifier；保留healthy包含visible原义。核对后者当前total=16，不照抄评审概述17。 |
| nonexistent-do-full-restart | 修为deploy_and_verify及rollback_and_restart。 |
| reserved-session-alert-retirement | 明确退役tmux-qa-residue-flywheel-session，无替代告警；同步旧测试断言。 |

R2仍是设计，未实现/未验修后结果。预计性能区间仅规划，必须同17目标/相近workspace数量对照1051s；不能把超时失败当性能达标。

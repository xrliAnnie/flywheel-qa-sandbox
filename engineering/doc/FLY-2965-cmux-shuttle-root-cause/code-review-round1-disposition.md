# FLY-2965 代码评审第 1 轮处置 — 实施记录
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md

R1 由 `codex:rescue`(gpt-5.6-sol / xhigh,thread `01a0e4b6-5331-7933-957f-846ecadff0c6`)对 `bd0e1473a..f50e0b7bd` 做只读评审,
verdict CHANGES_REQUESTED(1 HIGH / 3 MEDIUM),已用 `review-round code --round 1` 回写 Bridge。

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| 1 | HIGH | 回滚先 `git reset --hard` 再做窗口诊断,batch verifier 从可变 checkout 解析;首次跨本单回滚会落到不认识 `--verify-agents-visible` 的旧 cmux-sync,全体 Lead unproven 并空转到 1320s 期限 | 接受。新增 `pin_restart_visibility_verifier`:回滚在 reset 之前把**正在运行版本**的 cmux-sync 及其按自身目录 source 的 5 个文件复制到临时目录,用已有路径 seam 指向它;副本登记给退出清理,清理循环现在也能删除已清空的登记目录。显式 override 不被覆盖;复制失败只告警,回滚照常。用例:pin 后把 checkout 换成旧版 cmux-sync,pinned 两个 Lead 仍 pass、未 pin 同一调用为 invalid_batch_result;清理后无残留;静态断言 pin 在 reset 之前 |
| 2 | MEDIUM | 首采样全部不合格时 `${#eligible[@]}` 在 Bash 3.2 + `set -u` 报 unbound | 不成立,未改代码:`/bin/bash` 3.2.57 实测空数组 `${#e[@]}` 在 nounset 下返回 0;harness 本身即 `set -uo pipefail`,「全舰读失败 → 无目标进入第二采样」用例原已通过。补强为在 `set -euo pipefail` 子 shell 中执行该用例,作为 errexit+nounset 的直接证据 |
| 3 | MEDIUM | receipt/birth UUID 未进入跨采样投影,同 ref 替换且配套新 receipt 时两次采样各自 pass、稳定性比较也 pass | 接受(计划 J 明确要求 receipt 漂移拒绝 pass)。live 与 live-v2 两条 evidence 行加入 `receipt-uuid` / `birth-uuid`,单目标与批量共享。核查中发现 Runner 标题本已被 authority 的 ledger 哈希覆盖,缺口只在 Lead 标题;回归用例改为 claude-private Lead,稳态 pass、轮换后单目标与批量均 `subject_drift` |
| 4 | MEDIUM | JSON 校验缺 `report`、report 类型、多顶层文档 | 接受。改为 `jq -s`,要求恰好一个对象文档,每项 target/status/reasons/report 类型完整。新增 no_report / bad_report / multi_doc 三种伪造回复;修前三者均被当作 17 个 pass 消费,修后全部 unproven |

## R2

同一 Codex 线程复核 `fee53bf31`:**APPROVED,无 finding**(已 `review-round code --round 2` 回写 Bridge,模型 gpt-5.6-sol/xhigh 与要求一致)。复核要点:pin 在 reset 之前完成且依赖闭包完整、清理顺序文件→目录;空数组争议项关闭;UUID 进入逐目标投影而不引入无关 churn;JSON 消费端与自身生产格式一致;retry marker、confirmed-fail 优先级与 Lead 终态语义不变。
开 PR 后另走 Bridge 登记的 `gate review_code` + `request-review --type code`,以 exact head 为准。

# FLY-2523 自动收尾与额度就绪 — 设计审查
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: plan.md

- Gate questionId: edf3b199-f70c-481f-82f3-9ca1f81d8e67
- RequestId: d7ab6f48-fe2a-458b-9b31-95b9a1896a7e
- 初次 accepted 2026-09-18T06:14:12Z；权威job在06:23:46变failed，failure_reason=no_verdict，reviewer verdict为空。没有有效APPROVED/CHANGES，不将raw输出当批准。
- raw尾段可读意见：DONE/跨单依赖歧义、restart timeout恢复用例、Lead fence范围、drained checker只是必要条件、告警kind consumer sweep。
- 1cee2240c修订§1/T3/T4及必要条件；FLY-2729部署+新token验收硬门保持。当时待答的Lead fence范围问题0d98895d已在下文R1处置中更新。
- 使用相同requestId正式重试返回accepted=true, duplicate=true；不因观察超时另建并行reviewer。
- 首次失败时没有有效reviewVerdict；随后重放取得下文R1结论。当前仍未发布HTML、未phase complete、未操作生产。

## R1正式结论

同request第一次重放最终得到effective reviewVerdict=CHANGES_REQUESTED，reviewerVerdict相同。两项HIGH：raya-lead-roster-divergence、readiness-ready-unreachable-on-host。七项advisory：health-tick-cadence-misread、bounded-run-no-exit-confirmation、inventory-digest-formula-unpinned、keyed-home-no-drain-window、dependency-evidence-not-operationalized、lead-launch-fence-blast-radius、test-suite-name-slip。没有server settled记录。

当前修订：roster单源且与patrol分离；无lease resident增加持久执行/socket强证据，不mint lease；desktop正向credential proof的范围向Lead询问；小时节流、单次process退出验证、digest准确公式与测试名、2729 QA证据schema已补。Lead问题0d98895d已确认保留fence并解释长期漂移需求；此是范围指令，未伪称review-ruling。完整生产activation继续禁止直到所有条件与2729证据满足。

下一次review必须新gate+新request（本次已得到有效CHANGES），与同request处理no_verdict的重放不同。desktop范围答复现已收到，修订后创建R2，身份记录追加在下文。

## R2前范围修订（Lead aa341d63回复）

Lead明确批准改验收范围：桌面凭据权威另单、本单交付注册home就绪证明并原样展示global unknown、开flag移至独立受控动作。FLY-2729证据合同采纳；独立开关仍须2729部署/QA和桌面正向权威。plan已撤activation wrapper/flag-routes改动/本单动态恢复任务，增加双结果JSON、有限证明正向条件、默认global失败exit与显式registered验收模式、runtime继续只读global以及相应反例。HTML和Mermaid源同步。本轮保留R1 finding记录，不把Lead范围答复当server settled。

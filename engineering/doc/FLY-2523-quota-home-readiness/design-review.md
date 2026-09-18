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

## R2有效结论：APPROVED

- questionId: 26854a59-7c17-4fc8-918f-c1f527e2dc98
- requestId: a9182ea3-c0bc-4bdc-aaba-dbaa27156262
- reviewed HEAD: 24919f1f2ef6e3a2dce403381b24200dd5ddc3cd
- round: 2；reviewVerdict=APPROVED；reviewerVerdict=APPROVED。权威job于2026-09-18 07:04:18 UTC为done；failure_reason=null。
- settled=[]；policyNote=medium_low_findings_are_non_blocking_v1。没有HIGH；以下六条是非阻塞建议，未冒充已实现或server settled。有效批准取代R1结论；获批plan与HTML正文不在收尾中改写。

### Follow-ups — 实现交接关注项

| findingKey / severity | 审查证据与建议 | 当前处置 |
|---|---|---|
| resident-evidence-completed-status / MEDIUM | reviewer只读核查24个keyed执行均有home绑定/launchSnapshot/daemonPgid；其中eng_design 9个StateStore completed而CommDB running+phase_keep_alive=1。应按身份与活socket证据归属，不按StateStore status过滤，补正例fixture。 | 交Lead与implement，未改lease语义或活进程。计数为reviewer观察。 |
| resident-tui-client-binding / MEDIUM | TUI是tmux下独立进程，非daemon子进程。应核对remote socket等于执行确定性socket、execution identity与稳定PID/start，补真实形状fixture。 | 交Lead与implement，保留强证据要求，不用env-only推断。 |
| health-callback-vitest-production-reach / MEDIUM | 现有plugin suites会装配health callback。建议测试环境未显式注入隔离state-root/approved-homes/HOME时默认no-op；回归验证reconcile子进程零启动、生产路径零写。 | 明确交接为测试隔离关注项，不能把“注入fixture”一句当现有隔离证据。 |
| collector-global-semantics-change-unstated / LOW | checker算法保持，但共享roster和resident证据会有意改变global collector结果；runtime/launch-binding需覆盖两项变化。 | “原样”指完整保留checker输出与unknown，不表示collector行为完全不变；交回归验证。 |
| digest-localecompare-locale-dependence / LOW | 默认localeCompare受ICU locale影响；建议固定locale或明确跨环境支持范围，跨LANG验证。 | 保留兼容现有digest的约束；若改公式需所有producer/consumer同步，交Lead决定。 |
| lead-launch-fence-blast-radius / MEDIUM | reviewer接受Lead保留fence裁定；锁残留/PID误判仍可能阻挡Lead启动，应保留T3 barrier及旧launcher覆盖未知跳过用例。 | 保留为风险与测试项；不删除fence、不新增Lead重启。 |

六条已通过ask --report报告Lead。APPROVED不等于这些建议已被实现，更不代表生产ready或切号恢复。

## 最终HTML

有效APPROVED后已静默发布并核验：https://fw-reports-42fba7.vercel.app/r/6f025a3d6f35ac79e67b2e72a8f7d5d2/ 。详细HTTP/CSP/source证据见artifact-validation.md。

## 529 slot 返工设计审查

R1 questionId=`4b7c17ac-c60d-4a3f-b427-44f2521f44c1`，requestId=`28fa9948-8e59-4159-9908-1078fcc80ad1`，结论 `CHANGES_REQUESTED`。唯一 HIGH `slot-rider-writes-production-state-root` 指出原返工计划没有把 slot state-root guard 放在 cycle 首次目录/schedule 写之前，也没有 production migration 树零变化证明。修订后的 §14 明确：slot mode 全部坐标先纯只读校验，再允许任何 mkdir/chmod/lock/schedule；Bridge 显式注入 `FLYWHEEL_STATE_DIR=${SLOT_DIR}` 和所有 cycle 路径；driver + health tick 前后递归比较 production fixture/host migration 树的 inode/mode/size/mtime/ctime/digest。

同时吸收非阻塞意见：Vitest filter 改为真实包名 `flywheel-teamlead` 并核对 Tests 数量；production tuple 遇 slot env 泄漏时回落原硬钉；production channel 集合明确为 general/alert/chat；loopback 与 QA 真 Discord REST 反查分开；漂移行号改为符号名加基线约数。R2 必须开新 gate/request，不复用 R1。

R2 questionId=`02993337-40e8-46ee-82ab-b8aea54cb0db`，requestId=`f065b37e-cf90-4474-8a42-3537f5291cc4`，round=2，effective `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`、`settled=[]`。没有 HIGH；四项非阻塞建议已接受并写回计划：slot bot 对生产频道的负向 REST 证据按查询身份记录403/404；`FLYWHEEL_STATE_DIR` 保持 slot contract 单写；生产树零写入证明允许且必须单独归因窗口内合法 hourly health tick；最后一处源码引用补基线说明。APPROVED仅授权本节实现，不是QA实发、生产激活、merge或ship授权。

## 2026-09-18 design 重派审查：APPROVED

- questionId: `6a6559f7-9846-4e46-8d55-1958969fa924`
- requestId: `9941da33-2bbe-4998-8c5d-bd880a0fc70b`；round=1。
- effective `reviewVerdict=APPROVED`，`reviewerVerdict=APPROVED`；`settled=[]`；policyNote=`medium_low_findings_are_non_blocking_v1`。
- 注册时 HEAD=`a06c81df6df66e69ea1452ce5a7851115960fc96`；本轮核对 plan 与新增 design-correction/HTML，保留原两次R2沿革。之后仅补设计交接记录。不是精确头代码审查、QA PASS 或 ship 授权。
- 7 MEDIUM、5 LOW；以下均为审查者报告，作者本轮未重演其fixture，也未改实现。已通过指定 ask --report 全量转交Lead；不把advisory自行升级为阻塞，也不以APPROVED声称实现已满足。

| findingKey / severity | 风险与后续处置 |
|---|---|
| lead-active-lease-blocks-already-satisfied / MEDIUM | 活跃Lead lease先于只读inspect会将已满足记skipped；交实现/QA覆盖C3的已满足+busy与清单digest变化。 |
| pipeline-warning-gated-on-existing-overdue / MEDIUM | 尚未enroll的新home或控制目录失败可能永远无告警；交实现核查fail-loud与warning路径，不把日志当已告警。 |
| kill-switch-enabled-false-is-a-fault / MEDIUM | enabled=false目前可能被判policy_invalid并停掉逾期监控；交实现与§8回滚语义核对。 |
| bare-mkdir-locks-age-steal-and-leak / MEDIUM | 仅按120秒年龄抢锁及进程被杀后残留可能违背互斥/恢复；交实现核对PID/start ownership与活锁不抢。 |
| d1-canonical-no-diff-conflicts-write-through / MEDIUM | 合法OAuth刷新可能导致D1/D2差异；最新注入判据明确差异即红，作者不自行放宽，交Lead决定。 |
| dedupe-key-spec-conflict / MEDIUM | severe旧签名无reason，新判据要求同日新原因不被压掉；以最新要求为准，交Lead/实现核对，不能擅自改成永远只有overdue一种原因。 |
| snapshot-evidence-unmarked-provenance / MEDIUM | snapshot-input可能写入与live相同证据树；交实现/QA核查来源标记及生产根隔离，snapshot不冒充当场global证明。 |
| removed-home-obligation-dropped / LOW | roster移除可能静默丢旧义务；交实现核对process/lease证据后才能解除。 |
| deploy-window-exit75-no-terminal-recovery / LOW | exit75可能仅走泛化trap与TTL；交实现核对原terminal恢复合同，不在设计节点重启。 |
| slot-canonical-home-not-propagated / LOW | slot校验canonical默认值与child使用值可能不同；交实现检查显式传播/强制输入，slot绝不链接真实canonical。 |
| slot-meta-alert-plan-text / LOW | slot config_error不得通过meta告警触达生产；隔离边界优先。生产pin失败是否补meta告警交实现核对，fixture验证不发真实生产消息。 |
| activation-goal-wording-ambiguous / LOW | 标题保留的是历史总目标；按Lead aa341d63/本轮fe089c5f，本单可在注册home证明完成且global unknown如实披露后收口，激活由独立授权动作承接；本轮只是design phase完成，更不等待激活。 |

无server治理settled记录。审查通过后继续既定设计交接；如后续实现违反注入硬红，QA仍须如实报红，不能用本次APPROVED盖过实测。

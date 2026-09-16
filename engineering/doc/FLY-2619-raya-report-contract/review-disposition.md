# FLY-2619 Raya 汇报合同 · 评审处置 — 调研
Issue: FLY-2619 (https://linear.app/geoforge3d/issue/FLY-2619)
日期: 2026-09-15
基于: plan.md

R1 request `a54eaba1-0bbb-4b79-98fe-d6776e9bd51b`，question `5d7dc55c-6b0d-414a-a4db-35484767c693`，effective reviewVerdict=CHANGES_REQUESTED。以下为设计修订，不是实现完成。

| findingKey | 等级 | 处置及证据 |
|---|---|---|
| fleet-alert-leaks-report-line | HIGH | 已修 §4/§6：统一 Discord 告警频道视为 founder 可见面；title/body/footer/旧 alert replay 去诊断文本，原始信息只在内部；双频道污染注入验收 |
| history-backfill-unowned | HIGH | 已修 §2/§3.1/§5.4/块 M：强制 migration complete 栅栏、逐历史轮准入分类、参数化精确 eligible 查询、未知历史隔离、混合历史及首个 begin 红测试 |
| seq-order-not-chronological | MEDIUM | 已修 §3.1：按 slotStartMs/sourceSeq 排序，seq 仅为入账边界；pass 事务全部提交后才 enqueue |
| group-bound-32-contradiction | MEDIUM | 已修 §3.1/块 B：32 仅读取页大小，65 条一次认领、只 finalize 一次 |
| pending-state-overloaded | MEDIUM | 已修 §2/§3.2：sending 是出站状态；缺成员返回 incomplete，组保持 collecting |
| unmarked-send-bypass-undefined | MEDIUM | 已修 §4：不增虚构标记；专用 controller 绑定组，通用入口拒绝明确旧键及保留键，自由文本语义仍须真实 QA |
| no-stale-collecting-group-recovery | MEDIUM | 已修 §3.3/块 B：现有 tick 超龄告警一次，失败引用可记录，受管补记有审计；不自动 silent 丢工作 |
| shared-bearer-token-identity | MEDIUM | 已披露 §4：身份完整性校验不是 per-Lead 鉴权，平台限制不在本单扩修 |
| lead-actions-tool-allowlist-unlisted | LOW | 已修 §5.5/§6：exact allowlist/config gate、生成配置路径及两套 suite 明列 |
| doc-heading-mismatch | LOW | 已修：两个证据文档标题增加各自用途，仍保留注入要求的文档类型/元信息 |

没有把 request prose 当作 Lead governance ruling；没有 overrule。R2 必须开新 gate/request。HTML 同步增加告警面和历史不阻塞新消息的说明；DOM harness 再验通过。生产旧合同仍在运行。

## R2 修订

request `254d885c-78d1-4e40-9657-3587a2c575ff` / question `013f7acf-1ef5-49f7-80d9-34c075d47c93`，effective verdict=CHANGES_REQUESTED。

| findingKey | 处置 |
|---|---|
| ambiguous-group-permanently-blocks-begin | HIGH 已修：active 索引只含 collecting/ready/sending；ambiguous 独立待核对、不占名额，原 members/key 不重入；真实回执可审计转 sent。新增 sender throw 后新组可继续的单测及真机矩阵 |
| legacy-report-key-unevidenced | MEDIUM 已补证并收窄：三个本地 report_attempt 有该 key，但不证明最终发送或全体覆盖；只作纵深防御，未带 key 的 UUID 路径仍须完整消费链 QA |
| cutover-vs-cutoff-seq-naming | LOW 已修：统一改名 migrationBoundarySeq 与 groupClaimSeq |
| doc-heading-mismatch | LOW 保留为非阻塞说明：注入 DOC-FLOW 明令每份文档标题类型为 探索/调研/实施计划；两个附属证据页已以“渲染验证”“设计节点验收清单”区分用途，保留 — 调研 以遵守该元信息要求。不主张存在 Lead governance ruling |

R2 未推翻已完成的 R1 修复；只补齐失败恢复出口，没有重开产品范围或实现。

## R3 有效通过

question `34670f50-5577-45bc-a2df-7991ac5fb1f5` / request `e6df50c6-e482-4ba0-94b0-6ce36f3e2bba`，effective reviewVerdict=APPROVED，reviewerVerdict=APPROVED。R1/R2 HIGH 均已核实修复。唯一 LOW advisory `ready-state-no-liveness-signal` 保留为 Follow-up 并经 ask --report 报 Lead；不重开评审、不把建议伪写成已实现。

# FLY-2789 节点成绩记录 — 调研
Issue: FLY-2789 (https://linear.app/geoforge3d/issue/FLY-2789/2787-b成绩记录-每张单每个节点记下用的模型组别并记-qa-是否一次过founder-打回次数额度花费耗时按组汇总每张一次过-qa)
日期: 2026-09-22
基于: research.md

## 当前设计交接状态
R3有效APPROVED，设计内容commit31c47c2ae。原送审快照保留在git commit31c47c2ae；当前plan已按Lead明确收尾指令改正三项advisory的示例/旧措辞，无需重开review。实现必须同时读本交接说明。

## R3三项advisory已收尾修正（不另开评审）
Lead答复4aba8512-26c5-4b47-b66f-493cdd6ecdcb要求本单实施时全部落实，不只留Follow-ups。下列三项已经直接修正plan文字/示例；实现与QA必须据此编写并验证用例，不改变业务指标合同：

1. MEDIUM `e-fixture-run-split-contradicts-node-totals`：E只保留一个权威fixture。已统一为 **R1: D20+I20=40；R2: I50+Q30=80；总120**，仍为D20+I70+Q30。示例节点时钟：R1 D=[0,200)ms、I=[200,500)ms；等待恢复=[500,1500)ms；R2 I=[1500,2000)ms、Q=[2000,2300)ms。node_work_ms=200+300+500+300=1300，elapsed_ms=2300，差1000明确为跨run等待。以此替代plan中互相冲突的R1=20/R2=100和旧elapsed=1500例子；两run不变，一单/降级集合/总成本120不变。具体执行测试由实现/QA节点完成，本阶段未跑。
2. LOW `before-exclusions-denominator-vs-illustrative-example`：分母维持所有可验证原始分配（含后来降级/mixed/异常）；示例已统一“原分40，降级12，mixed2，assignment_not_honored1，正常25”。不允许断言before=normal+degraded；逐原因排除去重按plan优先级，一单不能算两次排除。无这些异常的A-E样例原期望不变。
3. LOW `stopfailure-listed-as-live-importer-entry-after-spike-disproved-it`：plan §4.2的旧“Stop/StopFailure入口”已删除StopFailure作为有效入口的旧措辞并明确：正常来源入口为Stop；失败靠adapter terminal/recovery尾部补读。不能把global StopFailure当已工作的导入触发器。

另保留Lead指定PR Follow-ups：当前CLI baseline/candidate均未触发global StopFailure；本单不修、不另开单。失败轮次用量无法补齐时显示missing，不填零，组成本遵守coverage规则。新实现不得利用“正常样本通过”声称失败用量已全部齐全。

## 已完成与未完成
已完成源码研究、A/B分配及降级读契约、三维指标设计、三轮评审、隔离真CLI hook研究与HTML评论层DOM验证。未实现功能，未生产验收，未更改分流/生产配置，未重启/部署/merge。
Mermaid本地两次渲染仍被沙箱拒绝，HTML保留可读图源、文字说明与明示placeholder；Lead接受该例外。未进行浏览器视觉QA。

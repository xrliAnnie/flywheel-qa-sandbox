# FLY-2456 真实分类与报告修正 — 实施记录
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456)
日期: 2026-09-10
基于: plan.md; rework-5.md; recomputed/replay-receipt.json

## 授权与诊断

收到六条清单 `6bac3e51-9f25-400f-9629-687ac8e574d8` 及纠正指令 `a716d19c-6158-443f-b40b-ff7ec514e581` 后，按 epoch20 implement attempt7 处理。上一轮对旧头重复审计没有完成返工，本轮不复用旧头 review/CI 作为新修复证明。

QA 推断的 failures.length==2 问题经真实输入证伪：episode_exhausted 无 episodeId，原过滤器已排除它，B1 的 same-episode failures 仍是 2。实际门槛不匹配是 claim.episode_attempts 已归零，以及宿主换体链为 delivery replacement 而不是 rollback。Lead `d51bd7ba-da57-4470-925f-7da14455418f` 批准以同 episode 的两次失败与后续耗尽事件证明预算，并接受 materialized + 两种 launch 事件，不强求 rollback。现有身份/顺序/新 session 校验保留；如果存在 rollback，仍核对其新 execution 与 ordinal。

真实 R1 B1 选行夹具记录源 SHA，所选原始行字节内容未改。预期 replaced 在旧分类器下得到 other，回归 RED；修复后 observer 50/50，含真实换体及缺失/错配事件负向检查。

## 两轮重算与六条清单

重放 original final-observe.evidence.json，文件哈希不变；新 observation 与旧 observation 除 classification/replacement 外全对象相等。首次重放发现 R1 B2/R2 B2 还会进入既有 #15 标签，立即停手询问。Lead `7c465a92-0d3f-4b27-bf3a-89a827ac339a` 允许这两项额外变化并冻结变化清单。

1. R1：replaced / failed_exhausted_no_replacement / skipped_not_holder；R2：other / failed_exhausted_no_replacement / skipped_not_holder。原始76份host-runs字节不变，新verdict/pair/receipt独立放recomputed/；不是另跑真机。
2. 顶层drill-report.md与founder-report.html已替换真实结论。历史报告路径确为host-runs/r2/drill-report.md与host-runs/r2/founder-report.html；DEVIATIONS原件保留，说明1.–5.段落加#6–#17小节的混合编号。
3. 主结论为capability drift 2→0；R1 B1两次drift后换体，owner failure实证只在R1 B2、R2 B1/B2。0/2→0/2仅为认回率，不掩盖drift修复效果。R2 B1缺第一episode的episode_exhausted事件，仍other，不扩分类器。
4. 自查按右侧字面量规则扫描，归档与重算产物实际匹配0；保留driver合法变量引用。未提交原始大型数据库/ps/alerts/identity文件。
5. failed_exhausted_no_replacement在真实数据触发2次，已改披露。
6. Lead回报清除fly2454-decoy，本节点未操作生产tmux。没有修改packages、计划、服务、slot原语或guard。

生产影响门不放宽：R1仍13项失败2项待归因；R2仍12项失败2项待归因。F1–F5与FLY-2503均保留，未声称ship验收或生产零影响通过。

## 验证

- RED：/tmp/fly2456-rework6-real-red.log，真实B1断言other != replaced。
- observer50/50、相关observe/verdict/report-pair/CLI/drill104/104：exit0。
- pnpm lint、pnpm -r build、CI suite enumeration：exit0。
- 全24个FLY-2456 Node套件：519/520，exit1，唯一既有liveness unknown vs alive。不把聚焦绿或未来CI绿改写成本地全绿。
- 实际62块scanner/dry-run：pass，digest 606cdfc24e34d0f7db403b7e7f63fbe0bcd8b36aef93516ff33ee2432ef4d4bf。
- 原76份host-runs逐件hash匹配；两轮原observation派生输入hash匹配；字面秘密0；两份新HTML零table且无未执行模板句。
- 浏览器MCP被approval-policy never拒绝，本地独立headless Chrome退出134且无截图。只有markup验证，不宣称视觉PASS，交QA核验。
- 本地全包按FLY-2492不重跑追绿，上一轮onTaskUpdate未处理超时exit1仍保留。新精确头CI14/14与正式review单独验证；所有旧review/CI只证明旧头。

下一步：提交本轮代码/报告及progress，milestone literal last，一次普通push后冻结HEAD，登记正式新审及CI；通过后needs_review1150。遵守Lead不park、不blocked的本轮指令。

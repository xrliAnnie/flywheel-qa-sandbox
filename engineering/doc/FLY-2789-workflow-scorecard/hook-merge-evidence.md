# FLY-2789 节点成绩记录 — 调研
Issue: FLY-2789 (https://linear.app/geoforge3d/issue/FLY-2789/2787-b成绩记录-每张单每个节点记下用的模型组别并记-qa-是否一次过founder-打回次数额度花费耗时按组汇总每张一次过-qa)
日期: 2026-09-22
基于: research.md

## 环境与范围
2026-09-22 本地 Claude Code 2.1.280；独立 tmux socket、临时 CLAUDE_CONFIG_DIR、UTF-8 locale、真实 CLI `-p --settings`。模型服务为本机 stdlib HTTP stub，假API key；无生产账号调用、生产配置写入、服务重启或全局hook修改。这里只测真实CLI配置合并与事件触发，不是生产浏览器/工作流QA。
全局marker配置模拟生产的 UserPromptSubmit/PostToolUse/Stop/StopFailure 事件键。marker命令不发送Lead消息；因此证明配置保留，不宣称实际生产收信链已端到端通过。

| 试验 | inline事件 | 成功路径实际marker | provider 400失败路径 |
|---|---|---|---|
| 最初候选 | UserPromptSubmit/Stop/StopFailure | global+inline UserPromptSubmit, global PostToolUse, inline+global Stop | global+inline UserPromptSubmit, inline StopFailure；无global StopFailure |
| 收窄候选 | 仅UserPromptSubmit | global+inline UserPromptSubmit, global PostToolUse, global Stop | global+inline UserPromptSubmit；无global StopFailure |
| 阴性baseline | 无inline hooks | 本轮只跑failure对照 | global UserPromptSubmit；无global StopFailure |

成功运行exit=0，失败运行exit=1并返回预期本地400。各进程退出后观察marker仍无global StopFailure。独立测试server/socket已清理。

## 结论与限制
- 已证实：inline UserPromptSubmit 在当前真实CLI有效；只加它时global PostToolUse及正常Stop仍触发。
- 未证实：global StopFailure 的有效性；baseline本身也缺失，不能把缺失归因于inline覆盖。这不是“所有hook都通过”。
- 采用最小候选，只加UserPromptSubmit；不新注册Stop/StopFailure，不触碰全局配置。失败路径用量完整性必须经已有adapter terminal/recovery的原始来源重读与final watermark验收，不能依赖缺失hook。
- 实施QA仍须真实CLI调用实际inbox-check/runner-stop-notify脚本（隔离API依赖）及故障尾部补读；该验收未被marker实验替代。
- 证据脚本为本目录 hook-merge-spike.py；版本差异必须重新测，不将2.1.280结果当永久CLI合同。

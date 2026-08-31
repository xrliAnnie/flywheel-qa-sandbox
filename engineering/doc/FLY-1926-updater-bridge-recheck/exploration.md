# FLY-1926 updater 收尾误报 — 探索
Issue: FLY-1926 (https://linear.app/geoforge3d/issue/FLY-1926/bug误报-updater-收尾-bridge-复测在-lead-重启波峰上跑-22-次部署都误判-degradedbridge-实际健康)
日期: 2026-08-31
基于: 无

## 问题边界

本轮只修部署收尾播报的三个相关误报，不改部署触发、Bridge/Lead 生命周期或告警运输：

1. Lead 重启统计的生产者输出被诊断文本污染后，消费者把整轮标成 `unreadable`。
2. Bridge 收尾 `/health` 采样落在 16 个 Lead 的 bootstrap 波峰，5 秒单探针超时被误写成 Bridge degraded。
3. 观测失败必须表达为“未知/未观测到”，不能升级成服务 degraded；真正的 Lead、watcher 或启动健康失败仍维持现有 fail-closed 语义。

## 已知事实

- 2026-08-31 12:00 生产日志中，Bridge 主健康检查在 12:01:51 通过；16 个 Lead 随后全部重启成功。
- 同轮 `do_restart_all_leads` 的捕获值包含三行 `host-tmux-selection-gate` 诊断，最后才是合法的 `skipped:0 failed:0 total:16`。严格单行解析器因此返回 `invalid`。
- 2026-08-28、08-29 的部署中，Bridge 主健康检查先通过，Lead 波结束后 5 秒收尾探针失败，产生 `deploy_degraded`；历史事件描述的 08-19、08-20 也具有相同顺序。
- `rn_probe_bridge_health` 是收尾观测，不控制新 Bridge 启动、build SHA 验证或 `deployed-sha` 推进；真正的启动失败已在 Lead 波之前终止部署。

## 约束与假设

- 不重启 Bridge、Lead 或 updater；实现节点只改代码、测试和文档。
- 保留 `rn_parse_count` 的严格完整单行合同，不能用“从脏输出里找最后一行”掩盖新的 stdout 泄漏。
- 保留收尾 Bridge 延迟观测，但把采样放到 Lead 波之前；采样失败只表示 observation unavailable。
- Lead 失败/跳过、Lead 波未执行、统计合同不可读、零候选以及 watcher 非健康仍然可以让整轮非成功或 degraded。
- 不新增可调超时、负载检测或重试机制；这些会扩大策略面，且无法解决“观测不到不等于故障”的语义错误。

## 方案比较

### A. 修正通道 + 前移观测 + 三态措辞（推荐）

- 在 `do_restart_all_leads` 内把 host-tmux gate/census 的诊断重定向到 stderr，stdout 继续只承载统计合同。
- 在 Bridge 主检查和 build identity 通过后、Lead 波开始前运行现有有界收尾探针，保存结果供最终播报使用。
- 把收尾探针失败渲染为“观测不可用；启动健康检查已通过”，且它本身不触发 degraded 告警。

优点：直接修复两个根因，保留严格合同和可观测性，改动集中。缺点：最终消息中的延迟是“Lead 波前”样本，必须明确标注采样时点。

### B. 放宽解析 + 探针重试

- 统计消费者从多行文本中提取最后一个匹配行。
- Bridge 收尾探针扩大超时或重试。

缺点：会掩盖以后新增的 stdout 污染；负载峰值可超过任何静态预算，仍会制造假 degraded。

### C. 等负载回落后再测

- 保持末尾探针，但在系统负载下降后再运行。

缺点：延长部署锁与播报时间，引入新的负载阈值和超时策略；并且即使观测失败，也不能据此证明 Bridge degraded。

## 成功标准

- gate/verify/census 输出不会进入 Lead 统计捕获值，`skipped/failed/total` 仍严格解析。
- Bridge 收尾采样在 Lead 波之前完成，之后不再执行 `/health`。
- clean Lead/watcher + Bridge observation unavailable 能播报成功，同时明确观测未知且不发 `bridge-completion-probe-failed`。
- 真实 Lead/watcher degraded 仍保持原有 degraded 路由。
- 聚焦测试、全部新增 shell 测试以及仓库全量 lint/build/test 均通过。

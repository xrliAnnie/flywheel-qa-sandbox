# FLY-2788 节点模型分流 — 调研
Issue: FLY-2788 (https://linear.app/geoforge3d/issue/FLY-2788/2787-a分流引擎-每个节点按定稿选模型设计三组-astraopus-55fable-51-各-13实现-opus-55qa-gpt-6)
日期: 2026-09-22
基于: plan.md

## 设计产物验证（不等于实现 QA）

### 本地图
两次执行以下指定命令均失败：

```sh
mmdc -i engineering/doc/FLY-2788-node-model-routing/flow.mmd -o engineering/doc/FLY-2788-node-model-routing/flow.svg -w 1000 -b white --svgId fly2788-d1
```

两次 stderr 均为 `MachPortRendezvousServer ... bootstrap_check_in ... Permission denied (1100)`。遵照任务合同：保留 flow.mmd，HTML 明示 `DIAGRAM PENDING LOCAL RENDER`，没有伪造 SVG 或使用远程渲染。未完成浏览器截图/视觉验收。

### HTML 交互
使用本机已安装 happy-dom 20.10.6 执行实际内联脚本：
- 10 个 section 都有 textarea；存储 key 含 location.pathname；localStorage 拒绝时仍可输入与汇总。
- 包含 HTML 字符串的评论仅作为 text/value，无元素注入。
- 超长中文/emoji 意见按 Unicode 字符分段；每段小于 1800 字且首行精确 `【页面意见汇总】FLY-2788`。
- Clipboard API 成功、promise 拒绝、API 不存在三条路径均有成功复制回执；后两者走 execCommand。
- 单一 script、正确 nonce 占位符、无内联 handler、无自设 CSP、无外部资源依赖。
结果 PASS，范围仅静态及 DOM 控制器，不能证明真实浏览器/CSP执行。发布后需另验托管 HTTP/CSP/源码。

### 分组公式试算
对固定 UUID `00000000-0000-4000-8000-000000000001` 到 `...000120` 执行 plan §2.2 的 Node crypto 表达式：

| 设计组 | QA Sol | QA Opus | 合计 |
|---|---:|---:|---:|
| design_astra | 29 | 15 | 44 |
| design_opus | 31 | 7 | 38 |
| design_fable | 31 | 7 | 38 |
| 合计 | 91 | 29 | 120 |

前 3 个设计 bucket：0.334834013655152、0.766570430447912、0.1545766403615707；对应 QA bucket：0.042097211152908987、0.5613282921801666、0.577057699093122。
这是公式可复现性试算，不是 120 张实际模拟派单，不满足 Q1–Q4 的 admission/runtime/真 pane 验收，也不证明统计独立。后续实现应把它用作固定向量，并独立完成真实链路验收。

最新 HTML 追加降级区块后再次执行同一实际脚本 DOM 检查，10/10 区块有输入，长意见/复制三路径仍通过。原 120 身份表仅设计×QA，新增实现节点分组需后续完整 Q1/Q3/Q11 验收。

### 最终三节点固定向量补充
对同一组 120 个 UUID 加入 implement 节点独立哈希（仍只是公式试算）：实现 Opus/Sol=88/32。
设计×实现（列 Opus/Sol）：Astra 31/13，Opus 30/8，Fable 27/11。
实现×QA（列 Sol/Opus）：impl_opus 63/25，impl_sol 28/4。
这组精确计数已写入计划 Q1，额外随机样本区间仅作诊断，不作为正确性硬门；后续 QA 仍须用真实 admission/runtime 验证相同期望。


### 已发布产物核验
最终有效设计评审 APPROVED 后，以 publishOnly=true 静默发布：
https://fw-reports-356a6d.vercel.app/r/b422b2901de0d15da754445f0d418322/

reportId=b422b2901de0d15da754445f0d418322；messageId=null、delivered=false 为静默发布预期。
2026-09-23 UTC 实际 GET：HTTP 200；占位符已替换；唯一 script nonce 被 CSP 授权；script 文本及完整 body（仅替换 nonce）与已提交 design.html 一致；外部资源 0、inline handlers 0。
托管响应 SHA-256：0aaf8e873084e91b1cc9ec6b1a6dd50f1af634f6df77949e6d6078b583e1d05d。
这是托管源码/CSP静态核验，不等于真实浏览器视觉或执行验收；本地图仍保留明确 pending-render 状态。

### 交接边界
最终评审及四项非阻塞 Follow-ups 见 review-resolution.md；plan blob 保持 a0c4fc62b715e3c893efb21576c91764b9808ab6。
没有实现代码、生产配置/模板修改、服务重启或生产验收。本次没有新增超出既有稳定身份、冻结重放及证据边界原则的可复用角色记忆，记忆保持不变。

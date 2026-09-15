# FLY-2563 Bridge 响应与连接寿命 — 设计验证
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: plan.md

## 设计评审

- 审阅设计提交：`b7f73e1ec`。
- Gate question：`6ba20130-08e0-4db2-8772-a37fb8e3b713`。
- request-review receipt：`aec4ca61-1d09-4555-845c-8fcd597e4e70`，accepted=true，skipped=false。
- 当前状态：pending；尚不能据此交接或声称评审通过。
- 语义确认：Lead question `90054f86-ebf0-4256-ab41-9b1d37213565` 明确终态事件首次消费一次、例行扫描非终态、保留holder与swap阈值。回复已应用并通过ask --report回执 `8b8df6ad-ff63-43ec-9d7c-04112c12714a` 汇报。

## 已完成的设计证据

- 源码：观察器、源表/唯一身份/现有clarification游标、CommDB构造与关闭、两个裸new泄漏路径、health现有lag、wrapper、归档候选和游标。
- 指定备份以 sqlite `mode=ro&immutable=1` 打开，query_only=ON，执行旧SELECT/EXPLAIN并close。备份已含应急索引；350.41ms、空结果是旧查询基线，不能冒充目标算法或生产验证。见snapshot-probe.json。
- `git diff --check`：通过；三份主要文档首部按注入DOC-FLOW。

## HTML 静态与评论控制器

命令：`python3 engineering/doc/FLY-2563-bridge-loop-fd/build-founder-html.py`，`node engineering/doc/FLY-2563-bridge-loop-fd/verify-founder-html.mjs`。

通过：7个section各有评论、路径隔离localStorage及读写异常、重载恢复、无意见清空、1800字符Unicode分段且每段重复规定首行、复制全部/单段、剪贴板成功/缺失/Promise拒绝/后备失败、1个nonce占位脚本、无外部资源/inline handler/自带CSP。parse5实际文档解析零错误。

控制器在Node VM隔离夹具运行；没有浏览器视觉QA，也没有真实浏览器CSP执行证明。静态结构与逻辑测试不能替代后者。

## Mermaid 本地渲染

每个图均尝试本地 `mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2563-d<N>`，随后使用同一标准参数重试一次。两图各两次均失败：Chromium `MachPortRendezvousServer ... Permission denied (1100)`。失败在浏览器启动阶段，不代表语法已验证。

按任务fallback：保留d1-flow.mmd/d2-model.mmd，HTML各显示`DIAGRAM PENDING LOCAL RENDER`；未伪造图、未使用远程渲染。文案修订只简化图中术语，未冒充已成功重新渲染。限制已报Lead，回执 `57e62232-01ae-4f7f-878a-adca655b6edd`。

## 待完成

有效设计评审、最终HTML提交推送、publish-only、托管HTTP/nonce/CSP一致性验证、DESIGN-HTML ready回执、phase_design_complete与park。

产品实现、迁移与CI、15分钟HTTP/lag、2小时fd、真实副本修复后性能均由实施/QA完成，本节点未执行。

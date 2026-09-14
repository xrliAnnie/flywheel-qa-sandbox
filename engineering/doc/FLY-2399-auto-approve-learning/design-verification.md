# FLY-2399 自动审批判断与学习 — 调研
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399/2309b5-自动合并放手前要改的三条规矩提案交-founder-拍p2-文档单-依赖-b4-结果)
日期: 2026-09-10
基于: plan.md

## 本节点验证

- `python3 engineering/doc/FLY-2399-auto-approve-learning/build-founder-html.py`：R1生成16,971字节，R2同步修订后生成17,200字节独立HTML，无外部资源。
- `node engineering/doc/FLY-2399-auto-approve-learning/verify-founder-html.mjs`：PASS。11节均有留言输入；pathname隔离localStorage且读写异常被捕获；实时汇总；首行准确为`【页面意见汇总】FLY-2399`；1800字符Unicode分段各有标记；复制API成功/拒绝/缺失及fallback失败均验证；同路径重载恢复、异路径隔离、清空留言均验证。单一nonce脚本、无自带CSP/inline handlers/innerHTML/外部资产。
- 此验证是Node VM模拟DOM逻辑，不是浏览器视觉/CSP运行验收。
- 两张Mermaid图均先按默认本地mmdc尝试，再执行标准参数重试：`mmdc -i <source> -o <svg> -w 1000 -b white --svgId FLY-2399-d1|FLY-2399-d2`。四次均exit1：Chromium `bootstrap_check_in … MachPortRendezvousServer … Permission denied (1100)`。没有远程渲染，没有伪造SVG；HTML有两处`DIAGRAM PENDING LOCAL RENDER`，源码同目录保留。
- 生产快照helper返回`snapshot_owner_unavailable`；未绕过复制生产数据库；32/103/22的统计注明Lead来源，手工6条本轮只读核对。
- 修改面仅本issue工程文档目录及product提案目录；未改规则、授权、生产代码、flag或其他issue。

## 后续验证责任

设计评审、发布URL及交接回执在取得后追加。本轮未运行后续语义模型、产品测试、真实QA卡/slot或生产状态变更；plan §9是后续实施/独立QA要求，不是本轮通过证明。

## R2文档核验

- 新header与相对文档链接核验PASS；HTML评论控制器再次运行PASS。
- 改动覆盖R1全部10条finding，逐条处置见review-response.md；新增评估结果表、七表留存与独立历史分页均为后续设计，不是本轮实现。
- Mermaid第二图的输入→意见关系改为一对多，与机械独立刷新一致；仍保留本地渲染受限标记。

## R3文档核验

- HTML同步意见限频与历史更新间隔，重新生成17,513字节；评论逻辑VM验证PASS，脚本未改。
- R2的1 HIGH及2 MEDIUM逐项处置见review-response.md；新增项目状态表使本版为八张新表，并明确旧delivery两个nullable字段的迁移/恢复。
- 文档header、相对链接及git diff --check通过；本轮未运行产品实现测试，本地Mermaid渲染限制维持原记录。

## 设计门通过

R3有效APPROVED，request `81a5ee8e-3dd7-4231-9504-5aed3e0173e2`、gate `ce8d7838-01f4-49ad-bbe5-a497f0c12f22`，审查提交`c39b45176`；完整回执与3条非阻塞建议见review-response.md。批准不代表产品实现/语义质量/真实QA通过。

## 最终托管发布与报告

- 最终HTML在已推送提交`357b0c6e6`上执行`publish-report --publish-only`，reportId `84c25f0492221439db4ed3663d08d433`。只托管，messageId=null、delivered=false；没有发频道消息。
- [Founder互动页](https://fw-reports-a53de2.vercel.app/r/84c25f0492221439db4ed3663d08d433/)：HTTP 200，托管17,740字节；唯一脚本有真实nonce且与注入CSP匹配，原placeholder已替换，零外部资产。
- 发布前后脚本文本相同，SHA-256 `dbd2b3950e99ffbd7ec9da186e19b2ffe003339a69530f3d2008274efe5a463c`。保留2个DIAGRAM PENDING LOCAL RENDER标记。验证是HTTP/源码/CSP一致性；没有宣称真实浏览器执行或视觉QA。
- `DESIGN-HTML ready`已通过ask --report发送Lead，回执 `bffa48b3-6fdd-4939-8ed4-110688ba9795`。三条R3建议的独立Lead回执见review-response.md。
- 所有改动限本issue工程文档与product规格目录；没有产品实现、规则/merge权限/flag修改、真实QA slot操作、部署或后继节点派发。下一步仅按注入命令完成phase_design_complete并park。

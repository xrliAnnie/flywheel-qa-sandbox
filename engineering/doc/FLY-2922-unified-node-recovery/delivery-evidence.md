# FLY-2922 设计交付验证 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-26
基于: plan.md

## 本地交付页验证

HTML SHA-256: `fcfeeacc36710dcce29f119868606aeccc4e56d8d25734379de26d526794f7a8`。

- 7 个 section 各有评论输入，包括汇总卡；只有一个 inline script，nonce 占位符精确为 `__CSP_NONCE__`。
- 无外部资源、内联事件属性、自定义 CSP meta 或 innerHTML 写入。静态结构检查通过。
- Node VM 执行实际 HTML 抽出的脚本：正常复制、剪贴板 promise 拒绝、剪贴板不存在及 localStorage 抛错三组均通过。长中文/emoji/含 script 字样意见分为 4 段，每段不超过 1800 字符、均以指定 marker 开头；路径隔离 key 检查通过，后两组各调用一次复制 fallback。
- 这只是脚本与结构验证，不等于浏览器 QA。Chrome DevTools list_pages 长时间无返回，停止该观察；没有因此重启或改变浏览器。
- 两张 Mermaid 分别使用本地 mmdc 和标准参数重试，全部 exit 1。固定 id 分别 FLY-2922-d1 / FLY-2922-d2。错误：`bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。遵从明确降级合同，HTML 含两处 `DIAGRAM PENDING LOCAL RENDER`，图源随报告提交；未使用远程渲染。

## 设计评审与交付状态

首轮 gate `5700086d-8e52-463e-9516-03c9a347f749` 有效结果 CHANGES_REQUESTED，修订见 plan.md §9。
第二轮 gate `b9870385-3090-4355-b5db-ccf77edc9e17`、request `557badb3-8948-46ec-8d93-cf99b6c52c1e`，审阅计划提交 `6981b4e60`；结果 CHANGES_REQUESTED，阻塞点是缺前序 lineage；修订见 plan.md §10。R3 与托管页证据在收到后追加。

未运行实现测试、未验证九类修复行为，未部署或改动生产任务链。相关测试矩阵属于后续实现与 QA 的强制验收，不以本页验证替代。

第三轮 gate `46a1b3cd-9d44-4c3b-8bf9-2659c598f2af`、request `346ee5cf-fa23-48a0-9751-84ae21af29bf`：CHANGES_REQUESTED。root 未启动体缺 worktree HEAD 的阻塞点及两条相关建议已按 plan.md §11 修订。报告叙述同步，评论脚本未修改。

## 托管验证与交接前完成审计

第四轮有效 reviewVerdict=APPROVED，gate `d9ab4f85-f464-4fee-9c09-7af6295b0c9a`，request `16c59728-a305-411a-9cfd-7db7c803987e`，获批计划提交 `c4d40fbed`。三个 MEDIUM 和 tests_not_run LOW 作为非阻塞 Follow-ups 保留于 review-result.md，已报告 Lead（durable report `0b337c01-ffba-4682-ac6f-c0d0e6a4294b`；即时 doorbell 超时但队列持久保留）。

HTML 按 publishOnly=true 发布，无频道消息（messageId=null, delivered=false 为本任务预期）。托管地址：https://fw-reports-6da062.vercel.app/r/52556a2f00b5808a1159dc751953af0c/

- HTTP 200；占位 nonce 全部替换，单一脚本 nonce 与所有实际 CSP 匹配。
- 托管正文与已提交源文件一致；评论脚本与本地已验证脚本一致；外部资源为 0。
- 本地 HTML SHA-256: `fcfeeacc36710dcce29f119868606aeccc4e56d8d25734379de26d526794f7a8`。
- 托管 HTML SHA-256: `7b6ed7f6e3614c624d34d56d9146563ba48868d16b996d4a99256606677545da`。
- 两处 DIAGRAM PENDING LOCAL RENDER 按约定保留；未声称浏览器视觉 QA 或真实故障修复验收通过。

完成审计：exploration/research/plan 前置三行齐全；九单矩阵及新增根/非根、失败、并发、迁移、权限负控齐全；有效设计评审已批准；文档/HTML 已提交推送；HTML 已发布、线上内容/CSP 已验证并按指定 DESIGN-HTML ready 通道报告。未实现、未派发后继、未申请 ship、未 merge/部署。学习写为允许目录下的一条 memory update note，未直接修改共享 role memory 索引。

下一步仅执行 `complete --route phase_design_complete` 后 park。完成命令自身的结构化收据是阶段交接权威；本段审计不冒充该收据。交接后无 TURN 不再写共享工作区。

## 2026-09-26 重开后的增量交接核对

本次 design execution `70911aab-49d0-4c5a-92fa-d32875c0884f`，TURN design epoch 6。Lead 在问题 `5bd87c4e-37a5-43f3-b1c0-bb9c5f1f151a` 的答复确认：设计重开正常，只核对 FLY-2921 合同补充并做 scoped review，不重做其余设计。

- 原实现 WIP `d35da9cde` 原样保留；本次相对它的 packages/scripts 差异为零。
- 原 plan.md SHA-256 仍是 `7de9bef9d44818fa2a689a98dc517087154cafbe568126e6cb2aeb4edf11a1c5`；原门重查为 APPROVED。
- 新补充 `design-correction.md` 提交 `af2178f24`，核对的 FLY-2921 远端头为 `d12124f39d07413a7ba3cab17aab9dc124859482`，仅作为未合并分支合同证据。
- scoped review gate `0f29f815-f140-4e68-ac08-073a9a996389`，request `b5e92e5c-ce11-4f40-ab94-35d74af3e4c9`，已 accepted，结果在下方追加；未把旧批准冒充补充的批准。
- 更新后 HTML 仍为 7 节/7 评论框、单一 nonced inline script、零外部资源、零 inline handlers/innerHTML、自定义 CSP 为零。重新抽取实际页面脚本，正常复制/拒绝 fallback/缺剪贴板且存储抛错的三组检查均通过；长意见拆为 4 段，每段带 marker 且不超过 1800 字符。
- 原托管页重查 HTTP 200、nonce/CSP/期望内容通过；新页须在本轮批准后重新发布，不沿用旧 URL 冒充新内容。未重试已记录的本地 Mermaid 环境故障，保留原允许的两处占位与图源。
- 未新增可复用的 role memory 判断；本次是既有合同的定向对齐，未重复写学习条目。未运行实现测试或声称 WIP 验收通过。

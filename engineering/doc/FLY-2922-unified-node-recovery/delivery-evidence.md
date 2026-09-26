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

# FLY-2553 v5 对照 — 实施验证
Issue: FLY-2553 (https://linear.app/geoforge3d/issue/FLY-2553)
日期: 2026-09-14
基于: plan.md

参考：[Lead 手工 v5](https://fw-reports-624a39.vercel.app/r/152e60dc3a53a20c463927a44d02076d/)，仓内 mock2.html/build-mock.py。以下为源码、测试及生成DOM对照，浏览器手机/展开态由QA/Lead验收（回执1140c9ab），不能据此宣称视觉已通过。

| 区块 | v5 要求 | 实现与可验证边界 |
| --- | --- | --- |
| 容器 | inset mock、锁行、单一标题 | 共享render模板中的mock容器；锁行包含生成时间、运行时新鲜度；无评论控件 |
| 默认态 | 全部默认收起 | Epic details无open，supplement/Lead待答/audit也默认折叠；原生details展开 |
| 现在要你看 | 少量真实founder事项 | 仅当前founder_gate holder及明确founder问题；DONE/ACK报告、终态普通问、review/旧mailbox gate不作当前founder卡 |
| Epic摘要 | Linear状态、编号、短名、并列计数 | 原状态不翻译；短名完整原句在title属性；等待/空闲/未开始并入未开始计数 |
| 判断 | 展开后真实判断及角色/时间 | 原文转义；保留时效淡化；缺省“还没有人写过”；未生成机器判断来填空 |
| 子单 | 活动子单badge/id/title/引擎进度 | 运行/等待/未开始展示，空闲为还没起跑；完成/作废不重复铺行，尾部计数 |
| 跳转 | 真实Discord及短Linear | 使用同项目guild和已解析thread_id，冲突/缺失明确“这张单还没有thread”；href去标题slug |
| 补充数据 | 首屏清晰 | 机器详情、原始Cell与出处进入折叠附录；固定页完整审计sidecar保持无损，独立HTML内联审计 |
| 交互/CSP | 真nonce | 共享脚本保持nonce；发布后验证HTTP200/nonce/无占位符；真实CSP交互验收交QA |
| 体积 | 首屏减小，完整HTML≤512KiB | 固定页E1容量仍≤80KiB；最终真实快照大小及托管URL见implementation-evidence.md |

数据解释：StateStore和CommDB由Lead以不同时间生成只读副本，Linear为读取时现值。源标题按既有Lead裁定原文保留，不做姓名替换。本文件不是ship/QA通过声明。

实际预览：https://fw-reports-624a39.vercel.app/r/f23dd6efeaae92086bc1bb6c9609b80e/ 。HTTP200、266413B、CSP真nonce及零占位符已检查；8根78子单，founder唯一卡FLY-2559指向快照真实thread1549152820345835674。固定bundle40036B，审计sidecar202877B；完整预览内联审计。生成23:57:42Z，读取窗口约6秒。


HIGH修复后预览：https://fw-reports-624a39.vercel.app/r/e9beceaf60a27859d0a4fdaf610d7f93/ 。生成2026-09-15T02:12:41Z，同授权快照+当前Linear；8根78子单，founder2项（FLY-2559及一条身份未知的明确founder checkpoint，保留未知而不虚报空）。fixed40086B/standalone259419B。founder_review/brainstorm轮次无需gate holder，保留为founder事项；旧ship mailbox仍不提供当前ship权威。

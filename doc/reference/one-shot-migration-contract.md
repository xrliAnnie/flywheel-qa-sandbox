# FLY-2166 一次性迁移审计 — 参考契约

Issue: FLY-2166 (https://linear.app/geoforge3d/issue/FLY-2166/fly-2103-遗留-迁移脚本-pre-cutover-审计对真实仓库结构性不可通过g1-receipt-不可获得已手工等价完成迁移)
日期: 2026-08-29
基于: engineering/doc/FLY-2166-pre-cutover-audit-fix/research.md

## 目的

本契约约束会跨配置、数据库、部署阶段的一次性迁移。它不要求所有迁移使用同一种脚本,
但要求审计能在一个真实、明确的时点通过,并让后续阶段验证同一份事实。FLY-2103 的
receipt 设计本身有价值;失败的是它隐含的真相源与交付顺序。

`必须` / `不得` 是 ship gate;`建议` 是实现选择。

## 1. 真相源必须显式声明并先收敛

plan 必须逐项声明:

- manifest 从哪一种状态推导:committed ref、指定 worktree、运行时 effective state,或经
  founder/Lead 裁决的 disposition;
- audit 实际读取哪一种状态;
- 两者怎样证明是同一份事实;
- 多源分叉时,在 audit 前由哪个步骤完成收敛。

manifest 的推导源与 audit 的真相源必须一致。若运行时读取 worktree,而审计读取
`@{upstream}`,就必须先提交/合并现实配置,或提供显式、可追溯、逐项目的 disposition 输入;
不得默认为 committed == runtime。审计的职责是**验证收敛已经发生**,不是替流程完成收敛。

FLY-2103 反例:geoforge3d/growth 的运行时 `doc_flow` OFF 只存在于未提交 main checkout,
committed 仍是 ON。6 行 manifest 按 runtime 推导,审计却按 committed 推导成 8 行;
`assertRetiredKeysMatchCommitted` 只会拒绝,没有任何前序步骤负责把两棵真相收敛。

## 2. 迁移载具与被审计清理必须分离

pre-cutover 工具不得与它要求「仍然存在」的 legacy 状态清理同乘一个 PR/commit。最小安全
交付链是:

1. 独立提交迁移工具与测试,不删除被审计状态;
2. 在真实目标环境完成 dry-run 阳性对照;
3. 完成 pre-cutover apply、exact-set 复核与 receipt;
4. 只有 receipt gate 通过后,清理 PR 才允许合并/采用;
5. 部署后以同一 receipt 验证环境绑定并完成 post phase。

若业务要求单 PR,工具必须能显式读取一个固定 legacy ref,且 receipt 绑定该 ref 的 commit/blob
身份;不能偷偷回退到「当前 checkout 大概等价」。更简单的选择通常是拆 PR。

FLY-2103 反例:flywheel 的 config 清理与脚本同乘 #987。#987 之前 geoforge3d/growth
committed 分歧挡路;#987 之后 flywheel legacy key 已消失又挡路。脚本可运行的每个真实时点
都破坏了它自己的前提。

## 3. 真实环境 dry-run 阳性对照是 ship 硬门

fixture/CI 负责纯函数、失败语义与可重复回归;当迁移审计依赖真实多仓、真实 upstream、dirty
worktree 或真实 DB 时,CI 不能冒充目标环境。ship 前必须另有一个 QA/发布门,在真实目标环境
把 dry-run **跑到 PASS**。

阳性证据至少绑定:

- 每个 repository root、HEAD、upstream ref/commit/blob;
- worktree dirty 投影及其 disposition;
- Bridge loopback origin、Bridge PID/版本与 DB realpath;
- manifest 与当前 exact row set;
- 命令、UTC 时间、exit code 和完整输出。

「跑过且按预期被阻断」只证明负向 guard 有效,不算阳性对照。每个阻断必须回答:
**采取哪一个已排入流程的动作后,在哪个真实时点会 PASS?** 如果答不出来,这是结构设计缺陷,
必须在 ship 前改顺序/真相源/载具,不能把阻断合理化后放行。

FLY-2103 的 fixture 恰好把 geoforge3d/growth 建成 committed OFF;真实仓 dry-run 虽在分歧
处阻断,但从未出现收敛后的 PASS,于是漏掉了「根本没有可通过时点」。

## 4. 分阶段 receipt 模式应保留

receipt 是阶段间防串线的好模式。一个可被 post phase 接受的 receipt 至少绑定:

- schema version、issue/migration id;
- 固定 manifest digest;
- 所有审计输入的 source kind 与不可变身份(commit/blob/content digest 或 disposition id);
- DB realpath 与 canonical Bridge origin;
- pre-cutover exact row set;
- apply 完成时间与生成工具版本/commit。

生成顺序必须是:audit PASS → 所有写入成功 → 对同一 DB readonly exact-set 复核 PASS →
原子写 receipt。dry-run、部分写入或复核失败不得留下可接受 receipt。post phase 必须逐字段解析
并绑定当前环境,写前再次验证 pre-cutover exact set;只检查「文件存在」无效。

FLY-2103 的历史实现保留在 Git:
`scripts/lib/fly2103-project-flag-migration.ts@49b57b3e9f558a3ff30ea348c52b58306b308969`。
可复用的是 receipt 的 manifest digest、环境绑定、原子生成、逐字段 post 校验与 exact-set
模式,不是该一次性脚本的真相源假设。

## 5. Review / ship checklist

- [ ] manifest、audit 与 runtime 的真相源逐项写明且已收敛。
- [ ] 工具与被审计清理分离,或 legacy ref 被显式绑定。
- [ ] 真实目标环境 dry-run 已 PASS,不是只有 fixture PASS/真实阻断。
- [ ] receipt 只在 apply + exact-set 之后原子生成。
- [ ] post phase 逐字段验证 receipt 与当前 DB/Bridge/source identities。
- [ ] 负向测试覆盖缺行、异值、额外行、错 DB、错 source digest、partial apply。
- [ ] QA 报告能指出唯一真实可通过时点;不存在顺序自锁。

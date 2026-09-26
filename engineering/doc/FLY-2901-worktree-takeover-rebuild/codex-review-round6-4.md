# FLY-2901 Codex 设计复核 R6-4（gpt-6-astra xhigh，限定 §4.7a）— 未出书面结论
Issue: FLY-2901
日期: 2026-09-26
基于: plan.md（d0c5722aa，blob 794f3515971bf7b2f76f998c4c491125312e3ca0；续轮对 56b4bc4e4，blob b6d205488cd4cd84f72adb93d08c05a7019813b6）

## 发生了什么
- 同一 companion 线程（池快照 shopping 的隔离 CODEX_HOME）连续两次在运行 git 夹具脚本时被 Codex 服务端内容过滤中断：
  `This content was flagged for possible cybersecurity risk.` —— 两次都没写出报告文件，**没有 VERDICT**。
- 中断前 Codex 的阶段性表述（原文）：「此前 17 个用例已全部通过：14 个应拒绝的场景保留了原字节，3 个正常对照继续成功。现在正用额外夹具核验两个前提：`git diff <target>` 是否会漏掉带 index 标记的规则文件，以及未显式设置 `core.excludesFile` 时的默认规则文件是否受保护。」

## 留下的执行证据（repro-r6-4/，Codex 生成，本节点逐项读过）
| 文件 | 内容 | 结论 |
|---|---|---|
| results.json + new-counterexamples-results.json | 对 d0c5722aa 判据建模重跑 R6 / R6-2 / R6-3 全部 17 例 | 14 例 `expected=blocked → refused-by-plan-model`；3 例对照 `expected=preserved → rescued` |
| boundary-results.json `assume-unchanged-ignore` | `.gitignore` 带 assume-unchanged，工作区改过；S 改 `.gitignore` | d0c5722aa 判据放行 → **丢字节**。56b4bc4e4 的 (f) 拒绝此形态 |
| boundary-results.json `default-excludes-in-worktree` | 未设 `core.excludesFile`，XDG 默认全局忽略文件位于树内并被 S 改 | d0c5722aa 判据放行 → **丢字节**。56b4bc4e4 的 (e) 已扩到默认路径，拒绝此形态 |
| boundary-results.json `skip-worktree-ignore` | 同上但 skip-worktree | 字节保留（无丢失）；(f) 仍保守拒绝 |
| boundary-results.json `untracked-ignore-clean` | 未跟踪的 `.gitignore` 忽略 drafts | 字节保留；clean 删掉未跟踪 `.gitignore` 后草稿变为未跟踪可见 → 事务按 `post_clean_dirty` 停手，无丢失 |

边界：以上是 Codex 在临时夹具中按 plan 判据建模的执行结果，不是生产实现；56b4bc4e4 的 (e)/(f) 本身没有被 Codex 书面确认。

# Code Review — FLY-2921 (Round 8, QA rework 2: merge of origin/main)

Status: APPROVED

审查对象：合并提交 `b69ebc639`（父提交 `845e68f04` 分支 tip、`1f5626254` origin/main；merge-base `d52df7841`）。
评审方式：`codex:rescue` 只读评审，范围限定为本次合并；产品 diff 此前已由 R7 批准。

## 结论

无 BLOCKER / MAJOR / MINOR finding，未发现合并引入或暴露的语义错误。

## 核对项

- **fixture 成员哈希**：7 组、17/17 个 member 均与 `git show b69ebc639:<path> | shasum -a 256` 一致；
  `flywheel-comm/src/db.ts` 钉为 `a150357b7930973d13f2a15025a34f0b3e76b0e9852460bb10d5d2c0253e89f3`。
- **fixture 政策**：`bootstrap-generator` rationale 等于 main 的完整原文再追加 FLY-2921 TURN wake 说明，
  FLY-2911 `getQuestionOrder` 说明原文保留；`runner-patrol-rules.md`、`patrol-runbook` 两组与分支父提交完全一致；
  rationale 说明了行为兼容性与具体变更，不是单纯刷新 digest。
- **db.ts 组成**：`845e68f04..b69ebc639` 只有 main 的 11 行 `getQuestionOrder`（方法体与 main blob 一致）；
  `1f5626254..b69ebc639` 的变更行与 `d52df7841..845e68f04` 的 FLY-2921 变更行完全一致
  （`resumeTurnWakeHold` 返回类型、`claimDueTurnWake.after` 游标、`cancelTurnWakeDelivery` terminal guard）。
- **自动合并的 7 个双改文件**（db.ts、StateStore.ts、event-route.ts、plugin.ts、workflow-engine-dispatcher.ts、
  truth.ts、retention gate config）：逐一读 base→main、base→branch、两个 parent→merge 的完整 diff，
  无丢失或重复注册、无调用签名错配、无跨侧逻辑冲突。StateStore 中 budget migration 之后紧接 two-state migration；
  live 表 CHECK 只允许五个新状态；`settleWorkflowReworkFailure` 调用方不再残留 `onExhausted` / `terminal`。
- **退役字面值与删除符号**：全树命中仅在迁移兼容代码、独立的 carrier / verification 状态机、注释或测试；
  main 新增文件无命中，main 修改的测试无旧签名调用。
- retention gate JSON 合法，双方新增条目都保留且无重复。

## 评审方运行的命令（摘要）

`git merge-tree d52df7841 845e68f04 1f5626254`、`git show --cc b69ebc639 -- compatibility.json`、
两个 parent→merge diff、对 7 个自动合并文件的四向 diff、17 个 member 的 `shasum -a 256`、`jq` 三方比较、
`git grep b69ebc639` 搜索退役状态与删除符号、`git diff --name-only --diff-filter=A d52df7841 1f5626254` 逐文件扫描、
`git diff --check` 与冲突标记扫描。`git show --remerge-diff` 因只读 sandbox 无法建临时 object 目录而改用上述等价证据。
评审方未运行测试套件（本地测试见 implementation.md §8），未做任何写操作。

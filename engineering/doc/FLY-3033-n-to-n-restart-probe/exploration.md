# FLY-3033 N-to-N 重启探针 — 探索
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: 无

## 这张单是什么

FLY-3033 是 FLY-2920 QA 在 529 测试房（slot 2 + extra slot 5）由 `/tmp/fly2920-driver` 派发的**合成单**，生产不派、不动。
按 models.json 哈希，本单 implement 节点分给 **Codex**，用来满足 FLY-2920 driver「Codex 作者 → Bridge 复审」的要求；
标题里的「重启 / 负载演练」说明 driver 可能在任何一步杀掉、重启或挤压实现体。

给房内 runner 的任务：在沙箱仓 `xrliAnnie/flywheel-qa-sandbox` 的 `README.md` 末尾追加一行
`FLY-2920 N-to-N restart probe`，提交推送，请求代码复审，按正常流程交卷。

## 现状盘点（2026-09-28 实测）

- 工作树 `/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-3033`，分支 `project-slot-2-FLY-3033`，remote = `https://github.com/xrliAnnie/flywheel-qa-sandbox.git`。
- 分支与 `origin/main`（`1855f7a1a`）齐平：`origin/main..HEAD` = 0、`HEAD..origin/main` = 0（无 harness 漂移）。远端尚无本分支，也无 PR。
- `core.hooksPath` 指向 slot push-guard（`/tmp/flywheel-test-slot-2/state/push-guard/...`）。
- `README.md` 3 行 / 44 字节：`\n\nFLY-1375 land E2E marker 20260722T023540Z\n`（blob `52e14e03`），末字节为换行。
- 目标行 `FLY-2920 N-to-N restart probe` 在全仓 0 命中；追加后 README 为 4 行 / 74 字节（目标行 29 字节 + 换行）。
- 同房兄弟单（FLY-3029 claude-body、FLY-3030 codex-body，均为 FLY-2919 探针）已在 slot 2 跑通同形态，PR #300 / #299 OPEN。
  FLY-3030 的 plan 经 Codex 3 轮评审定型了「幂等 + 冻结后评审 + 孤儿锁回收」合同，本单直接复用其结构，去掉与本单无关的第 1 轮行与 `sleep 780`。

## 需求拆解

| 需求 | 本设计如何满足 |
|---|---|
| README 末尾追加精确一行 | 字节级断言：行唯一、在末尾、4 行 / 74 字节、相对 `origin/main` `+1/−0` |
| 提交推送 | 普通 push 到 `project-slot-2-FLY-3033`，推送前查白名单，推送后核对远端头 |
| 请求代码复审 | Codex 作者族走实现节点注入的 `request-review --type code`（Bridge 复审）通道；评审对象 = 冻结头 |
| 按正常流程交卷 | 精确头 CI 全绿 → `ask --report` → 注入的 complete 命令（默认 `complete --route needs_review --pr <N>`） |
| 重启 / 负载演练 | 每一步先用 git / GitHub / 文件判据判断「做过没」，任何一步被杀后新体重跑同一套块都收敛到同一终态 |

## 选项

- **A. 一次性脚本（不幂等）**：最短，但实现体在 commit 后、push 前被杀时，新体会重复追加或重复提交。演练单下必然出错。否决。
- **B. 幂等分块 + 冻结后评审（选中）**：复用 FLY-3030 已批准的合同。每块自带判据；milestone 作为字面最后一个 commit 冻结头，评审批准绑定该头，之后不再产生 commit。
- **C. 让 driver / 引擎兜底重复写入**：把幂等责任推给外层，违背「节点自己可恢复」的原则，也让 QA 证据掺杂。否决。

## 非目标

- 不验证 FLY-2920 的整体 N-to-N 结论（死体换体、同 thread 续干、交卷回 thread 由 driver 回执证明）。
- 不改任何 `packages/`、CI、脚本、`CLAUDE.md`；不派单、不合并、不部署、不请求 ship。

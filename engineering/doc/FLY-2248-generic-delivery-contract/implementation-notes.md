# FLY-2248 通用投递合同 — 实施说明
Issue: FLY-2248
日期: 2026-09-02
基于: design-correction.md

## 实际交付范围

本 PR 交付 M1 通用欠条生命周期、超时升级和已接入的 carrier completion 安全核销缝。实现按 family、
attempt、stage、episode 四个通用对象表达，不按特定节点对分支。M2 转移/改派与 M4 冻结正门由 Lead
Tadashi 于 2026-09-02 移交 FLY-2278；M3 工人常驻收信由 FLY-2268 承接。

回放床随范围决定从 6 起收口为 #1/#4/#6：#1 覆盖通用 minted stall；#4 覆盖 `phase_wake` 未 push
会响和刚 push 未超期不响；#6 覆盖 runner-ship carrier completion 的 supersede、settled、缺行
fail-closed 与非 runner-ship authority 负向守卫。#2/#5/#7 随 M2/M4 移交 FLY-2278，未在本 PR 中
伪记为通过。

## QA 与代码审查返工

- QA attempt 2 要求补齐 #4 和 #6 的真实回放；新增 6 条测试，完整对应文件 77/77 PASS。
- code review round 3 发现合法 launch abandon 会留下永久可扫描的 granted 欠条；两条入口均先用
  RED 测试复现，再在 authoritative 事务内以 `source_terminal` set-once 核销，pre-contract 缺行保持
  additive-rollout no-op。两条定向测试 2/2、对应完整文件 74/74 PASS。
- 最终聚焦套件覆盖 FLY-2248、carrier completion、launch abandonment 与 owner routing：
  9 files、180/180 PASS。

## 仓库验证

- `pnpm lint`：PASS，14 条既有 warning、0 error。
- `pnpm -r build`：22 个 workspace PASS。
- `pnpm test:packages:run`：在未改动的两个真实 Terminal.app/AppleEvents 用例上因 resident runner 无法
  连接 macOS HiServices 停止；FLY-2248 聚焦套件无失败。
- milestone layout guard：32/32 PASS。
- 本分支没有新增 `scripts/__tests__/*.test.sh`。

## PR 与后续

PR: https://github.com/xrliAnnie/flywheel/pull/1040

后续 FLY-2278 承接 M2/M4 与 #2/#5/#7；FLY-2268 承接 M3。当前 implement 节点不 dispatch QA、
不请求 ship approval、不合并、不部署。

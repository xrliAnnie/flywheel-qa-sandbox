# FLY-1975 codex-guard state 竞态 — 探索
Issue: FLY-1975 (https://linear.app/geoforge3d/issue/FLY-1975/ci%E8%A7%A3%E5%A0%B5-codex-guard-%E6%B5%8B%E8%AF%95%E5%9C%A8-hosted-runner-%E7%A1%AE%E5%AE%9A%E6%80%A7%E7%AB%9E%E6%80%81%E7%BA%A2statepidjson-%E6%9C%AA%E8%90%BD%E7%9B%98%E5%8D%B3-grep-%E6%8C%A1%E4%BD%8F%E4%B8%80%E5%88%87%E5%90%8E%E7%BB%AD)
日期: 2026-08-21
基于: 无

## 问题边界

`scripts/__tests__/codex-guard.test.sh` 的 active-record 用例在 GitHub hosted runner 上连续两次失败。两次都在启动 wrapper 后约 64 ms 抓到 `state/65995.json`，紧接着 `grep` 报该文件不存在；其余 37 条断言通过。

本单只修测试同步，不改 `scripts/lib/codex-guard.sh`、wrapper、安装器或 CI 编排。完成后测试仍须证明：一次活动调用曾发布完整 identity record，并在正常退出后删除记录。

## 已确认事实

- guard 先同步写 wrapper 的 pre-entry，再启动 child，同步写 child-entry，随后删除 pre-entry。
- 测试以 `find ... -print -quit` 取得任意 JSON 路径，再在循环外 `grep`。若 `find` 命中正被替换的 pre-entry，路径会在 `grep` 前消失。
- 生产写文件使用临时文件加原子 `mv`，未发现“异步落盘”的生产缺陷；失败是测试观察窗口的 TOCTOU。
- hosted run `32541897110` 的 attempt 1、attempt 2 都以 `passed=37 failed=1` 结束，失败位置和 PID 相同。

## 决策梯

1. 不能跳过：它正在阻断全部后续 PR 的 `CI OK`。
2. 使用 Bash 已有条件、`grep` 和 bounded `for`，不加依赖。
3. 不引入 helper、锁、生产同步信号或新的可配置项。
4. 在既有等待循环中只把“找到路径”收紧为“成功读到完整 record”；成功后保存该观察结果，断言不再二次打开可能已删除的路径。

## 验收

- `scripts/__tests__/codex-guard.test.sh` 通过，仍为 38/38。
- 分支的 `Script Tests 2/2` 在 hosted runner 连续两跑通过。
- #916 在包含修复后的基线上 rerun，`Script Tests 2/2` 与 `CI OK` 转绿。
- diff 只有该测试与本单 doc-flow 文档；零生产代码改动。

## 会过期的结论

| 结论 | as-of | 重核方式 |
|---|---|---|
| #916 当前被该断言阻断 | 2026-08-21，run 32541897110 attempt 2 | `gh pr checks 916` 并读取失败 job 日志 |
| guard 当前存在 pre-entry → child-entry 替换窗口 | `origin/main@772a116ed` | 阅读 `scripts/lib/codex-guard.sh` 的 `_codex_guard_run_bash` / `_external` |
| 本分支尚未修改生产代码 | 文档提交前 | `git diff --name-only origin/main...HEAD` 与 `git status --short` |

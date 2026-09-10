# FLY-2454 CommDB 路径返工 — 实施证据
Issue: FLY-2454
日期: 2026-09-09
基于: plan.md

审查 request `53408572-5dfe-45a2-a6c6-f0c9e9dba71a` 在 `7fc824cf9`
返回 CHANGES_REQUESTED。Lead instruction `38377789-3089-4805-bd21-3dc025e6465b`
授权仅处理 CommDB HIGH 及三个指定 MEDIUM；另外三个 LOW 保留 follow-up。

## 变更

- `flywheel-config` 承载共享 commDbRootDir / commDbPathForProject；Bridge 旧模块
  重导出同一函数。ROOT 优先于 DIR，空白忽略，默认仍为 HOME 下的 comm 根。
- Blueprint 的 AdapterExecutionContext、plugin CommDB rollback runtime/lease、
  cleanup 自动发现共用此解析器。edge-worker 源码审计未发现其他 CommDB 路径构造。
- test-deploy manifest 的空数组使用与同脚本其他数组一致的 bash 3.2 nounset guard。
- 契约 `FLYWHEEL_STATE_DIR.unconfinedConsumers` 和 529 路书明确披露两个
  launch-commit consumer 仍写 HOME state；按 Lead 裁定不更改其路径。

## TDD

原始日志 `/private/tmp/FLY-2454-{commdb,plugin,cleanup,array}-red.log`：
Blueprint ROOT / DIR 两个用例得到 HOME 错路径，production fallback 对照通过；
plugin 用真实临时 DB 和当前进程 PID lease 仍报 HOME lease 不存在；
cleanup 实际 openReadonly 捕获到 HOME 库而不是 slot 库；
提取实际 manifest assignment 在 /bin/bash 3.2 下报 empty array unbound。

GREEN 日志 `/private/tmp/FLY-2454-commdb-shared-green.log`、
`/private/tmp/FLY-2454-plugin-green.log`、`/private/tmp/FLY-2454-cleanup-green.log`、
`/private/tmp/FLY-2454-array-green.log`：Blueprint 39/39；plugin + parity 8/8；
cleanup 19/19；实际 manifest assignment 空数组与非空数组均通过。
所有 vitest 使用 forks、maxWorkers=1、minWorkers=1；shell 套件逐个执行。

## 交接条件

本轮完整门禁日志将归档于 `/private/tmp/FLY-2454-commdb-rework/`。
新 exact-head CI 与代码审查必须重新通过，上一头的绿色不能替代。
产品源码已改变，QA 必须按 Lead attempt-2 判据重跑真机 2287 零伤害段；
旧头 `2f0b62338` 的归档仍为历史证据，不宣称新头真机已通过。
本节点不 dispatch QA、不 merge、不 deploy。

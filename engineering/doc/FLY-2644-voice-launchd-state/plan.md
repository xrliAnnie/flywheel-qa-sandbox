# FLY-2644 voice launchd 顶层 state 修复 — 实施计划
Issue: FLY-2644 (https://linear.app/geoforge3d/issue/FLY-2644/2598follow-up-install-voice-launchdsh-%E6%B0%B8%E8%BF%9C%E5%9B%9E%E6%BB%9A-voice-loaded-identity-%E8%A6%81%E6%B1%82)
日期: 2026-09-16
基于: research.md

## 锁定范围

修复 `scripts/install-voice-launchd.sh` 中 `_voice_loaded_identity` 对 launchd 顶层 state 的读取，并在 `scripts/__tests__/install-voice-launchd.test.mjs` 加入主机实见的三行 state 结构。除此之外不改变安装生命周期、回滚权属、plist 形状、host 配置、wrapper 或 voice runtime。

## 实施步骤

1. 测试先行：把 launchctl fixture 的顶层字段改成真实单 tab 缩进，并在 running/refused 两种输出后加入两个更深层级的 `state = active`。保留 happy path 与 refused 阴性控制。
2. 运行聚焦 Node 测试，记录旧 parser 因 state 非唯一而让 happy path 失败、触发 bootout/删除 plist 的红灯。
3. 最小修复：在内嵌 Python 中增加只匹配单 tab 顶层字段的读取函数，仅把 running 模式的 state 判定切换到该函数；path/program/pid 和 identity 模式保持不变。
4. 重跑聚焦 Node 测试和 shell wrapper；必要时仅重构重复 fixture 输出，不扩展生产逻辑。
5. 运行 `bash scripts/__tests__/ci-structure.test.sh`、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，以及本次新增/相关的 `scripts/__tests__/install-voice-launchd.test.sh`。若 aggregate 受已知宿主并发影响，按协议记录完整 receipt 并对未到达套件用单 fork 运行。
6. 更新实施证据、进度和 `engineering/doc/milestones/FLY-2644.md`；里程碑作为打开 PR 前的最后一个 commit。
7. 请求有效 code review，修复 blocking finding 并重新评审；随后 push feature branch、打开 PR，核 exact-head CI，按 `needs_review` route 完成。

## 验收断言

- 顶层 `state = running` + 正 PID + 两行嵌套 active：返回成功，不 bootout，不删除新 plist。
- 顶层 `state = not running` + 两行嵌套 active：返回失败，仍走原有安全回滚。
- 身份不匹配或 bootstrap 后目标被替换：仍不停止/删除非本次拥有的对象。
- 重复安装：仍只 bootstrap 一次。

## 明确不做

- 不执行或模拟成功声称生产主机激活。
- 不手工 bootstrap KeepAlive plist，不更改 FLY-913 护栏。
- 不修改 `launchctl print` 的其他消费者。
- 不改 FLY-2598 的 paired plugin 或语音房间/身份合同。

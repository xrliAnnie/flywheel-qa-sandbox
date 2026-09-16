# FLY-2644 voice launchd 顶层 state 修复 — 实施证据
Issue: FLY-2644 (https://linear.app/geoforge3d/issue/FLY-2644/2598follow-up-install-voice-launchdsh-%E6%B0%B8%E8%BF%9C%E5%9B%9E%E6%BB%9A-voice-loaded-identity-%E8%A6%81%E6%B1%82)
日期: 2026-09-16
基于: plan.md

## 改动

- `scripts/install-voice-launchd.sh`：新增 `top_field()`，只接受恰好一个单 tab 缩进的 launchd 顶层字段；running 模式仅用它读取 state。path、program、pid 的既有全局唯一校验和 identity-only 回滚保护不变。
- `scripts/__tests__/install-voice-launchd.test.mjs`：launchctl fixture 改为真实 tab 层级，正常输出包含顶层 running 加两行嵌套 active；另加顶层 `spawn scheduled`、正 PID、嵌套 running 的阴性控制。

## TDD

红灯（只改 fixture，生产 parser 未改）：

```text
node --test --test-name-pattern "check is read-only" scripts/__tests__/install-voice-launchd.test.mjs
1 test, 0 pass, 1 fail
voice-install: wrapper refused or running PID was not observed
voice-install: installation failed; conditional rollback finished
```

最小修复后：

```text
node --test --test-name-pattern "check is read-only|rejects nested running" scripts/__tests__/install-voice-launchd.test.mjs
2 tests, 2 pass, 0 fail
```

完整 installer suite：10 tests，10 pass，0 fail。

## Lead 指定验证

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/__tests__/install-voice-launchd.test.mjs` | PASS，10/10 |
| `bash scripts/__tests__/launchd-census.test.sh` | PASS，95/95 |
| `bash scripts/__tests__/launchd-units-manifest.test.sh` | PASS，manifest 25 rows / 3 census scopes；package-onboard asset contract PASS |
| `bash scripts/__tests__/flywheel-voice-wrapper.test.sh` | PASS，32/32 |

另有本地 `pnpm -r build` PASS、`pnpm lint` exit 0（只有仓库既有 warnings）、`bash scripts/__tests__/ci-structure.test.sh` PASS。第一次 build 因新 worktree 未安装依赖而失败；`pnpm install --frozen-lockfile` 后原命令通过，未把缺失 node_modules 记为行为失败。

`pnpm test:packages:run` 在 claude-runner 首轮 1341 pass / 2 skip / 0 assertion failures、仅一个允许的 `onTaskUpdate` RPC timeout 后进入自动重试；随后 Lead 以主机 7 路并发会制造假红为由明确要求停止全量，只采用上表聚焦用例与 exact-head CI。该 aggregate 被终止，不作通过声明。

## 边界

本实现没有执行生产 `install-voice-launchd.sh`、bootstrap、bootout、部署、重启或语音房间验证。主机激活仍需代码合入并由标准 updater 部署后，在独立授权窗口重跑安装器；本地夹具与 CI 不替代该证明。

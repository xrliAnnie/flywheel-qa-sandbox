# FLY-1867 playwright-mcp Chrome 泄漏 — 增量设计评审记录
Issue: FLY-1867 (https://linear.app/geoforge3d/issue/FLY-1867/playwright-mcp-chrome-泄漏实例从不回收且有可见窗口盖住-founder-桌面-点击落空)
日期: 2026-08-20
基于: design-correction.md、plan.md

## 评审结果

- Gate question: `7606a7ff-2c99-4926-a900-8f7f4f84516b`
- Review request: `f71d0836-e7c0-4d16-b6b7-e1a3f2ee0bc0`
- Verdict: **APPROVED**
- Blocking findings: 0
- Non-blocking advisories: 11

这轮评审确认 founder correction 后的目标可以实施:Playwright MCP 不被禁用,普通会话 machine default-off,明确 QA / labeled / one-shot 会话 positive opt-in;当前 production Lead allowlist 保持空集;P0 修复已经使用过 browser 的 teardown;P2 只量;P3 只 quarantine。

## 实施时吸收的 advisories

1. optional Lead capability 查询异常安全降级为 disabled,不再让空 allowlist 形成 fleet-wide launch fail-stop。
2. current Lead allowlist 为空时,Lead headless browser 验收明确 deferred;未来任何 `playwrightMcp:true` 身份进 roster 前必须跑 real-launcher 能力验收。
3. P0 总逻辑预算补上 pre-KILL probe:33 秒更正为 34 秒,并新增三候选慢探针断言。
4. 因果模型补入 upstream stdin-close graceful path;真实场景验收分 TERM 与 stdin-only 两组。
5. 写明 `FLYWHEEL_RUNNER_SLIM_MCP=0` 会关闭 Runner positive opt-in,并纳入 cutover preflight / expiry table。
6. census 每行写明 in-scope persistent root 与 known out-of-scope daemon root;profile 必须是 direct `mcp-<browser>-<7hex>`。磁盘普查另覆盖 isolated 与 daemon 根。
7. cutover 指定 approved ship 后走 detached `self-ship-restart.sh`;storm gate hold / partial convergence 均 fail-close。
8. policy writer 两个 timing env 登记为 non-flag test/operator tuning。
9. policy lock 改为 descriptor-based `O_NOFOLLOW` + `fstat` + `fchmod`;`check` 路径完全不创建 lock artifact。
10. dist freshness 除 `artifactBuildSha == HEAD` 外,还拒绝 relevant imported source 的 tracked / untracked dirty tree。
11. 核对 `@playwright/mcp@0.0.79` 的 config < env < CLI merge 顺序与 CLI option surface:没有 `--no-headless`;版本升级后必须重验。

这些 advisories 不改变 APPROVED gate 的有效性;对应代码与文档会进入同一 PR 的 code review。

# FLY-2886 语音后台真机起 parent — 设计复核记录（plan v12 §14）
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886/语音b核心大脑-codex-自带后台-agent订阅与-lead-同权-记忆与上下文三层装载-口语转述关键字段一字不差-等待话术-20)
日期: 2026-09-26
基于: plan.md v12 §14

## 复核参数

- reviewer: `gpt-6-astra`，reasoning `xhigh`，read-only（manifest `design-review-manifest:d0de5225-…:1` 指定模型；未替换）
- 范围: 只审 §14 增量；§0–§13 已批准部分不重开
- R1–R3 为独立线程（R1 全量、R2/R3 附上一轮原文的 scoped fresh 线程）；R3 未通过后按规矩分档报 Lead（问询 `7bfdf448`），Lead 批准「同模型同线程 scoped，审到 APPROVED，范围外新问题停下问」；R4–R7 在同一线程 `01a0ddaf-cc7a-7810-be24-6d1286e2c4d6` 续审
- 原件: `~/.flywheel/qa-evidence/FLY-2886/review-v12-r{1..7}.out`
- 批准的 plan blob: `5e04464bc641006aa4cfa3dba35c06906419967c`（plan 末次修改提交 `d979eaf90`）

## 逐轮

| 轮 | 审的提交 | 结论 | 条目 |
|---|---|---|---|
| R1 | `ec2c394c3` | CHANGES_REQUESTED | B1 `OPENSSL_CONF` 文件本身不在只读清单；B2 覆盖不变式漏掉 `browser: off` 排除；B3 语音档浏览器失败仍造拒绝 handler、简报仍说能开浏览器；B4 60s 预算算错；B5 准入段超时后资源所有权不清；A1 R2 注入场给不出进程退出证据 |
| R2 | `ca4e22bc6` | CHANGES_REQUESTED | B1–B4、A1 关闭；B5 仍开（首次 close 失败后无可重试回收）；N1 R2b 注入点丢 parent 所有权 |
| R3 | `214044303` | CHANGES_REQUESTED | N1 关闭；B5 仍开；N2 我加的「回收失败即整场 `cleanup_pending`」违反 Lead 降级裁定 |
| R4 | `db275f49f` | CHANGES_REQUESTED | B5、N2 关闭；N3 只按组长 pid 判回收会漏存活 helper |
| R5 | `70b19c7e2`+`e5bed7d4b` | CHANGES_REQUESTED | N3 仍开（组长先退出、helper 后出生时永远 ambiguous）；N4 按出生时间判进程组连续性不成立（`setpgid` 可把老进程拉进复用组号） |
| R6 | `d46fe1152` | CHANGES_REQUESTED | N3、N4 关闭（改为精确身份 + 继承所有权 + 冻结再杀；证据断了不杀、上报）；N5 新顺序先回收后撤权 |
| R7 | `d979eaf90` | **APPROVED** | N5 关闭（拆出同步 `revoke()`，固定撤权 → degraded 确认 → 回收 → close → 前台）；NEW_BLOCKERS: none |

## 结论

APPROVED。实现阶段代码评审需专门核：①覆盖不变式（漏装仍 fail-closed、`fail_closed` 档常驻字节不变）；②准入段执行顺序与撤权位；③残留回收只按精确身份动手、从不按组号发信号。

## 已知现状 / PR Follow-ups（Lead 问询 `111f5945` 裁定）

- 常驻 Codex Lead 保持 `fail_closed`：本机无 `~/.gbrain/config.json`、Context7 工具表漂移，常驻 Codex Lead 在本宿主起 parent 同样会失败——现状，非本单引入；写进 PR Follow-ups，不另开单，合入后由 Lead 问 founder。
- Context7 pin 重新登记：列入 PR Follow-ups。

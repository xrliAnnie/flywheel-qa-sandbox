# FLY-1563 跨厂商 Review Verdict

**Issue**: FLY-1563(v2·可见性:铃唤醒 Lead + 真端到端闭环)
**执行 vendor**: claude(v2 DAG generic runner,session `v2dag:9ef8ea4a…:1:c3e704a1…`)
**审查 vendor**: codex(`codex-with-fallback exec`,model_reasoning_effort=xhigh)
**轮数**: 3
**最终判定**: **VERDICT: APPROVED**(R3,2026-07-31,HEAD `d514d236`)

## 各轮记录

| 轮 | 判定 | Findings | 处置 |
|---|---|---|---|
| R1 | CHANGES_REQUESTED | HIGH-1 pid 复用可把铃贴错 pane 且推进 cursor(pid_start 未校验);M-2 `channelHealthy` 被 runner 专属 `mailbox_mcp` 配置门挡住,Lead 健康 channel 会被双响;M-3 e2e「零轮询」表述过宽 | 全部修复:pid_start 贯穿 query→ports→launcher、pane 解析前后双校验 + 回归测试;lease 探测对 lead 无条件 + 真 lease 测试;措辞收窄为「唤醒路径零轮询」并点名测试编排,e2e 在修复后代码复跑 ALL PASS |
| R2 | CHANGES_REQUESTED(原 3 项全 RESOLVED) | MEDIUM e2e-output.log 被 .gitignore 挡住未入分支(证据链断);LOW 报告测试数未同步 | 逐字 log `git add -f` 入分支;报告数字与新增测试枚举同步 |
| R3 | **APPROVED** | 无新问题;报告与已提交 log 时间戳逐项核对一致;5 个 FLY-1563 launcher 测试定向复跑通过 | — |

## Reviewer 声明的环境限制(非代码 finding)

codex 沙箱禁止 Unix socket listen 与进程探测,完整 v2-host/v2-cli 套件在其沙箱内
无法全绿(枚举 78/43 一致);在执行侧真机上六包全绿
(kernel 170 / engine 74 / dag 113 / host 78 / cli 43 / mailbox-mcp 18)。

## 接受的残留(reviewer 知悉,双方一致)

- 重投 assignment envelope 在 host flush 后丢失与成功接收在 DB 上不可区分
  (settle-at-end 使 re-poll 不构成丢失证据)——旧代码同样不可恢复(loud fence),
  等价搬移,非新回归。
- `discord-messenger`(lead-kind 非 tmux 常驻)在 tick 窗口内有 pending 行时
  pane 反查 fail-loud(每高水位一条 `session_bell_failed`)——窗口极小,且真故障
  时该事件是可见性而非噪音。

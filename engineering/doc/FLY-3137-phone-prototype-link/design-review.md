# FLY-3137 手机能打开的原型链接 — 设计评审记录
Issue: FLY-3137 (https://linear.app/geoforge3d/issue/FLY-3137/cloudflaref3-runner-做的能用的原型给一个手机能打开的-https-链接annie-在手机上就能真的点真的存数据)
日期: 2026-10-01
基于: plan.md

Codex 设计评审（reviewer `gpt-6-astra` / `xhigh`，thread `01a0fb19-a209-7311-bd74-eda3fedd0bda`），6 轮，第 6 轮 **APPROVED**。批准对象：plan.md v6（commit `a1f8b3b6a`，blob `56049d2a`）。

| 轮次 | 结论 | 发现 | 主要内容 |
|---|---|---|---|
| R1 | CHANGES_REQUESTED | 6 HIGH / 6 MEDIUM | 路由 token 未配置时放行；自报 pid 可误杀；启动窗口孤儿隧道；先宣告失效后关；卡片协调不闭环；开关不回收现有链接；页面警示缺失；CLI 交接；探活判据；配置权威；TTL 与 gate；`--allowed-mail` 新能力 |
| R2 | CHANGES_REQUESTED | 6 HIGH / 3 MEDIUM | 管理能力与资源 ID 分离；身份不完整恢复；异步观测后的准入；Bridge 离线无人关隧道；未知投递与重复卡；排空条件；文案常量；告警刷屏 |
| R3 | CHANGES_REQUESTED | 2 HIGH / 2 MEDIUM / 1 LOW | 组长消失不等于组消失；Discord 缺权限返回空列表；卡片未收敛判据不统一；租约时限数字；授权措辞 |
| R4 | CHANGES_REQUESTED | 1 HIGH / 2 MEDIUM | 进程组号可被复用、不能凭组号认领；同 nonce 返回旧消息内容；有重复卡时「从未投递」过宽 |
| R5 | CHANGES_REQUESTED | 1 HIGH | `kern.boottime` 随校时变化，不能证明重启 |
| R6 | **APPROVED** | 无 | — |

## 评审过程中的关键设计转变

1. 第 1 版由 runner 侧看守进程管隧道 → 第 2 版起改为 **Bridge 统一起/记/关**，API 不收任何 pid。
2. 第 3 版加入**租约看门程序**：Bridge 停摆时最后续租后 ≤5 分 10 秒隧道自关，硬到期不晚于 `expires_at`。
3. 进程回收从「pid+启动时间」→「进程组号推断」→ 最终定为**只认正向身份**（登记的 pid+启动时间，或参数里精确含本预览专属 `run_dir` 的路径），逐个 pid 发信号。
4. 卡片从「发了就记」→ 三态投递 → 最终按**已知消息事实**收敛：显示状态从消息内容解析；未决投递只有正向结论能清除；「查不到」必须先证明能读历史。
5. 名单门不再依赖 F2：cloudflared 2026.9.3 的 `--allowed-mail` 实测可用（research.md §2.2）。

## 留给实现与 QA 的非阻塞提醒

- 设计批准不替代 plan §10 的实现测试与真机 QA；Codex 全程只做了源码/文档静态审查，没有跑隧道、OTP 登录或 Discord。
- 真邮箱收码登录的会话时长、手机浏览器体验尚未实测（research.md §2.2），放在真机 QA 第 1 条。
- 部署前要把本机 cloudflared 升到支持 `--allowed-mail` 的版本，并按 Annie 的选择写 `projects.json` 的 `prototypePreview`。

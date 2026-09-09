# FLY-2351 快照与磁盘护栏 — 调研
Issue: FLY-2351 (https://linear.app/geoforge3d/issue/FLY-2351/运维磁盘-满盘事故-9-5-0130patrol-repairs-库快照无上限127-份55gb-qa-体往-tmp-拷生产库不回收)
日期: 2026-09-08
基于: plan.md

## R1：CHANGES_REQUESTED

question `08b1d848-f68f-46db-8be9-fe083986f56e`，request `9ba71167-1600-49a8-bc88-f3676e892748`，reviewer session `3ff58a71-8933-4c7a-bf03-9e53083a664c`。2026-09-08 19:47:23 UTC，effective/raw verdict 均为 CHANGES_REQUESTED。1 HIGH、9 MEDIUM、2 LOW；MEDIUM/LOW 非阻塞，不把处理说明当作治理裁决。

| findingKey | 处置 |
|---|---|
| snapshot-runner-owner-binding-contradiction (HIGH) | §2.5/§3.0 区分 workflow、普通 session、operator 三种可执行路径，临时目录获取不看 TURN；三个人工脚本自动在自己的 main 内登记 operator 身份并 finally 回收，不冒充别的 exec。唯一 StateStore resolver 经只读鉴权 endpoint 供 CLI 使用。复核 reviewer 建议的 CommDB resolver 也依赖 TURN，因此没有照搬该建议。补 consumer/owner 阴性测试。 |
| capacity-unavailable-token-allowlist | §6/Block D 明确修改 machine-free-pct.ts 的现有 token Set，测试三种合法 unavailable 不压掉其他指标。 |
| capacity-snapshot-field-shape | 保留 user 指定 disk_avail_gb；元数据嵌套 disk，增加安全整数 availBytes。GB 不舍入，API 可直接按 bytes 判断，删除“唯一数值名”的错误约束。 |
| maintenance-tick-cadence | 改为既有默认约5min、由 TEAMLEAD_STUCK_INTERVAL 控制；不加计时器、不承诺1min。 |
| patrol-cli-resolution | 明确新增同仓 trusted source launcher，从 patrol 自身 realpath 找同目录 helper；source 与已安装 patrol symlink 两条入口都测试，不依赖 Claude Lead 缺失的 env，不额外加全局 binary。 |
| tmp-root-ownership-and-symlink-rule | 只归一系统已知 /tmp 别名；受管根及以下拒绝 symlink，已有根 euid/0700/dev/inode 验证，不改抢占者权限。 |
| retention-unbounded-group-count | 保持 user/Lead 批准的 latest 保留语义；增加 total bytes/group count/unmapped bytes 的每轮日志，不悄悄缩短恢复点保留期。长期数量增长仍是范围边界，交 Lead 判断后续。 |
| lock-hold-and-busy-retry-policy | CLI 总等待90s/最多12次、有界退避、busy退出75+retryable JSON；Bridge 下一 tick 重试；巡检 busy 不继续依赖备份的修复。 |
| no-runtime-kill-switch-for-new-deleter | 非阻塞建议已汇报 Lead；未新增任务外配置。说明现有 worktreeAutocleanEnabled 恒true，不能声称有运行期开关；紧急停止按受控维护停用/部署回滚路径。 |
| five-x-gate-no-operator-override | 不采纳与 issue 冲突的2×/绕过建议；补“先回收可删副本→必要时运维释放/扩容→重新达到5×→备份后修库”的事故路径。不把 db-maintenance 的新备份/VACUUM 当腾空间命令。 |
| stale-code-anchors | 改为实际调用位置，并要求按符号后的成功分支定位。 |
| founder-html-diagrams-pending | §9 显式写待渲染及像素验证未完成。用户任务允许两次本地失败后的占位 fallback；不另请求远程渲染、不宣称 SVG 已交付。 |

R2 必须重新注册正式 review gate/request，不能凭此修订表自批。

## R2：APPROVED（有效 verdict）

question `474fa11b-a184-4db6-a785-e96db921baa9`，request `59742f81-634b-439f-88a2-1d2da10b7227`。2026-09-08 20:01:21 UTC，effective/raw verdict 均 APPROVED，2 MEDIUM + 4 LOW advisories，无阻塞 finding。R1 HIGH 已明确消解；按 runner 合同继续交接，并把 advisories 汇报 Lead。

以下是通过后的 advisory 处置与实施澄清，不声称这些作者修订已经经过另一个审查轮次：

| findingKey | 最终处置 |
|---|---|
| snapshot-owner-endpoint-auth-shape (MEDIUM) | 实查 plugin.ts:1165 确认无 token 时 middleware 放行；plan §3.0 明确 if(config.apiToken) 注册路由、else 503 stub；CLI 复用既有地址/凭据变量。添加独立 route 无配置测试。 |
| operator-owner-missing-process-start-identity (MEDIUM) | owner 与锁共用原生进程启动身份。记录 PID + processStartIdentity，PID消失/明确新启动身份说明原进程死亡；同秒/未知/异常保留。不凭年龄猜，不操作后来复用 PID 的进程。 |
| cli-exit-code-convention-divergence (LOW) | 采纳更少惯例：最终采用现有0/1/2与 JSON reason/retryable，替代 R1 的 sysexits 数字；帮助和配方明确码表。 |
| session-owner-started-at-nullable (LOW) | 明确 NULL/非法 started_at 拒绝，补 pending session 阴性。 |
| retention-unbounded-group-count (LOW) | 保留每轮累计统计与原有20GB Data FINDING；没有未经需求定义的新 retained-bytes 阈值/年龄上限。建议由 Lead 决定后续指标门槛。 |
| no-runtime-kill-switch-for-new-deleter (LOW) | 首轮由独立部署流程先执行实际目录 dry-run-only 并核账，再启动删除器；独立开关继续作为 Lead follow-up，无新增配置。 |

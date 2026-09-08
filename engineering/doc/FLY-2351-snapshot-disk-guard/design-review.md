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

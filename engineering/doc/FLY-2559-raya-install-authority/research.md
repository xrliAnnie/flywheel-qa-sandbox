# FLY-2559 Raya 首装修复 — 调研
Issue: FLY-2559 (https://linear.app/geoforge3d/issue/FLY-2559/2496热修-raya-标准-lead-装不上resident-codex-lead-recoversh-的-wrapper-白名单只认)
日期: 2026-09-14
基于: exploration.md

代码证据：resident-codex-lead-recover.sh load_authority 依赖 plist 并只映射两个 legacy wrapper；lead-restart-lifecycle.sh 同样缺 Raya legacy wrapper；flywheel-lead.sh lifecycle 使用通用 carrier。preflight_executable 拒绝最终 symlink。

选择方案 (a)，因为 C2b 明确要求无 plist 时 --lead 能准备 auth。仅 --authority 增加预装分支；不授予无 plist 的 probe/recover 权限。保持 link-truth 的进程与 launchd fence。

## R1 后消费者审计
- packages/teamlead/src/resident-codex-lead-roster.ts:10：findResidentCodexLeadTargets 要求 codexResidencyPatrol=true、codex backend、canSpawnRunners=false、recognized tier。真实 register 不写 opt-in，因此普通标准注册不自动进入 patrol/health/quota Lead 清单。
- bridge/plugin.ts:7787、11072：quota leadTargets 和 credentialProbe targets 均来自上述 roster。
- bridge/codex-global-health.ts:431-478：authority 解析 codexHome 后检查 home 目录，纳入凭据检查；不证明 launchd 已安装或进程运行。
- codex-quota/host-readiness.ts:141-163：读取 authority home 后还要求 approved manifest 中存在该 home，才纳入库存。额外 stage 字段不绕过此检查。
- scripts/codex-home-link-truth.sh:90-107：authority 解析仅 codexHome/label；随后 launchctl print 拒绝运行中 job，已有进程 fence 保留。
- installed authority JSON 保持三个键；只有新 pre-install 返回 stage，原精确键回归保留。

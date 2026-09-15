# FLY-2559 Raya 首装修复 — 实施计划
Issue: FLY-2559 (https://linear.app/geoforge3d/issue/FLY-2559/2496热修-raya-标准-lead-装不上resident-codex-lead-recoversh-的-wrapper-白名单只认)
日期: 2026-09-14
基于: research.md

## R1 评审与 Lead 裁定
设计 gate d20ae0fc-5bdb-4e13-8778-af0df19e16cd: CHANGES_REQUESTED。HIGH legacy-raya-carrier-reauthorized 已核实：04ff8800a 有意删除 Raya legacy wrapper/launcher/plist 和两处 authority。Lead 已通过 question573b411f-0594-492a-bb47-4142c0853321 明确裁定 supersede C1：仅标准 carrier（含无 plist 首装），退役 legacy wrapper 保持拒绝；standard --authority 不依赖 residency opt-in，probe/recover 保持边界，fixture 必须真实 register 且无 opt-in。以下为已按裁定修订的计划，R2 gate1657535e-29f7-4138-bc9b-75b633d411f6 已 APPROVED（request0b1081ec-0181-4eb4-9199-ef463cac2d47）。

## 范围与设计
1. 保持已退役 Raya legacy wrapper 和未知 wrapper 拒绝；不改公共 destructive restart validator。仅给 --authority 增加标准 flywheel-lead.sh carrier 的 home 解析，以已验证的 registry lead id 推导 home，保留 full-access eligible capability 验证。mufasa/infra-bot 既有路径及三键输出完全不变。
2. 标准 --authority 不依赖 codexResidencyPatrol（真实 register 不写此字段），无论安装前后规则一致。标准 carrier 新分支仅可由 authority_mode 调用；不加入共享 load_authority。--probe/--recover 仍使用原白名单和 residency opt-in，本单不扩大自动 kickstart 面；即使标准 Lead 人工开启 opt-in，也仍拒绝其 probe/recover。
3. 选择方案 (a)：仅 --authority 在 plist 确实缺席（不是 dangling symlink）时接受 pre-install。canonical manifest 和 projects.json 为非 symlink 常规文件；唯一 project/lead、backend、projectDir、projectsFile 一致；full-access eligible selector；仅接受受信任 bin 下非 symlink executable 的标准 flywheel-lead.sh carrier。输出 codexHome、label、wrapper 加 stage: pre-install。已存在坏 plist 不 fallback；有 plist 必须通过现有标准 carrier validator。installed 输出保持原三个键，不放宽既有断言。
4. 消费者审计：link-truth 读取 codexHome/label，并保留其已有 active-process 和 launchd fence；global-health 和 quota runtime 读取 home 用于凭据/配额盘点，不以 --authority 证明进程在役。允许 registered pre-install home 参与凭据盘点，安装/运行状态仍由各自检查证明。实施前补充对应调用点证据，不改消费者运行权限。
5. preflight standalone executable 用 Python realpath + stat 校验：目标为 regular executable、非 world-writable，真实路径位于该 home 的 packages/standalone/；standalone 根不可通过 symlink 跳出。允许 current 和 codex 双 symlink；校验 home 到最终目标目录非 world-writable。Python 调用放入 if 条件，缺失/异常为聚合 FAIL。
6. 明确先 register，再执行 --lead link-truth，最后 verify registered/install。调整 FLY-2496 §4 和标准 Lead runbook 的相应顺序，不改变部署授权或 updater。

## TDD 与验收
先回归留红，再最小修复。修订 C1（Lead 已确认）：标准 Raya plist 解析 .codex-raya，retired/unknown wrapper 继续拒绝，mufasa/infra-bot 不变。C2：双 symlink PASS；外部/前缀同名目录/world-writable 文件或目录/dangling/目录/无执行权限 FAIL。C2b：fixture 由真实 flywheel-lead.sh register 生成，明确断言无 codexResidencyPatrol；真实 link-truth + recover helper，registered 无 plist 链接 auth、inspect already、verify registered 0；标准 install 后 --authority 和重新准备 auth 成功；坏 plist/错 manifest/缺 carrier/无 registry/重复 tuple/不合格 capability 均拒绝。标准 probe/recover 在 installed、pre-install、有无 opt-in 下仍拒绝，且无 launchctl mutation。

测试使用临时 HOME、fake launchctl、fixture credentials。优先扩展现有 CI 注册的 flywheel-lead.test.sh 和 resident-codex-lead-recover.test.sh；若必须新建 shell suite，同步 ci.yml 与 ci-structure.test.sh 固定清单。运行相关 lead/restart/recover shell suites、pnpm lint、pnpm -r build、pnpm test:packages:run；aggregate 仅允许完整 PACKAGE_GATE_RECEIPT 的 RPC-only 失败，未触及包 serial vitest。记录 artifacts、code review effective verdict、新头重审、PR exact-head CI；milestone 为 PR 前最后提交；report 和 complete --route needs_review。生产验收与 QA publish-report 由后续 Lead/QA 完成。

## R2 实施澄清
- installed 标准 authority 精确匹配三参数 argv（/bin/bash、受信 bin/flywheel-lead.sh、canonical manifest），不能从 legacy 失败 fallback 错误推导 home；pre-install 明确拒绝 mufasa-lead / codex-infra-bot-lead 的 legacy home-key 身份。
- 标准凭据 authority 使用公共 generic capability 规则，允许已获 codexRunnerActions 授权的 canSpawnRunners Lead；不是 legacy residency 门槛的等价放宽。backend/profile 不合格或未授权 runner 能力均拒绝。
- C2b 扩展现有 CI 注册的 flywheel-lead.test.sh，直接调用真实 link-truth；未新增独立 suite。
- Runbook 以 FLY-2559 注记补充两个既有文档。标准 carrier 的 residency patrol 未在本单开放；人工设置 opt-in 仍可能得到 uncertain，已报告 Lead 作为已知限制。

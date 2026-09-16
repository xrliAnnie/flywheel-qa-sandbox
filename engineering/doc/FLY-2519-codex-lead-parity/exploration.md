# FLY-2519 Codex Lead 能力对等 — 探索
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: 无

## 目标与范围

让 Honey Lemon 使用 Codex 主持同样完整的部门工作：派 runner、处理 issue 线程、研究与写作、浏览真实页面、更新 Linear/GitHub、巡检并交付报告。MCP 是让模型调用工具的标准接口；“有权限”必须能完成具体动作，不能由配置中出现一个名字推断。

Founder 2026-09-11T17:46:21Z 的指令要求 Claude Lead 的能力面全部对等；浏览器使用 Codex 自己接入的 MCP 浏览器，不用 Claude-in-Chrome。R1–R5 沿用，secret 走 broker 内存通道。Broker 是持有凭证并代为执行动作的可信进程，凭证不交给模型。

本节点只交付设计、评审和 founder HTML；实现与真机验收由后续节点执行。验收必须覆盖原始完整 issue，不以设计评审通过代替已实现。

## 已核验的起点

- 本分支 `26ebc4931` 包含 #1162 合并提交 `8eb581d5b4b353936e3716797b3184ed386dc7f7`。GitHub 返回 mergedAt `2026-09-13T22:14:16Z`。
- 22:37Z 的 Bridge `/health` 返回 build/artifact SHA `4bad8ae269cf96a1858f788ff0977b578f08d176`，admissionPause.active=false。依赖代码合并已成立，生产依赖部署仍未证明。
- 当时 projects.json 的 `flywheel-product-lead` 没有 Codex backend/profile 字段，model=`opus[1m]`、carrier=`v2`；此为注册配置观察，不能证明实际存活线程。不能声称 Honey Lemon 已是 Codex。
- 当前 full-access 仅注册 `lead_actions`，基础为 `discord_send`、`ack_batch`，显式 runner 能力追加六工具。它的配置闸拒绝任何第二个 MCP server。
- full-access 源码明确 `NO broker`，把 bot/Bridge/GitHub 凭证传入 daemon 环境；因此本单“secret 仍走 broker”是一项待修差集，不是已满足条件。
- 本轮未发现可调用的 Linear MCP；issue 正文来自任务注入。可调用 Chrome DevTools MCP 属于当前设计 runner，不是 Honey Lemon 的能力证据。

## 方案比较

| 方案 | 能完成什么 | 代价与结论 |
|---|---|---|
| 复制 Claude 插件、配置与凭证 | 容易出现工具名字 | 引入 Claude 运行时依赖，复制 secret，仍漏 CLI/规则；拒绝 |
| 只新增浏览器并开放更多 env_vars | 浏览器与部分 CLI | 线程读写、规则、巡检、secret 仍有缺口；拒绝 |
| 共用能力目录与现有业务处理器，Codex 原生 MCP 适配 | 全部适用能力逐项兑现；身份、权限和业务规则共用 | 增加可信 broker 适配及真机证据；采用 |

采用方案不是把所有动作放到一个无约束 HTTP 代理。每个动作有固定标识、参数结构、作用域、原有授权检查和结果证据。目录生成 MCP/CLI 帮助与验收矩阵，避免多份名单漂移。

## 需要明确的取舍

1. 对等指可完成同一业务动作，允许供应商不同的工具名；不能以“等价”删除日常能力。runner 六工具、项目读写、研究/PM skills 都保留。
2. 浏览器选 Chrome DevTools MCP 的可见独立 Chrome；不用个人默认浏览器 profile，不把 founder 登录态隐式转授。
3. 原 full-access 的 project write/network 保留。操作凭证移到可信进程，认证 CLI 提供同功能受管入口；未经限制的凭证输出和任意认证 HTTP 请求不属于业务能力。
4. Claude 的 ambient MCP/skills 也进入盘点：Linear、gbrain、Xiaohongshu、Context7、终端/inbox、Discord fork、PM 与 HTML 等。不能只交付 issue 举例的几个工具。
5. FLY-2459 的生产迁移由独立 updater 执行。FLY-2519 在同一部署机制上增量安装能力，不新增 watcher、重启入口或 successor 调度器。

## 非阻断沟通

- 审计报告 `f69dc685-f0c0-4ce4-a34f-170ca0de4de9` 已持久入队；即时 nudge 超时不撤销该报告。
- 架构问题 `cda893ee-a0cc-41e8-ba66-ffb05fb4a480`：确认现有 full-access secret 传递与本单要求的冲突；提出结果型 broker、凭证文件读取隔离、CLI 等价适配。等待意见期间继续独立设计，不把等待当 blocked。
- 任务明确授权完成 full design 且禁止请求 brainstorm approval；通用 brainstorm/research/write-plan 的额外人工确认、版本号修改和目录移动按本任务 DOC-FLOW 覆盖。设计评审仍必须有效 APPROVED。

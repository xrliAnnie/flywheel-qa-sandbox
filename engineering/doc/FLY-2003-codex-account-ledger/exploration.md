# FLY-2003 Codex 三号台账与单号收敛 — 探索
Issue: FLY-2003 (https://linear.app/geoforge3d/issue/FLY-2003/账号台账-codex-接号器整理三号对齐身份自动记账杜绝错账)
日期: 2026-08-24
基于: 无

## 问题重述

当前 Codex 接号链路把“账号名字”当成了身份事实：`codex-profile status` 只读 `.active` sidecar，runner fallback 遇到认证错误或额度错误会执行 `next`，账号池还残留 `personal1`、`personal2`。因此直接 `codex login` 改写 `auth.json` 后，sidecar 仍可能显示旧名字；自动轮换又会把坏掉或额度封顶的备份号带进新 runner，最终出现“显示一个号、实际使用另一个号”的错账。

Founder 最新裁定把目标从“三号自动池”改成：

- 本机日常 Codex 全部停在 `personal`；
- 台账只承认 `school`、`personal`、`business` 三个规范身份；
- `school`、`business` 仅作人工切换的备份，不进入自动路径；
- 身份展示以 `auth.json` 内的真实 claim 为准，sidecar 只能作为提示；
- 额度接近耗尽的提醒需求保留为后续方向，但不能用静默换号代替。

Lead 进一步裁定：Claude 现有 `com.flywheel.quota-monitor` 与 Claude 自动切号不在本单修改；本单只做 Codex fallback 非轮换、身份/状态工具、三号台账。机器级 quota warning 属于新的告警层，受 Founder「禁新增告警层」红线约束，整个移出 FLY-2003；runner-only 半覆盖也不做，避免给出虚假安全感。

## 不变量

1. **真实凭证优先**：账号标签必须由 `auth.json` 中 JWT 的 email/account id 推导，不能由目录名或 `.active` 单独决定。
2. **默认停在 Personal，人工备份可用**：正常状态下全局 home 停在 `personal`；新建 runner 必须验证凭证属于三号 registry。人工把全局 home 切到 `school`/`business` 后，新 runner 明确继承该 canonical backup 并发出诊断，而不是让整个 runner birth 断掉。unknown/zombie/malformed 才 fail closed。
3. **备份号只手动切**：所有自动 `next`、429 自动轮换、认证失败自动轮换均退出产品路径；失败应原样暴露并给出明确人工操作提示。
4. **只承认三号**：`personal1`、`personal2` 不再参与 list/use/fallback；现存目录迁移留给部署步骤，以可恢复方式隔离，不在开发 worktree 中直接操作生产凭证。
5. **无秘密落盘**：台账只保存规范 label、email、account id、plan、观测时间/来源、home fingerprint 与 primary/manual-backup mode；不保存 token 或明文 home path。
6. **并发安全**：多个 runner 同时观测同一个 personal 时，不应通过共享读改写 JSON 制造覆盖损坏。
7. **不新增告警层**：不改变 Claude quota daemon，也不在 runner/Lead/Bridge 新增 Codex quota warning；需求留档后另立 Founder-gated follow-up。

## 方案比较

### 方案 A：在现有 shell 上做最小修补

保留 `flywheel-codex-profile` bash 实现，增加内嵌 Node JWT 解码；删除 `next`，修改两个 fallback 为单次执行；runner provisioning 校验 personal。

优点是改动小。缺点是身份解析、三号映射、台账写入会散落在 bash、TypeScript 和测试夹具中，日后再次漂移的概率高；额度观测也没有自然的单一数据模型。

### 方案 B：建立 Codex 账号事实模块，shell 只做薄入口（推荐）

在 `claude-runner` 内建立一个无 token 输出的账号事实模块，统一负责：

- 解码并校验 `auth.json` 的 JWT claim；
- 将真实 email/account id 映射到三号规范 ledger；
- 对比 sidecar 并报告 drift；
- 校验 `use <label>` 的源凭证与目标 label 一致；
- 为 provisioning 提供 `assert canonical identity`；
- 把 status/use/save/provisioning 的身份观测写入无 token 的三号台账，形成“实际用了谁”的可追溯事实。

`flywheel-codex-profile` 保留为操作员入口，但 `list/status/use` 调用同一个事实实现；`next` 明确拒绝并提示人工 `use`。runner daemon wrapper 不再捕获失败后轮换，只负责保持长驻 app-server 的进程语义；全局 one-shot guard 保留超时/孤儿清理，但移除账号轮换。

优点是“身份事实”只有一份，测试可以覆盖 login 直写造成的 sidecar drift、错标签 profile、未知账号、canonical provisioning 和三号过滤。按账号分片的原子观测也避免共享 read-modify-write。缺点是需要把现有 shell 测试升级为真实 JWT fixture，并增加少量 launcher wiring。

### 方案 C：扩展 Claude quota daemon 为多供应商总控

让 `com.flywheel.quota-monitor` 同时轮询 Claude 与 Codex，再由统一 AlertHub 决定提醒或切号。

长期可能形成统一控制面，但本单会把 Claude 的成熟自动切号路径和 Codex 的新 manual-only 策略耦合，扩大回归面，也违反 Lead 的明确边界，因此不采用。

## 推荐产品行为

采用方案 B，并把用户可见行为固定为（默认隐藏完整 email）：

```text
$ codex-profile status
Actual profile: personal
Identity: x***@gmail.com
Sidecar hint: school (DRIFT)
Mode: primary (automatic switching disabled)
```

`use school|personal|business` 是唯一切号入口。执行前后都验证真实 claim；目录名正确但里面放错 token 时拒绝复制。`next` 返回非零并解释“automatic switching retired”。未知账号不猜测成最接近的 label，而显示 `unknown` 并阻止 runner birth；三个 canonical 身份都可由 Founder 人工选作当前凭证。

global 与 isolated home 的命令作用域必须显式分离：机器级 `~/.local/bin/codex-profile` 无条件绑定 `$HOME/.codex`，忽略环境中偶然继承的 `CODEX_HOME`；runner-private wrapper 显式传入自己的 home。不能把一个“ambient `CODEX_HOME` wins”的 executable 同时暴露成 global 命令。

quota wall 出现时，fallback 原样返回失败并明确提示人工 `status/use`；本单不产生 Alert、不解析 pane、不新增监控 daemon。后续若 Founder 批准告警层，再基于结构化 app-server 数据独立设计，不能把半覆盖逻辑偷偷塞回本 PR。

## 边界

本单不做：

- 修改或重启生产 launchd 服务；
- 自动修复 `business` 的 `refresh_token_reused`，或替 Founder 完成网页登录；
- 绕过 `school` 的 quota wall；
- 改 Claude account ledger / quota monitor；
- 新增 Codex quota monitor、Bridge warning event 或 runner-only 水位提醒；
- 把 FLY-1999 的 Lead persona/home 隔离问题并入本单；
- 在 PR merge 时触发部署或服务重启。

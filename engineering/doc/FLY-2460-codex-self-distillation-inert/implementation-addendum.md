# FLY-2460 Codex 准入蒸馏通道 — 实施计划补充
Issue: FLY-2460 (https://linear.app/geoforge3d/issue/FLY-2460/2355b3-codex-自蒸馏从不触发runner-家里模型拿不到原生-memory-工具memory-stage1-后台任务从不跑)
日期: 2026-09-09
基于: plan.md

授权：Lead 对 question `d2b3af31-0299-4cfb-a916-be8486d51509` 的回复 批准 bounded reconciliation。本文记录其替换范围，pinned `plan.md` 保持原字节，不重写已审设计。本文是实施合同补充，不是验证已通过的证据。

## 替换 plan §3.7 / C6 的开关载体

删除原 raw env 开关 `FLYWHEEL_CODEX_MEMORY_DISTILL`，不保留读取、warn/fallback、文档推荐或 env 透传入口。改用既有 SQLite managed flag `codex_memory_distill`，默认 ON。registry `scope='project'` 表示既支持标准 `*` 全局默认行，也支持标准项目 override；不能改成拒绝项目覆盖的 `bridge_global`。

按现有 `readScopedBoolean` 规则解析：项目行优先，缺失则取 `*` 行，两者都缺失时取 registry 默认 true。沿用 store bool codec，写入值为字符串 `0`/`1`（false/true），CLI 仍为 `--to off`/`--to on`。不要把 env 的 `off` 文本存进 DB，也不新造平行配置解析器。`clear` 删除项目行后继承 `*`，清除 `*` 后回到默认；普通项目覆盖优先级不变。

`run-infra.ts` 在构造 Codex adapter 时读取该项目的有效值并传入 `memoryDistill.enabled`。新构造的 adapter 能看到已 apply 的变更；现存 adapter 和运行中任务保留构造时值。此项不承诺热更新、不增加监听/轮询，也不要求 Bridge/Lead 重启。adapter dependency 中显式 `enabled=false` 保留，用于测试和已有注入调用方控制。

关闭后的功能合同不变：不注入 admission hook，零通道 RPC、零通道 DB 访问、零蒸馏回执；正常 runner 和原生 Codex 后台语义不变。其余候选、屏障、预算、回执、keyed 家边界、E1–E4/E6/E7 维持 pinned plan。E5 的 env 操作替换为本项目的 governed flag off/new-adapter 验证，操作路书见 `qa-runbook.md` §4。

## 既有治理入口与证据

现有 CLI `node packages/flywheel-comm/dist/index.js feature-flags set --name codex_memory_distill --to off --project <scope> --reason <reason> --bridge-url <owned-slot-url>` 会依次调用 `/api/fleet/flag/stage`、`/api/fleet/flag/apply`，apply 消费 stage 的 confirmToken；`feature-flags apply` 为 set 别名。没有独立 stage CLI 子命令，不直接修改 `flag_values`。

来源：`packages/flywheel-comm/src/commands/feature-flags.ts` 的 usage 和 set/clear 分支；`packages/teamlead/src/bridge/flag-routes.ts` 的 project scope、`0/1` canonical 与治理写入；`packages/config/src/feature-flags/store-policy.ts` 的 scope 注册和 codec；`packages/teamlead/src/bridge/flag-store-runtime.ts` 的 `readScopedBoolean` 优先级。slot CLI 必须显式 `--bridge-url` 并核对 room-info 身份/port/DB，避免 CLI 默认生产 endpoint。

实施验证应覆盖 registry/store 纳管、缺省 ON、`*` override、项目 override 优先及 clear 继承、0/1 codec、构造前 apply 生效、构造后旧 adapter 不变、新 adapter 取新值、dependency disabled、无 raw env 路径，以及真实生产接线 RED→GREEN。治理测试与房间 CLI 回执分别保留，单元接线通过不能证明真实任务首轮可读。

## 验证资源约束

Lead 对 question `f20ffd87-3a7a-412d-a9b1-b3048f2af57e` 的回复允许本轮临时排除 GUI-only 测试。所有 Vitest 调用必须串行，并固定 `--pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`；不得同时启动多个 Vitest 实例规避限制。不运行 `**/tmux-viewer.macos.test.ts`。记录临时排除的具体测试与理由，恢复临时测试配置后保留恢复证据；排除后的 gate 结果准确标注限制，不声称原样全仓 gate 全绿。此约束不减少代码审查和 529 E1–E6 真实验收要求，也不改变 E7「无自然人口，本单不证明」。

## Code review rework：单次批量与回执硬化

Lead response `633d9903-4650-4a6f-8507-7874df6a4b63` 批准替换 pinned plan 的批量 8：候选 hints 和原生 `memories.max_rollouts_per_startup` 同时最多为 **2**。默认 ON、300 秒绝对截止不变，不增加 backlog drain、回填或后台巡逻。超过八条历史任务的回归及 529 backlog-cost 验证覆盖积压场景。该回复亦批准同轮修复下述 MEDIUM/LOW；pinned plan 保持原字节。

- token 是尽力观测：完成屏障已经证明的 `readable_ready` / `stage1_done` / `partial` 不被后续 token 读取超时或取消覆盖；token 不可用独立记账。
- rollout 文件大小不是候选资格：单条 stat 失败保留候选、字节记 0，`rolloutBytesAvailability=unavailable`；总大小标记 unavailable，数值仅为已知文件的合计，不解释为完整成本或零成本。
- 同步 SQLite busy wait 每次最多 5000ms，且不超过剩余截止。锁失败按既有失败路径返回，不增加重试循环。只读连接不修改 Codex 表，但 SQLite WAL 可能创建 `-shm` 协调文件；不宣称文件系统零写入。
- `homeKind` 复用 `codex-home.ts` 的受管 agents 子树判定，不再根据任意路径段猜测。

最终复审期间冻结整个 HEAD，包含 progress 文档；不得用新的进度提交使评审失效。Lead 要求本轮一次最终 push、一次最终 review；新 HIGH 停止并报告。测试框架 RPC 超时遵循 response `ec2684c3-ea52-40d4-98d9-ddcc71154cc9` 的一次整包复跑裁定，不循环复跑。

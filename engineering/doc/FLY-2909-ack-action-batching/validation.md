# FLY-2909 ACK 开关返工 — 实现验证
Issue: FLY-2909
日期: 2026-09-26
基于: plan.md

## 行为与红绿证据

- 首先 pin `e10312c5a^` OFF 与 `f75e35f14` ON 四个规则源的 SHA。旧代码的两个 OFF 测试失败；接线后 2×2 通过。
- Codex v2 capability selector 的 ON 测试在未接线时失败；加入同一启动 reader 后通过。最终本单规则测试 10/10，含 shell/capability 缺开启资源的拒绝路径、两种载体和 Bootstrap 源字节。
- 只读 SQLite launch 测试覆盖默认关、项目覆盖、* 继承、clear 恢复默认、ON→OFF、缺库/非法值回退、shell reader 真实 dist 调用、读取不建库/不迁移/不改字节。治理 stage/apply 通过。

## 本地验证边界

均为指定文件或 changed-file `vitest related`，未运行整包 suite。

- config `vitest related src/feature-flags/registry.ts src/__tests__/feature-flags-drift.test.ts src/__tests__/feature-flags-registry.test.ts --run`：21 文件、381 测试通过。
- teamlead 首轮 related（flag-store-runtime、launch reader、rule-sources、default-runtime）：189 文件，187 通过；2586 pass / 3 fail / 1 skip。3 个失败均已定位并在下述范围复验，保留首轮结果，不把首轮说成全绿。
- 两个 ON 源路径断言在运行期间资产迁往已有打包的 lead-rules-base 后读到旧路径；最终 `vitest related src/lead-capabilities/rule-sources.ts src/__tests__/lead-ack-action-batching.test.ts --run`：23 文件、373 测试全部通过。
- DAG 恢复用例首轮返回 404；无相关代码修改，单用例重跑 1 pass，整文件重跑 72/72。该初次失败不能作为新功能证据。
- `git grep -lF` 对生产改动的完整路径、文件名、父目录发现消费者，逐匹配保留/排除清单见 consumer-audit.json。直接消费者 Vitest：20 文件、386 测试通过。规则/bootstrap/预算另 5 个指定文件 50/50；原有 token-savings 字节/digest/Bootstrap 检查通过。
- `pnpm --filter "flywheel-teamlead..." build`、最终 teamlead build、`pnpm lint` 退出 0。Lint 保留仓库既有 warnings。依赖类型检查 `pnpm --filter "...flywheel-teamlead" --filter "...flywheel-config" typecheck` 在补建缺失的 `flywheel-voice-bridge...` 产物后通过。
- shell 消费者最终结果另见 shell-validation.json；两个基线失败：fly231-companion-launch-plan 的五个 golden 未含现有 visible-tui-default.md；screencap-skill-gate 的夹具未定义 IS_COS_ROLE。两者用隔离的 f75e35f14 源码与同一依赖产物复现，分别仍为 49 pass/5 fail、2 pass/2 fail，未改无关快照/夹具。
- 本次新增 legacy ON 副本触发 residue 精确路径登记遗漏；仅追加既有 three_stage_turn 的新副本路径后，`fly1674-residue.test.sh` 86/86。未扩大检测模式或白名单范围。

## 尚需独立证据

本地通过不证明真实 Lead 会遵守规则，也不证明 529 真批次的 lease/ACK/重投/唤醒无回归。QA 必须按 qa-handoff.md 取得 Claude 与 Codex ON/OFF 真实证据，并请求冻结头 full exact-head CI；实现节点仅走代码评审与 needs_review，不请求 full CI、不 dispatch QA、不合并或部署。生产开关由 Lead 合入上线后打开观察。

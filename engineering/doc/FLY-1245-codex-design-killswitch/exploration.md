# FLY-1245 design 段 Codex↔Fable kill-switch — 探索

Issue: FLY-1245 (https://linear.app/geoforge3d/issue/FLY-1245/add-flywheel-three-stage-codex-design-kill-switch-toggle-three-stage)
日期: 2026-07-14
基于: 无

## 1. 问题

Fable 配额是反复的瓶颈。Annie 的诉求（2026-07-14 直令）：

- **Fable 没了 → design 阶段用 Codex；Fable 回来 → 切回 Fable。**
- 长期按任务分（复杂=Fable，简单=Codex），但当前只要能「改 env + 重启 Bridge」快速切换即可。

三段式 pipeline（Design → Implement → QA）的每段 vendor/model 由
`resolvePhaseDispatch(phase, env)`（`packages/config/src/three-stage-phases.ts`）决定。
现状：

- **implement 段**已有 kill-switch：`FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0` → 从 codex 回落 (claude, heavy)。
- **design 段**没有对称开关，硬编码 `{ vendor: "claude", model: MODEL_TIERS.heavy.id }`（= Fable）。要在 Codex/Fable 间切只能改代码 + 重新 build + ship。

## 2. 期望结果

加一个对称的 `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` 环境开关：

- `=1` → design 段派发 `{ vendor: "codex", model: "gpt-5.6-sol", effort: "xhigh" }`（Annie 标准 Codex 配置）。
- 不设 / `!= "1"` → 现状 `{ vendor: "claude", model: heavy }`（Fable），**字节不变**。
- 只需「改一行 `~/.flywheel/.env` + `restart-services.sh --bridge-only`」即可切换，无需改代码。

## 3. 关键非对称（必须在注释里写清）

两个开关方向相反，因为两段的默认 vendor 不同：

| 段 | 默认 vendor | 开关语义 |
|----|------------|---------|
| implement | **codex**（默认） | `FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=0` → 回落 claude |
| design | **claude/Fable**（默认） | `FLYWHEEL_THREE_STAGE_CODEX_DESIGN=1` → 切到 codex |

即：implement 是「默认开 codex、`=0` 关」的 default-on kill-switch；design 是「默认关 codex、`=1` 开」的 opt-in。命名一致（`FLYWHEEL_THREE_STAGE_CODEX_<PHASE>`），方向由各段默认 vendor 决定。

## 4. 主要影响面（探索所见，research.md 深入）

1. **`resolvePhaseDispatch`** — 唯一改动点（加 design 分支）。
2. **feature-flags drift 守卫** — `env.FLYWHEEL_THREE_STAGE_CODEX_DESIGN === "1"` 会被 `feature-flags-drift.test.ts` 的布尔比较正则扫到 → **必须**在 `FEATURE_FLAGS` 注册，否则 CI 红。
3. **cross-family review 影响** — design=Codex 后，design 产出由 Codex 写 → design review 变成「Claude 审 Codex」。需确认这条 review 记录路径成立、不撞 FLY-1231 那类 verifiability gap（research.md §3 核实，结论：现有 FLY-1188 基建已自动支持，零代码改动）。
4. **display/tag 路径** — `phaseMessageTag` / issue-display 已经读 `resolvePhaseDispatch`，自动跟随开关（design=Codex 的 pending 行会显示 GPT-5.6 而非 Fable，与 FLY-1224 R1 #3「不给 codex 行显示 Fable」一致）。零额外改动。
5. **vendor 派发管线** — entry (`resolveThreeStageEntry` → `resolvePhaseDispatch("design", env)`) 已把 `dispatchVendor/dispatchModel/dispatchEffort` 传到 spawn（`role-adapter-resolver.ts` `VENDOR_TO_EXECUTOR`）。design=Codex 复用 implement 已验证的 FLY-1224 管线，端到端成立。

## 5. 假设（surface）

- Codex design 段的 model/effort 与 implement 段一致（`gpt-5.6-sol` / `xhigh`）= Annie 的标准 Codex 配置，ground truth `~/.codex/config.toml`。issue 明确如此。
- 默认 off 是硬要求（字节兼容）。
- 本 issue 只做「一键 env 切换」基建，不做「按任务复杂度自动分流」（那是后续，issue 明说「长期按任务分」是方向不是本次范围）。

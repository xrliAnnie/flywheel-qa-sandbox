# FLY-2671 选号与选卡阶梯 — 实施计划
Issue: FLY-2671 (https://linear.app/geoforge3d/issue/FLY-2671/codex-额度b1-选号-选卡阶梯纯函数-离线重放测试给定三个号的重置时刻与账本状态输出唯一确定)
日期: 2026-09-17
基于: 无

> **For agentic workers:** 按本计划内联执行；行为改动必须先写失败测试、确认 RED、写最小实现、确认 GREEN。不得接入兑卡执行链、宿主切号或自动重起。

**Goal:** 把“全线停摆时推荐烧哪个号的哪张卡”固化为无时钟、无 I/O、无宿主副作用的确定性纯函数；同时用现有切号选择器的离线特征测试证明“有额度的号里选周重置最早者”没有漂移。

**Architecture:** `selectCodexQuotaCandidate` 是已上线的分支 A 权威，本单不改它的接口、实现或 coordinator，只补特征测试。新增 `selectCodexResetCredit` 实现分支 B 的 PRD §4.6 阶梯：输入规范化的三号周窗状态与卡库存快照，输出一个 `selected`（账号、显式 creditId、一句理由、结构化判据）或一个显式 `no_recommendation`；每个缺失/排除项都作为有序 exclusions 返回。

**Tech Stack:** TypeScript、Vitest、pnpm monorepo、现有 `flywheel-teamlead` 包。

---

## 锁定范围、假设与方案

### 两个分支，不混规则

- **分支 A：还有周额度。** 现有 `selectCodexQuotaCandidate` 已按 `重置最早 → 剩余额度最多 → profile 字母序` 选号。本单只加离线特征测试，不增加 N1 理由文案，不改运行期切号路径。
- **分支 B：周额度全线停摆。** 新纯函数执行 PRD §4.6：有卡且周重置已知 → 卡先于本号回血过期者优先 → 否则周重置最晚 → 剩卡最多 → `business < personal < school` → 号内过期最早的卡（同刻按 `creditId`）。
- `weeklyQuota` 只表示**周窗**；`shortWindowQuota` 单独携带 5h 窗。5h 满但周窗未满必须返回 `quota_available`，绝不推荐兑卡。
- `auth: invalid` 从候选剔除并返回独立 `auth_invalid` exclusion；`auth: unknown` 与有效身份号的 `weeklyQuota: unknown` 都不能被当成全线停摆。只有 `auth: valid && weeklyQuota: available` 才命中 `quota_available`。

### 未实调协议假设

卡输入形状来自 PRD §4.3 P1b 引用的上游 schema（`availableCount`、`credits`、`id`、`expiresAt`），我方尚未完成 B0 真机实调，也没有真实样本。B1 只定义/测试规范化后的纯输入；协议读取与 normalizer 不在本单接线，后续接入单必须在 B0 证据与 schema 不一致时修订本类型，不能用本计划冒充实调证明。

### `credits` 截断与缺失的 fail-closed 语义

- `availableCount` 是“剩卡最多”的唯一张数来源；不得用 `credits.length` 代替。
- 可见且安全可选的卡必须同时满足：`available === true`、非空唯一 `id`、`expiresAt` 为安全整数 epoch ms。
- `credits === null`、任何 `available === null`、任何 `available === true && expiresAt === null`，或 `availableCount > 可见安全卡数`（后端截断）时，无法证明拿到的是该号最早过期的卡；整个号进入 `credit_details_unknown` exclusion。明确 `available === false` 的卡不参与可见安全卡计数。
- `availableCount < 可见安全卡数`、负数、重复 card id、重复/缺少 profile、非法时间属于 `invalid_input`，不抛异常。
- 因此 §4.6 ③与⑦只在卡明细完整时运行，不会把截断列表上的次优卡当成“最早过期”。
- BigInt 张数比较用 `<` / `>` 三元 comparator，绝不用 BigInt 相减作为 `Array.sort` 返回值。

### `no_recommendation` 唯一优先级

多种失败并存时，顶层 `reasonCode` 按下列全序取第一个；所有逐号原因仍按 `business, personal, school` 固定序保留在 exclusions 中：

1. `invalid_input`
2. `quota_available`
3. `quota_state_unknown`
4. `auth_state_unknown`
5. `all_candidates_excluded`
6. `no_usable_account`
7. `reset_time_unknown`
8. `card_count_unknown`
9. `credit_details_unknown`
10. `no_available_credit`

`excludedProfiles` 表达 consume `noCredit` 后的纯重算；三个号全被排除时固定落到 `all_candidates_excluded`。

### 方案比较

1. **现有切号选择器不动 + 新建窄选卡函数（采用）**：不复制认证/新鲜度规则，不碰 coordinator，B1 只交付纯决策。
2. 新建统一“切号或兑卡”函数：会复制已上线切号合格性规则，未来容易漂移。
3. 把卡阶梯塞进 coordinator：会把 B1 与 B2/B4/B8 混在一起，越过 founder approve、FLY-2523 与 consume 调用面边界。

## 文件结构

- Modify: `packages/teamlead/src/codex-quota/__tests__/codex-quota-candidates.test.ts` — 只加分支 A 特征/重放测试。
- Create: `packages/teamlead/src/codex-quota/reset-credit-selector.ts` — PRD §4.6 纯选卡阶梯、理由与显式失败落点。
- Create: `packages/teamlead/src/codex-quota/__tests__/reset-credit-selector.test.ts` — 每一级阶梯、缺失/截断/阴性对照与重放测试。
- Create last: `engineering/doc/milestones/FLY-2671.md` — 按仓库约定记录交付，作为 PR 字面最后一笔提交。

## Task 1: 锁定现有分支 A 行为（零生产改动）

**Files:**

- Modify: `packages/teamlead/src/codex-quota/__tests__/codex-quota-candidates.test.ts`

- [ ] **Step 1: 加特征测试**

  用三个固定 profile 的新鲜、有效、未 limited 观测证明：周重置较早者胜出；重置同刻时剩余额度较多者胜出；再同刻时 profile 字母序胜出；缺失 reset 排在已知 reset 之后。对三号输入六种排列重复执行并断言选中 profile 相同。

- [ ] **Step 2: 运行特征测试**

  ```bash
  pnpm --filter flywheel-teamlead exec vitest run src/codex-quota/__tests__/codex-quota-candidates.test.ts
  ```

  Expected: GREEN；若现有实现不满足才停下按 bug 处理，本单不预先设计生产改法。

## Task 2: 用 TDD 实现 PRD §4.6 纯选卡阶梯

**Files:**

- Create: `packages/teamlead/src/codex-quota/reset-credit-selector.ts`
- Create: `packages/teamlead/src/codex-quota/__tests__/reset-credit-selector.test.ts`

- [ ] **Step 1: 先写失败测试**

  测试先导入尚不存在的 `selectCodexResetCredit`，表驱动覆盖：

  1. 5h 满但周窗可用 → `quota_available`；周窗或 auth 未知 → 对应 unknown，不能假装全线停摆。
  2. 登录失效单独 exclusion，且不与额度混报；仍有合格号时可继续选择。
  3. `availableCount` 缺失/为零、`credits === null`、卡明细截断、`available === null`、`expiresAt === null` 各有确定 exclusion；仍有合格号时继续选，全部排空时按固定优先级返回 `no_recommendation`。
  4. `weeklyResetAt` 缺失的号无被选资格；三个都缺失时返回 N9 对应 `reset_time_unknown`。
  5. 卡早于本号周重置过期者优先；多个命中时卡过期最早者优先。
  6. 必烂卡到期同刻时继续按周重置最晚、剩卡最多、固定 profile 序破平。
  7. 无必烂卡时选周重置最晚；平手依次按 `availableCount`、`business < personal < school`。
  8. 定号后选过期最早的卡；同刻按 `creditId`；单一候选使用 `sole_candidate` 理由码。
  9. `excludedProfiles` 模拟 `noCredit` 后排除原推荐并重算；三个全排除 → `all_candidates_excluded`。
  10. 每个 `no_recommendation` 优先级各一例，并有多因并存反序输入测试证明结果不变。
  11. 三号输入全部排列、卡数组正反序、重复执行时完整结果深相等，且输入对象不被修改。

- [ ] **Step 2: 运行新测试，确认 RED**

  ```bash
  pnpm --filter flywheel-teamlead exec vitest run src/codex-quota/__tests__/reset-credit-selector.test.ts
  ```

  Expected: FAIL with module/function missing；不是夹具、语法或导入路径错误。

- [ ] **Step 3: 写最小纯函数实现**

  公开合同：

  ```ts
  export type CodexQuotaProfile = "business" | "personal" | "school";
  export type QuotaState = "available" | "exhausted" | "unknown";

  export interface CodexResetCreditState {
    id: string | null;
    expiresAt: number | null; // epoch ms；null = 明细未知，不参与安全选择
    available: boolean | null; // null = 状态未知，不当作 available
  }

  export interface CodexResetAccountState {
    profile: CodexQuotaProfile;
    auth: "valid" | "invalid" | "unknown";
    weeklyQuota: QuotaState;
    shortWindowQuota: QuotaState | "not_applicable";
    weeklyResetAt: number | null;
    resetCredits: {
      availableCount: bigint | null;
      credits: readonly CodexResetCreditState[] | null;
    } | null;
  }

  export type CodexResetSelectionExclusionCode =
    | "explicitly_excluded"
    | "auth_invalid"
    | "reset_time_unknown"
    | "card_count_unknown"
    | "credit_details_unknown"
    | "no_available_credit";

  export interface CodexResetSelectionExclusion {
    profile: CodexQuotaProfile;
    reasonCode: CodexResetSelectionExclusionCode;
  }

  export type CodexResetCreditSelection =
    | {
        kind: "selected";
        profile: CodexQuotaProfile;
        creditId: string;
        weeklyResetAt: number;
        creditExpiresAt: number;
        availableCount: bigint;
        reasonCode:
          | "credit_expires_before_reset"
          | "latest_reset"
          | "most_credits"
          | "profile_order"
          | "sole_candidate";
        reason: string; // 恰好一句；不承担 N3 时区渲染
        exclusions: readonly CodexResetSelectionExclusion[];
      }
    | {
        kind: "no_recommendation";
        reasonCode:
          | "invalid_input"
          | "quota_available"
          | "quota_state_unknown"
          | "auth_state_unknown"
          | "all_candidates_excluded"
          | "no_usable_account"
          | "reset_time_unknown"
          | "card_count_unknown"
          | "credit_details_unknown"
          | "no_available_credit";
        reason: string; // 恰好一句，说明为何不能安全推荐
        exclusions: readonly CodexResetSelectionExclusion[];
      };

  export function selectCodexResetCredit(
    accounts: readonly CodexResetAccountState[],
    options?: { excludedProfiles?: readonly CodexQuotaProfile[] },
  ): CodexResetCreditSelection;
  ```

  `reason` 只表达选择层级，例如“business 的 card-b 会在该号周重置前最早过期。”或“候选在前序阶梯全部平手，按固定账号序选择 business。”；B2 若渲染 N3，必须用返回的 `weeklyResetAt` 等结构化字段套 PRD D.1 正本文案，而不是直接发送本字段。

- [ ] **Step 4: 运行新测试，确认 GREEN 并重跑 Task 1**

  ```bash
  pnpm --filter flywheel-teamlead exec vitest run src/codex-quota/__tests__/reset-credit-selector.test.ts src/codex-quota/__tests__/codex-quota-candidates.test.ts
  ```

  Expected: 两个测试文件全部通过。

- [ ] **Step 5: 仅在全绿后重构**

  只抽局部 validator/comparator/reason helper；保持公开类型与结果不变，再运行 Step 4。

## Task 3: 项目级验证、审查与交付

**Files:**

- Create: `engineering/doc/milestones/FLY-2671.md`（最后提交）

- [ ] **Step 1: 运行要求的验证**

  ```bash
  pnpm lint
  pnpm -r build
  pnpm test:packages:run
  ```

  另运行所有新增/改动测试；若聚合套件仅出现允许的 `onTaskUpdate` RPC 错误，保留完整 PACKAGE_GATE_RECEIPT，不谎报 aggregate green。

- [ ] **Step 2: 提交代码并请求 exact-head code review**

  提交代码与测试并推送，再按注入流程 `gate review_code` → `request-review --type code` → `check`；CHANGES_REQUESTED 必须新提交、新门、新评审，不复用旧头。

- [ ] **Step 3: 最后一次进度更新后写里程碑提交**

  最终代码审查与验证结果确定后，先执行最后一次 `flywheel-comm progress`，再创建 `engineering/doc/milestones/FLY-2671.md` 并单独提交；此后不再生成仓库提交，使它成为 PR 的字面最后提交。

- [ ] **Step 4: 推送、开 PR、核 exact-head CI**

  PR 只含纯函数、测试、计划、进度与里程碑；不含 consume、幂等键、自动切换、自动重起或宿主配置。等待当前 PR head 的 CI，不沿用祖先 head。

- [ ] **Step 5: 报告并按固定 route 完成**

  通过 `flywheel-comm ask --report` 报告 exact head、聚焦测试、聚合验证、review、CI 与边界，然后运行：

  ```bash
  PR_NUMBER="$(gh pr view --json number --jq .number)"
  node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route needs_review --pr "$PR_NUMBER"
  ```

  不派发 QA、不 merge、不 deploy、不 restart。

## 需求覆盖自检

| 要求 | 计划证据 |
|---|---|
| 同输入离线重放永远同一号/同一卡 | Task 1 的三号排列；Task 2 的三号/卡序反序与重复深相等 |
| 缺失字段有确定落点、不抛异常、不静默 | 有序 exclusions + `no_recommendation` 全序优先级测试 |
| 有额度时选重置最早 | Task 1 直接特征化现有权威函数 |
| PRD §4.6 每一级 | Task 2 用例 3–8 |
| §8 选号相关阴性对照 | auth 失效、周窗/5h 分离、卡数/明细/重置缺失、全未知、`noCredit` 排除重算、完全同刻平手、还能用时不兑卡 |
| 截断列表不误选次优卡 | `availableCount > 可见安全卡数` 整号 fail-closed + 表驱动用例 |
| founder approve/一次只烧一张/调用面封死 | 本单不调用 consume、不生成幂等键、不接执行链；留给 B4 |
| FLY-2523 前不启用自动切换/重起 | 本单无运行期 wiring、feature flag、部署或重启 |

# Exploration: FLY-152 Ship Options — Annie 拍板用

**Issue**: FLY-152 (Lead reply discipline — shared channel default to cos)
**Date**: 2026-05-11
**Status**: Draft — 待 Annie 拍板
**Source**: `doc/engineer/plan/inprogress/v1.27.0-FLY-152-lead-reply-discipline.md` §6 (Test Plan)

---

## 1. 背景

PR #180 已经通过 Codex design review (3 轮) + code review (Round 1 fix 已合)。Layer 1 (unit, 15 tests) 全过，CI 现在绿。

**剩下未跑的是 Layer 3 — 真 Discord E2E。** Plan §6.3 假设可以用 FLY-96 4-slot QA framework，但 qa-fly-152 在崩溃前发现：

> **FLY-96 framework 是 per-Lead channel 设计** — 看 `scripts/test-slots.example.json`，每个 slot (`flywheel-test-1` 到 `flywheel-test-4`) 有自己独立的 `channelId` (`cos-test`, `lead-test-1`, `lead-test-2`, `lead-test-3`)。FLY-152 要测的场景是 **3 个 bot 同时订阅同一个 channel**（`#geoforge3d-core` 的 production topology），FLY-96 sandbox 没法模拟。

FLY-152 的 multi-Lead cascade（同一 message → 3 个 bot 各自决策）**测不了**，至少在现有 sandbox 框架下不行。

所以现在需要 Annie 拍板：要不要花时间补 E2E，怎么补。

---

## 2. 5 个 Option

### Option A — Annie 手动在 prod shared channel 发 fixture message

**怎么操作**:
1. Worker 把 PR #180 + GeoForge3D companion PR 合到 main，按 plan §7.2 走 deploy（fresh Lead sessions）。
2. Annie 在 `#geoforge3d-core` 顺序贴 Section A 的 14 条 fixture message + Section B 的 triage cascade（共 ~15 个 case），每条 ≥30s 间隔。
3. Annie 自己肉眼 + Discord MCP `fetch_messages` 对每条 case 数 replier set。
4. Pass criterion = 每条 case 的 observed set === expected set（同 plan §6.3 step 6）。

**风险 / 测不到的场景**: 无 — 这是 ground truth，跑的就是 production topology。但是：
- Prod 上 3 个 Lead 的真实 session 长 context，可能比 fresh session 更顽固（也可能更软），结果有 variance。
- 一旦发现 regression，rollback 是 revert 2 个 PR（plan §7.3 已经覆盖）。
- 真 message 进 prod channel 会留痕，需要 Annie 接受 noisy core channel 1-2 小时。

**时间**: Annie ~45 min（15 条 case × 1.5 min: post + wait + check）。Worker ~30 min（deploy + assist）。

**推荐度**: ★★★★☆ — 最权威。在 production 上得到的 verdict 是最有说服力的。Cost = Annie 45 min 的时间 + noisy core channel。

---

### Option B — Annie 把 MCP bot 加到 test guild 跑端到端

**怎么操作**:
1. 在 sandbox Discord guild 里新建一个共享 channel（比如 `shared-test`）。
2. 把 4 个 test bot (`flywheel-test-1..4`) 都拉进 `shared-test`。
3. 给 framework 加一个 "shared channel" 模式：每个 slot 的 Bridge 配置都订阅同一个 `shared-test` channel 而不是 per-slot 的 `lead-test-N`。
4. Test slot 的 identity.md inject "Peter" / "Oliver" 名字 + 对应 bot ID。
5. Worker 跑 Section A 的 14 条 + Section B 的 triage cascade。

**风险 / 测不到的场景**:
- 改 framework 不 trivial。`scripts/test-deploy.sh` + `ProjectConfig` 现在按 per-slot channel 写死，要么加 `sharedChannelId` 字段 + Bridge route 改造，要么 hack 让 4 个 slot 都用同一个 `channelId`（可能撞 channel-isolation rule）。
- 改完后是新 framework code，单独需要 review + test。
- "fresh sandbox" 的 Lead 没有 production memory + history，反应跟 prod 不一定一致。Prompt-only 的概率性也存在。

**时间**: Worker ~3-4 hour（framework patch + 跑 E2E + 跑完写 report）。Annie ~0 min（Worker driven）。

**推荐度**: ★★☆☆☆ — 工程量大但 verdict 不一定比 Option A 强。本质是为了 "不打扰 prod" 而做的 sandbox 改造，但 prod-mirror topology 才是真正的 verdict source。建议留给后续如果 reply discipline 要长期 regression 的时候再做。

---

### Option C — Webhook 模拟多 Lead 反应（伪造 message）

**怎么操作**:
1. Worker 写一个 script，向 3 个 Lead 的 tmux pane 各塞一条同样的 message（用 `tmux send-keys` 或 inbox-mcp），观察各 Lead 的输出。
2. 不走真 Discord — 直接看 Lead 的 transcript，看 reply 决策是否符合 plan §4.4 的 decision flow。
3. 跑 14 个 Section A scenarios。

**风险 / 测不到的场景**:
- **不测 Discord plugin 的 routing 行为** — Lead 收到什么 message 是 Discord plugin 决定的，Webhook 模拟 bypass 了 plugin 的 mention parsing / channel filter。
- 不测 typing indicator / reaction / Discord 的 rate limit。
- 真实 production 的 `<@BOT_ID>` mention 字符串是 Discord 渲染的，模拟 message 可能字符串不完全一致。
- 本质上是 Layer 1.5（比 unit 多走了 Lead session，比 Layer 3 少走了 Discord）— 看不到 plugin 那一层的 bug。

**时间**: Worker ~2 hour（写 script + 跑 + 解读 transcript）。Annie ~0 min。

**推荐度**: ★☆☆☆☆ — 不推荐。绕开了 Discord plugin，没法 catch routing bug。如果 Option A 实在不行，Option C 是退而求其次，但不应作为 default 路径。

---

### Option D — 跳过 E2E，只看 Layer 1 unit + paper trace

**怎么操作**:
1. Layer 1 (15 unit tests) 已经过，验证 base rule 文件的 contract phrase 都在。
2. Plan §6.2 scenario trace 已经 paper-trace 了 14 个 Section A + Section B cascade，每条都标了 expected replier set 和 why。
3. Ship 时只声明 "Layer 1 通过 + paper trace 完整，Layer 3 deferred"。

**风险 / 测不到的场景**:
- 测不到 LLM 实际行为。Plan §8 已经说明 prompt-only 是 probabilistic — paper trace 是 design intent，不是实际 runtime verdict。
- Half B 的 `MUST NOT REPLY` 是不是真被 LLM 严格执行 — 没数据。Plan §8 的 mitigation 是 "如果 E2E variance 大 → 升级到 deterministic gate"，但跳过 E2E 等于绕开这个 fallback signal。
- Annie 的 primary complaint（Peter/Oliver pile-on）就是 LLM 不听话造成的，这正是需要 E2E 验证的核心点。

**时间**: 0 min。

**推荐度**: ★★☆☆☆ — 严格意义上违反 plan §6.3 的 "all three layers required"。但是因为 reply discipline 是 *prompt-only*（没有 deterministic gate），Layer 3 的 verdict 不能 100% 代表 prod；这削弱了 "必须跑 Layer 3" 的论据。如果 Annie 接受 "prompt-only 本来就有 variance，先 ship 看 prod" 的逻辑，Option D 等价于 Option E。

---

### Option E — Ship + prod observe（先 ship，prod 上观察实际行为）

**怎么操作**:
1. Merge PR #180 + GeoForge3D companion PR。按 plan §7.2 deploy（fresh sessions）。
2. **第一天观察期**: Annie 正常使用 `#geoforge3d-core`。Worker / Annie 注意：
   - 出现一次 "all 3 bots reply to nameless message" → regression，rollback。
   - 出现一次 "named Lead 不 reply" → bug，rollback or quick-fix。
   - 出现 1 次 false-positive 名字 match（如 "Petersen" 触发 Peter reply）→ 记录到 backlog，per plan §3 接受 v1 trade-off。
3. 一周后跑一次 spot-check（plan §7.2 step 5 的 3 条 sanity message），如果还是预期行为 → 关 issue。

**风险 / 测不到的场景**:
- Prod 是 verdict 源，但 cost 是真用户（Annie）撞 bug。
- 没有 controlled scenario coverage — 14 个 Section A case 里有些 corner case（past-tense brief ack 不带 action verb）可能要等几天才碰到。
- 如果 Annie 一周都没碰到 corner case，那个 case 永远没 verdict（覆盖率 ≠ 100%）。

**时间**: Annie 长期 ~0-10 min（只在 spot check + 出 bug 时）。Worker ~30 min deploy。

**推荐度**: ★★★★☆ — 实用主义最优。Prompt-only 的本质是 probabilistic + production-defined，sandbox 给的 verdict 也不是 100%。先 ship 给 Annie 顺便压测，遇到 regression 用 plan §7.3 的 rollback 兜底。Cost ≈ Option A，但不需要 Annie 集中 45 min 时间。

---

## 3. Worker 推荐

**首选 Option E（Ship + prod observe）**，理由：

1. **Prompt-only 的本质限制** — plan §8 风险表第 1-2 行已经承认 LLM 可能仍忽略 `MUST NOT REPLY`，且 mitigation 是 "升级到 deterministic gate"。Sandbox E2E 跑过也不能保证 prod 100% 同样行为。Verdict source 永远是 prod。
2. **Cost / value 比** — Option A 要 Annie 集中 45 min 跑 15 条；Option E 把那 45 min 摊到一周的自然使用里，Annie 不用专门腾时间。
3. **Rollback 已经设计好** — plan §7.3 完整覆盖 revert 路径 + intermediate state semantics。Ship 不是单程车票。
4. **Layer 1 + paper trace 已经覆盖 design correctness** — 真出问题只能是 LLM 不听话，而 LLM 不听话不会被 sandbox E2E 抓到（同一个 LLM 在 sandbox 和 prod 都可能不听话）。

**次选 Option A** — 如果 Annie 想要在 ship 前看到一次 controlled verdict，Option A 是最实在的。Annie 45 min 换一个 production topology 的 ground truth verdict。

**不推荐 Option B/C** — Option B 的 framework 改造工程量大且 verdict 不更强；Option C 绕开 Discord plugin，看不到 routing bug。

**Option D 等同 Option E** — 跳过 E2E 跟 "先 ship 看 prod" 在 prompt-only 系统里没本质区别，只是 Option E 把 "看 prod" 这件事明示出来了。

---

## 4. 决策快速参考

| 你想要 | 选 |
|--------|---|
| 最权威的 pre-merge verdict | **A** |
| 最省 Annie 时间，接受 prod 上压测 | **E** |
| 长期持续 regression coverage | B（但建议作为 follow-up issue，不阻塞 FLY-152 ship） |
| 完全不碰 Annie 时间 + 不上 prod | C / D（都有明显缺陷） |

**Worker 推荐: E** — ship 后请 Annie spot-check 一次（plan §7.2 step 5），出 bug rollback。

---

## 5. 决策后下一步

- Annie 选 A → Worker 准备 deploy + assist；Annie 跑 15 条；Worker 收集 verdict 写到 PR comment；通过 → 合 PR。
- Annie 选 B → Worker 重启 work，先改 framework，再跑 E2E（增加 1-2 day）。
- Annie 选 C → Worker 写 script，跑 transcript-level verify。
- Annie 选 D → 直接合，scenario trace 已经在 PR commit history 里。
- Annie 选 E → 合 PR，按 plan §7.2 deploy；spot check post-deploy。

不管哪个 option，**ship 前需要 GeoForge3D companion PR** —— plan §7.1 + §7.3 都强调两个 PR 要一起 ship（flywheel base + GeoForge3D project 层）。GeoForge3D PR 还没建。这也是 Annie 决策前需要知道的事。

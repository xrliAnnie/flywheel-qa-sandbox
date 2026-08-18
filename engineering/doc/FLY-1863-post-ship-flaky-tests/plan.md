# FLY-1863 拆引信(main 红告警已裁出) — 实施计划

Issue: FLY-1863 (https://linear.app/geoforge3d/issue/FLY-1863/p0main-红-869-引入的两条-post-ship-finalization-测试在-main-上就失败-ci-ok)
日期: 2026-08-17
基于: research.md
Status: codex-approved(codex-design-review 4 轮,R4 APPROVED)

> **2026-08-17 founder 范围裁决(优先于下方原计划):**修法 B `main-red-alert` 是独立问题,从 FLY-1863 整体裁出。本单仅执行修法 A:相对时钟种子 + 冻结钟守卫;不改 ci.yml、不新增告警脚本或 webhook secret。下方 Step 3 保留为历史设计与独立问题输入。

## 目标

1. **拆引信(病灶 A)**:`post-ship-finalization.test.ts` 的 `seedLandOperationClaim` 从"绝对未来时间戳"改为"相对真实时钟派生",两条被炸用例在任何真实时刻都自包含地绿;并加一条**冻结时钟 + 精确 offset 断言**的回归测试把"种子必须相对时钟"这个性质本身锚死(任何绝对字面量 —— 2026 也好 2099 也好 —— 立即红)。
2. **已裁出 → 独立问题(病灶 B)**:原计划由 ci.yml 新增 `main-red-alert` job;本 PR 不实现。
3. 产出同形状潜在引信排查清单(bounded,只报不修)。

**生产代码零字节改动**(StateStore / post-ship-finalization 不碰);不调分片、不 skip(Lead 禁令)。

## 改动文件(裁决后实现侧恰 1 个)

| 文件 | 动作 |
| --- | --- |
| `packages/teamlead/src/__tests__/post-ship-finalization.test.ts` | Step 1 种子相对化 + Step 2 回归测试 |
| `.github/workflows/ci.yml` | **已裁出,本 PR 不改** |
| `scripts/ci/notify-main-red.sh` | **已裁出,本 PR 不新增** |
| `scripts/__tests__/notify-main-red.test.sh` | **已裁出,本 PR 不新增** |
| `scripts/__tests__/ci-structure.test.sh` | **已裁出,本 PR 不改** |

## Step 1 — 拆引信:种子相对时钟化

```ts
function seedLandOperationClaim(store: StateStore) {
	// FLY-1863: recordLandOperationStep validates lease_expires_at against the
	// real clock (new Date()), so the lease here must be relative to now — an
	// absolute future literal is a wall-clock time bomb.
	const base = Date.now();
	const operation = store.ensureLandOperation({
		issueId: "FLY-102",
		projectName: "flywheel",
		prNumber: 1832,
		approvedHead: "a".repeat(40),
		now: new Date(base - 1_000).toISOString(),
	});
	const claim = store.claimLandOperation({
		operationId: operation.operation_id,
		ownerId: "land-worker",
		now: new Date(base).toISOString(),
		leaseExpiresAt: new Date(base + 60 * 60 * 1_000).toISOString(),
	});
	if (!claim) throw new Error("test land claim missing");
	return { operationId: operation.operation_id, ownerId: claim.ownerId, generation: claim.generation };
}
```

保持原有相对顺序(created < claimed < lease),仅把锚点从硬编码换成真实 now。`claimLandOperation` 的入参校验与 due 判定只比较注入值,自洽;单文件跑 ~13-15s,1h lease 余量充足。

**TDD 顺序**:RED 已天然存在 —— 修前单跑该文件 = `2 failed | 38 passed`(research §2);改后同命令 = `40 passed` 为 GREEN。

## Step 2 — 时钟性质回归测试(冻结 epoch + 精确 offset 断言)

R1 指出单纯"+400 天跑 happy path"锚不死性质:任何晚于 fake epoch 的绝对字面量(如 #875 的 2099)仍能溜过。改为**直接断言种子产物相对 fake now 的精确 offset**,再跑 happy path:

```ts
it("land seed derives from the clock — absolute literals fail here (FLY-1863 time-bomb guard)", async () => {
	// Fake only Date; timers/promises stay real so the async fetch/archive
	// mocks behave exactly as in the neighbouring tests.
	const fakeBase = Date.now() + 400 * 24 * 60 * 60 * 1_000;
	vi.useFakeTimers({ toFake: ["Date"], now: fakeBase });
	try {
		const landOperation = seedLandOperationClaim(store);
		const operation = store.getLandOperation(landOperation.operationId);
		// Property anchor: any absolute timestamp in the seed — 2026, 2099,
		// anything — breaks these exact-offset assertions immediately.
		expect(operation?.lease_expires_at).toBe(new Date(fakeBase + 60 * 60 * 1_000).toISOString());
		expect(operation?.created_at).toBe(new Date(fakeBase - 1_000).toISOString());
		const result = await runResumablePostShipFinalization(/* :885 同款 happy-path opts */, /* 同款 deps */);
		expect(result).toMatchObject({ complete: true, outcome: "completed" });
	} finally {
		vi.useRealTimers();
	}
});
```

注意事项:(a) `toFake:["Date"]` 不碰 timers,与真异步 mock 无交叉;(b) `finally` 恢复真实时钟,不污染 `:1273` 之后的 fake-timers 用例群;(c) `created_at` 若 `ensureLandOperation` 实际落的列名不同,implement 节点以实际 schema 为准改断言字段,**offset 语义不变**;(d) 验收含一次**临时 2099 突变 RED 证明**:把种子 lease 临时改回绝对 `"2099-..."`,本用例必须红,随即还原(改判据必须拿真数据跑一次)。

## Step 3 — main-red-alert(ci.yml + 脚本 + hermetic 测试)【已裁出 → 独立问题】

> 以下 Step 3 不在 FLY-1863 执行,仅保留为历史设计输入。

**3a. 脚本** `scripts/ci/notify-main-red.sh`:

- 输入(env):`WEBHOOK_URL`、`NEEDS_JSON`、`RUN_URL`、`HEAD_SHA`、`COMMIT_TITLE`、`RUN_NUMBER`、`RUN_ATTEMPT`。
- `WEBHOOK_URL` 空 ⇒ stderr 报错 + exit 1(**fail-loud**,不许静默跳过 —— 告警静默烂掉就是病灶 B 本身)。
- **投递确认语义(R1 #2)**:Discord webhook 默认 `wait=false` 时 2xx 不证明消息已保存 —— 脚本对 URL 安全追加 `wait=true`(兼容已带 query 的 URL),`curl -fsS --connect-timeout 5 --max-time 20 -H 'Content-Type: application/json' --data-binary "$payload"`,捕获响应并 `jq -e '.id | type == "string" and length > 0'`;任何一步不满足 ⇒ exit 非零。
- payload 由 `jq -n --arg` 构造(转义安全),`COMMIT_TITLE` 只取首行截 80 字符,并带 `allowed_mentions: { parse: [] }`(commit title 是不可信内容,禁 `@everyone`/role mention 注入)。
- 消息形态(单条):`🔴 main CI 红: <failed top-level jobs> | <sha9> <commit title> | run #<run_number>.<run_attempt> | <run URL>`。

**3b. ci.yml 新 job**(追加;同 PR 内同步改 `ci-structure.test.sh`,见下):

```yaml
  main-red-alert:
    name: Main red alert
    runs-on: ubuntu-latest
    needs: [quick-gate, unit-tests, script-tests, payload-distribution]
    if: >-
      always() && !cancelled() &&
      github.event_name == 'push' && github.ref == 'refs/heads/main' &&
      contains(toJSON(needs.*.result), 'failure')
    steps:
      - uses: actions/checkout@v4
      - name: Notify Discord alerts channel
        env:
          WEBHOOK_URL: ${{ secrets.DISCORD_MAIN_CI_ALERT_WEBHOOK }}
          NEEDS_JSON: ${{ toJSON(needs) }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          HEAD_SHA: ${{ github.sha }}
          COMMIT_TITLE: ${{ github.event.head_commit.message }}
          RUN_NUMBER: ${{ github.run_number }}
          RUN_ATTEMPT: ${{ github.run_attempt }}
        run: bash scripts/ci/notify-main-red.sh
```

要点:(a) `ci-ok` 的 `needs` **不含**本 job ⇒ PR 聚合门字节不变;pull_request 事件下本 job 恒 skip;(b) `needs.unit-tests` 是 matrix,聚合语义 = 任一腿 failure 即 failure;(c) 上游 fail 级联 skip 时 `needs.*.result` 仍含那个 `failure`,告警照发;(d) 动态值全部经 env 入 shell,无 `${{ }}` 内插进脚本体。

**告警语义与三个显式接受边界(R1 #5 + R2 #1,产品决定,不在实现时临场扩)**:
- 语义 = "**每个完整跑完、未被取消且为红的 main push run attempt,投恰一条告警**"(attempt 级,非 run_id 级 —— 无状态 job 保证不了跨 attempt 的 exactly-once,不为此引入 durable dedup)。
- 边界 1(cancel-in-progress):ci.yml `concurrency` 对同 ref `cancel-in-progress: true`,后续 main push 会取消在途 run ⇒ 一个已出现 failure 但还没走到 alert job 的 run 可能被取消而不告警。**接受**:取消意味着有更新的 main run 接管,若红仍在,新 run 会告警;main 的"当前状态"始终被最新完整 run 覆盖。
- 边界 2(needs 粒度):下游只见直接依赖 job 的聚合 result ⇒ 消息只能列 top-level job 组(如 `unit-tests`),列不出 `teamlead 2 of 3` 具体腿。**接受**:run URL 一跳可达明细;不为腿级明细引入 workflow_run 二级设计。
- 边界 3(rerun 重复):GitHub "Re-run all/failed jobs" 会让同一 `run_id` 的新 attempt 再投一条。**接受**:人工 rerun 本就是有人在看的场景,重复告警无害;消息带 `run #<run_number>.<run_attempt>`(env 加 `RUN_ATTEMPT: ${{ github.run_attempt }}`)便于辨认。

**3c. hermetic 测试** `scripts/__tests__/notify-main-red.test.sh`:PATH shim 假 `curl`(捕获 URL/method/headers/body,可编程返回体)。断言:失败 job 名进消息;消息含 `run #<RUN_NUMBER>.<RUN_ATTEMPT>`;`WEBHOOK_URL` 空 ⇒ exit 1;curl 非零 ⇒ exit 非零;**curl exit 0 但响应空/畸形/无 `id` ⇒ exit 非零**;返回合法 message id ⇒ exit 0;URL 已带 query 时 `wait=true` 拼接正确;payload 是合法 JSON、含 `allowed_mentions.parse == []`;含换行/引号/`@everyone` 的 `COMMIT_TITLE` 不破坏 payload 也不产生 mention。新 suite 注册进 ci.yml script-tests + Quick Gate 的 shell 枚举守卫。

**3d. `ci-structure.test.sh` 同步(R1 #1,必改否则新 job 被确定性拦下)**:`:54-64` 的精确 job 集加入 `main-red-alert`;新增结构断言:exact `needs` 四元组、`if` 含 `push`+`refs/heads/main`+failure 条件、step 走 `scripts/ci/notify-main-red.sh`、env 键集完整(含 `WEBHOOK_URL`/`NEEDS_JSON`/`RUN_URL`/`HEAD_SHA`/`COMMIT_TITLE`/`RUN_NUMBER`/`RUN_ATTEMPT`,secret 名正确)、**`ci-ok.needs` 不含 `main-red-alert`**。

**3e. 一次性 setup —— merge/ship 的前置门(R1 #4,不是 merge 后补)**:
1. #flywheel-alerts 建 Discord webhook(需 Manage Webhooks 权限 —— founder 或有权限的 bot)。
2. `gh secret set DISCORD_MAIN_CI_ALERT_WEBHOOK`。
3. 用 secret 值手工投一条测试消息(**带 `wait=true`,核验返回 message id**),随手删消息。
4. **顺序理由**:合入本 PR 的那次 main push 正是要保护的第一条 run;secret 必须在它之前就位。PR 不使用该 secret,预配对 PR 行为零影响。
5. 若权限暂时办不下来:指定首个 main run 的具名人工 observer(Tadashi),观察到绿/红并回报后才解除;不许把"alert job 因空 secret 在 GitHub 页面二次失败"当通知闭环。

## Step 4 — 同形状引信排查(bounded,只报不修;输入集按 R1 #6 收全)

输入定义:全仓 `*.test.ts` 中字段名匹配 `expiresAt|ExpiresAt|claimExpiresAt|leaseExpiresAt|expires_at|lease_expires_at` × **任意未来年份**(不限 2026–2029;含已知 `workflow-source-projector.test.ts:526,601,618`、`workflow-engine-dispatcher.test.ts:3940`、`external-merge-reconcile.test.ts:136` 的 2027 与 `ship-eligibility.test.ts:176` 的 2999)。逐项产出表:seed 字段 → 消费调用链 → 比较时钟(注入/真实)→ 结论(实弹/冻结注入/过期即预期)→ follow-up。表写进 PR 描述;实弹 ⇒ 报 Tadashi 立新单,不在本 PR 扩修。

## 与 #875(FLY-1833)的协调

#875 分支同函数带 `leaseExpiresAt: "2099-..."`(它的意外解药)。两个合入顺序都会在该函数撞 trivial conflict,**解法固定:取本单相对时钟版**(2099 仍是绝对字面量,同病长引信 —— 且会被 Step 2 的 offset 断言当场抓红)。若 #875 先合入:main 上两条测试已转绿,Step 1 动机从"解堵"变为"结构加固",RED 复现改用 Step 2 的 2099 突变验证,其余不变。合入前按 research 保质期表重核 `gh pr view 875 --json state`。

## 验收(三环境 + 两守卫)

1. 修复分支单跑 `post-ship-finalization.test.ts` ×10 全绿(当前已在引信后,天然是"炸后时段"实测)。
2. Step 2 回归用例绿;**且临时 2099 突变下该用例红**(RED 实证,随即还原)。
3. 本修复 PR 自己的 CI = **PR merge 态分片**实测绿(teamlead 全分片 + script-tests 含新 suite + ci-structure 守卫)。
4. 合入后首个 main push run = **main push 分片**绿(ship 后观察项,implement 节点在 PR 里声明;3e 若走 observer 兜底,由 observer 回报)。
5. **已裁出:**告警脚本、shell 枚举和 ci-structure 验收移交独立问题。
6. 禁则自证:**实现侧** diff 恰 1 文件(`post-ship-finalization.test.ts`);PR 总 diff 另含且仅含 `engineering/doc/FLY-1863-*` 文档(progress.md 在内)与 CLAUDE.md 里程碑行(最后一 commit);无 workflow/分片矩阵改动、无 `.skip`、无生产 TS 改动。

**验收取样原则(Cass 通则,Lead 要求进设计)**:「当故障的诊断需要它自己阻塞的那条路时,出路是绕到闭环外取样」。本单两处应用:根因定位靠的是闭环外动作(本地单跑 ×10 + 单变量突变,不依赖被堵死的 CI/merge 路);**告警机制的验收同样不许依赖它所守护的那条路自己** —— pre-merge 证据全部来自闭环外取样(hermetic curl shim + 手工 webhook 真投递),不以"制造一次真 main 红"作为验收前提。

**诚实边界**:alert 全链真投递(真 main 红 → Discord 消息落频道)无法在合入前不伪造 main 红地验证;pre-merge 证据到 hermetic + 3e(3) 带 `wait=true` 的手工投递为止,首次真实触发是 ship 后观察项。cancel-in-progress、needs 粒度、rerun 重复是上文三条已声明的接受边界。

## 测试与运行纪律

- 本机只跑定向测试文件;全量交给 PR CI(host 全量会压死生产 Bridge)。
- lint:`pnpm lint` 全仓;build 照旧跑 `pnpm -r build` 满足 role 自检门(无 src 改动,预期零增量)。

## 里程碑 / 版本

CLAUDE.md 里程碑行随 PR 最后一 commit;版本号 ship 时取空号(纯 test+CI 改动,VERSION 是否 bump 由 ship 节点按惯例定)。

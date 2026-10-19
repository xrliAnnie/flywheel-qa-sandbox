# FLY-147 聊天驱动 Issue Thread — 实施计划
Issue: FLY-147 (https://linear.app/geoforge3d/issue/FLY-147/chat-driven-issue-creation-auto-discord-thread-when-lead-spawns-new)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: follow strict red-green-refactor task by task; do not change this plan after design approval.

**Goal:** 解耦 Bridge 的手动 chat-thread capability 与 Runner spawn 自动创建策略，使任意 sessionRole 可共享现有自动路径，同时 Lead 能为尚未 spawn 的 ad-hoc Linear issue 安全创建/复用 Discord thread。

**Architecture:** `TEAMLEAD_CHAT_THREADS_ENABLED` 继续只控制自动/background 路径。`createQueryRouter()` 自己持有一个可注入、缺省时基于同一 `StateStore` 构造的 manual `ChatThreadCreator`；HTTP manual routes 不再依赖 auto flag，并分别由 `TEAMLEAD_API_TOKEN` 或 `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` 保护。两条触发最终都调用现有 `ensureChatThread()`，不增加 role 分支或新持久化结构。

**Tech Stack:** TypeScript、Express、Vitest、StateStore/SQLite、Discord REST、Linear SDK、pnpm monorepo。

---

## Assumptions locked for implementation

1. `TEAMLEAD_CHAT_THREADS_ENABLED=true` 的兼容语义是“Runner/session 事件自动创建与 enrichment 开启”，不是“Bridge 是否具备任何 thread 能力”。
2. `POST /api/chat-threads/create` 与 `register` 是 privileged manual writes；production 必须配置 `TEAMLEAD_API_TOKEN`，否则 route 503 fail-closed。
3. `POST /api/chat-threads/send` 只由现有 `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` 控制；`loadConfig()` 已保证该 flag 开启时 API token 必须存在。
4. `GET` mapping/reverse-lookup 可解析由 manual route 创建的 row，不依赖 auto flag。
5. `archive` 已有 API-token fail-closed guard，因此只移除 auto flag guard；归档业务逻辑不改。
6. 自动创建失败仍不阻止 Runner spawn；本期不把 Discord 成功变成 `/api/runs/start` 的事务前置条件。

## File map

| File | Responsibility in this change |
|---|---|
| `packages/teamlead/src/bridge/__tests__/chat-thread-routes.test.ts` | manual routes 与 auto policy 解耦的 RED/GREEN 集成证据 |
| `packages/teamlead/src/bridge/tools.ts` | query-router manual creator、route-specific gates |
| `packages/teamlead/src/__tests__/DirectEventSink.test.ts` | main/qa/designer/custom role 共用自动路径的参数化证据 |
| `doc/reference/product-lead-TOOLS.md` | API、env 与触发条件合同 |
| `doc/reference/product-lead-SOUL.md` | Lead 在 ad-hoc chat 与 Runner spawn 两场景的行为协议 |
| `packages/teamlead/lead-rules-base/department-lead-rules.md` | department Lead `/send` gate/fallback 文案 |
| `packages/teamlead/lead-rules-base/cos-lead-rules.md` | cos Lead 对称文案 |
| `docs/operations/bridge-daemon-management.md` | 运维配置、restart 与 smoke test |
| `engineering/doc/milestones/FLY-147.md` | 最终交付、验证与 review/PR evidence；必须是 literal last commit |

### Task 1: Manual route contracts — RED

**Files:**
- Modify: `packages/teamlead/src/bridge/__tests__/chat-thread-routes.test.ts`

- [ ] **Step 1: Make test-server auth posture explicit**

让大多数 route integration tests 表达“production 已配置 API token”，只在安全负例中显式传 false：

```ts
function createTestServer(opts: QueryRouterOptions) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createQueryRouter(store, [TEST_PROJECT], {
      apiTokenConfigured: true,
      ...opts,
    }),
  );
  server = createServer(app);
  server.listen(0);
  return server;
}
```

把 archive 的无-token case 改成 `apiTokenConfigured:false`，保持其 fail-closed intent。

- [ ] **Step 2: Replace the old auto-off blanket 404 cases with manual capability cases**

新增/改写以下断言：

```ts
it("POST /api/chat-threads/create works when automatic creation is disabled", async () => {
  const ensure = vi.fn(async () => ({ created: true, threadId: "t-manual" }));
  createTestServer({
    chatThreadsEnabled: false,
    chatThreadCreator: createFakeCreator(ensure),
    globalBotToken: "global-token",
  });
  process.env.LINEAR_API_KEY = "test-key";

  const res = await request(server, "POST", "/api/chat-threads/create", {
    issueIdentifier: "FLY-91",
    channelId: "ch-100",
    leadId: "lead-alpha",
    projectName: "TestProject",
  });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ threadId: "t-manual", created: true });
  expect(ensure).toHaveBeenCalledOnce();
});

it("GET /api/chat-threads resolves a manually-created row when automatic creation is disabled", async () => {
  store.upsertChatThread("t-manual", "ch-100", "FLY-91", "lead-alpha");
  createTestServer({ chatThreadsEnabled: false });
  const res = await request(
    server,
    "GET",
    "/api/chat-threads?issueId=FLY-91&channelId=ch-100",
  );
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ threadId: "t-manual" });
});

it("manual create fails closed when TEAMLEAD_API_TOKEN is not configured", async () => {
  const ensure = vi.fn(async () => ({ created: true, threadId: "never" }));
  createTestServer({
    chatThreadsEnabled: false,
    apiTokenConfigured: false,
    chatThreadCreator: createFakeCreator(ensure),
  });
  const res = await request(server, "POST", "/api/chat-threads/create", {
    issueIdentifier: "FLY-91",
    channelId: "ch-100",
    leadId: "lead-alpha",
    projectName: "TestProject",
  });
  expect(res.status).toBe(503);
  expect(ensure).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Rewrite the `/send` combined-gate test**

预置 row + Discord mock，并证明 `replyByIssueEnabled:true` 足以让手动 send 工作，即使 auto flag false：

```ts
store.upsertChatThread("t-manual", "ch-100", "FLY-147", "lead-alpha");
mockFetch.mockResolvedValueOnce({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ id: "msg-manual" }),
});
createTestServer({
  chatThreadsEnabled: false,
  replyByIssueEnabled: true,
  discordFetch: mockFetch,
});

const res = await request(server, "POST", "/api/chat-threads/send", {
  issueId: "FLY-147",
  channelId: "ch-100",
  leadId: "lead-alpha",
  projectName: "TestProject",
  text: "manual path",
});
expect(res.status).toBe(200);
expect(res.body).toEqual({
  threadId: "t-manual",
  messageIds: ["msg-manual"],
  created: false,
});
```

- [ ] **Step 4: Cover reverse lookup, register auth, and archive with auto off**

- `GET /chat-threads/by-thread/:id`: pre-seed row, auto false → 200.
- `POST /chat-threads/register`: `apiTokenConfigured:false` → 503 before Linear/Discord calls.
- `POST /chat-threads/archive`: pre-seed row/session, `apiTokenConfigured:true`, auto false → existing archive happy response 200.

- [ ] **Step 5: Run the focused test and verify RED**

Run:

```bash
pnpm --filter flywheel-teamlead test:run -- src/bridge/__tests__/chat-thread-routes.test.ts
```

Expected: FAIL only on the new FLY-147 expectations, with current 404 responses where 200/503 is expected. Syntax/setup errors do not count as RED; fix test setup until failures demonstrate the old coupled gate.

### Task 2: Manual creator and route-specific gates — GREEN

**Files:**
- Modify: `packages/teamlead/src/bridge/tools.ts`

- [ ] **Step 1: Make `ChatThreadCreator` a runtime import and build the manual fallback**

```ts
import {
  ChatThreadCreator,
  type ChatThreadResult,
} from "./ChatThreadCreator.js";

// inside createQueryRouter()
const chatThreadCreator =
  opts?.chatThreadCreator ?? new ChatThreadCreator(store);
```

Keep `QueryRouterOptions.chatThreadCreator` as the injection/reuse seam. Keep `chatThreadsEnabled` temporarily as a deprecated compatibility field but do not read it inside the router:

```ts
/** @deprecated Automatic creation is enforced by DirectEventSink, not HTTP routes. */
chatThreadsEnabled?: boolean;
```

- [ ] **Step 2: Gate privileged manual writes on API-token configuration**

At the start of `/chat-threads/register` and `/chat-threads/create`:

```ts
if (!apiTokenConfigured) {
  res.status(503).json({
    error:
      "chat thread write endpoint requires TEAMLEAD_API_TOKEN (refusing unauthenticated Discord/state mutation)",
  });
  return;
}
```

Remove their `if (!chatThreadsEnabled) ... 404` blocks. Keep all project/Lead/channel, Linear, alert-channel and bot-token guards unchanged.

- [ ] **Step 3: Remove only the obsolete auto-policy gates**

- `/send`: delete `!chatThreadsEnabled`; retain `!replyByIssueEnabled` 404.
- `/by-thread/:threadId` and `/chat-threads`: delete `!chatThreadsEnabled`.
- `/archive`: delete `!chatThreadsEnabled`; retain its existing `!apiTokenConfigured` 503 first-class guard.
- Replace all `opts?.chatThreadCreator` uses inside manual create/send with the local non-optional `chatThreadCreator`; remove the impossible “not initialized” branches/tests.

- [ ] **Step 4: Update inline contracts**

Comments must call `TEAMLEAD_CHAT_THREADS_ENABLED` the automatic/background policy and name `TEAMLEAD_API_TOKEN` / `TEAMLEAD_REPLY_BY_ISSUE_ENABLED` as manual route gates. Do not claim that auto false disables the HTTP capability.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
pnpm --filter flywheel-teamlead test:run -- src/bridge/__tests__/chat-thread-routes.test.ts
```

Expected: all tests in the file pass with no unhandled request/warning output.

- [ ] **Step 6: Commit the route batch**

```bash
git add packages/teamlead/src/bridge/tools.ts packages/teamlead/src/bridge/__tests__/chat-thread-routes.test.ts
git commit -m "fix(FLY-147): decouple manual thread creation from auto spawn"
```

### Task 3: Prove every sessionRole shares automatic creation

**Files:**
- Modify: `packages/teamlead/src/__tests__/DirectEventSink.test.ts`

- [ ] **Step 1: Add the parameterized characterization test**

```ts
describe("DirectEventSink — FLY-147 role-agnostic chat thread creation", () => {
  let store: StateStore;

  beforeEach(async () => {
    store = await StateStore.create(":memory:");
  });

  afterEach(() => store.close());

  it.each(["main", "qa", "designer", "custom-role"])(
    "auto-creates the issue thread for sessionRole=%s",
    async (sessionRole) => {
      const ensureChatThread = vi.fn(async () => ({
        created: true,
        threadId: `thread-${sessionRole}`,
      }));
      const creator = {
        ensureChatThread,
      } as unknown as import("../bridge/ChatThreadCreator.js").ChatThreadCreator;
      const sink = new DirectEventSink(
        store,
        makeConfig({ chatThreadsEnabled: true }),
        testProjects,
        undefined,
        undefined,
        creator,
      );

      await sink.emitStarted(
        makeEnvelope({
          executionId: `exec-${sessionRole}`,
          sessionRole,
          labels: ["Product"],
        }),
      );

      expect(ensureChatThread).toHaveBeenCalledOnce();
      expect(ensureChatThread).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: "issue-1",
          issueIdentifier: "GEO-100",
          chatChannelId: "chat-ch-1",
          leadId: "product-lead",
        }),
      );
      expect(store.getSession(`exec-${sessionRole}`)?.session_role).toBe(
        sessionRole,
      );
    },
  );
});
```

If this test is initially green, record it as characterization evidence; do not invent a production role branch to force a red cycle.

- [ ] **Step 2: Run both focused suites**

```bash
pnpm --filter flywheel-teamlead test:run -- \
  src/__tests__/DirectEventSink.test.ts \
  src/bridge/__tests__/chat-thread-routes.test.ts
```

Expected: both files pass.

- [ ] **Step 3: Commit role evidence**

```bash
git add packages/teamlead/src/__tests__/DirectEventSink.test.ts
git commit -m "test(FLY-147): cover chat threads for every runner role"
```

### Task 4: Document both trigger paths and configuration

**Files:**
- Modify: `doc/reference/product-lead-TOOLS.md`
- Modify: `doc/reference/product-lead-SOUL.md`
- Modify: `packages/teamlead/lead-rules-base/department-lead-rules.md`
- Modify: `packages/teamlead/lead-rules-base/cos-lead-rules.md`
- Modify: `docs/operations/bridge-daemon-management.md`

- [ ] **Step 1: Update the API reference**

Add a compact trigger/config matrix:

| Path | Trigger | Required config | Auto flag off |
|---|---|---|---|
| Runner auto | `session_started`, any role | `TEAMLEAD_CHAT_THREADS_ENABLED=true`, Lead `chatChannel`, Lead/global bot token | skipped; Runner continues |
| Lead manual create | `POST /api/chat-threads/create` with UUID or identifier | `TEAMLEAD_API_TOKEN`, `LINEAR_API_KEY`, Lead `chatChannel`, bot token | still available |
| Lead issue reply | `POST /api/chat-threads/send` | `TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true` + API token | still available |

State clearly that env/config changes require Bridge restart and that create is idempotent (`created:false` on reuse).

- [ ] **Step 2: Update Lead behavior**

In SOUL/rules:

- Ad-hoc chat-created issue: call `/create` immediately when issue-bound discussion should move to a thread; Runner does not need to exist.
- Spawn path: when auto is enabled, any role is handled by Bridge; use returned/payload `chat_thread_id`.
- `/send` fallback 404 now means `replyByIssueEnabled` off, not `chatThreadsEnabled` false.
- Preserve the existing graceful top-level fallback on 4xx/5xx.

- [ ] **Step 3: Update operations runbook**

Document all three env variables, their independent scope, API-token security requirement, and curl smoke tests for:

1. manual `/create` while auto flag is off;
2. Runner auto creation while auto flag is on;
3. `/send` when reply-by-issue is enabled.

Do not include real tokens/channel IDs.

- [ ] **Step 4: Verify documentation consistency**

```bash
rg -n "Chat threads not enabled|chatThreadsEnabled false|chatThreadsEnabled=false|TEAMLEAD_CHAT_THREADS_ENABLED" \
  doc/reference/product-lead-TOOLS.md \
  doc/reference/product-lead-SOUL.md \
  packages/teamlead/lead-rules-base/department-lead-rules.md \
  packages/teamlead/lead-rules-base/cos-lead-rules.md \
  docs/operations/bridge-daemon-management.md
```

Expected: no statement says auto flag off disables manual create/send/query; every remaining occurrence describes automatic/background behavior.

- [ ] **Step 5: Commit documentation**

```bash
git add doc/reference/product-lead-TOOLS.md doc/reference/product-lead-SOUL.md \
  packages/teamlead/lead-rules-base/department-lead-rules.md \
  packages/teamlead/lead-rules-base/cos-lead-rules.md \
  docs/operations/bridge-daemon-management.md
git commit -m "docs(FLY-147): explain automatic and manual thread triggers"
```

### Task 5: Full verification, milestone, review, and PR

**Files:**
- Create: `engineering/doc/milestones/FLY-147.md`
- Update: `engineering/doc/FLY-147-chat-driven-thread/progress.md` (before milestone only)

- [ ] **Step 1: Run scoped package verification**

```bash
pnpm --filter flywheel-teamlead test:run
pnpm --filter flywheel-teamlead build
```

Expected: all teamlead tests and TypeScript build pass.

- [ ] **Step 2: Run exact full-repository gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Then enumerate and run every new/modified shell test under `scripts/__tests__`; expected set for this plan is empty:

```bash
git diff --name-only origin/main...HEAD -- 'scripts/__tests__/*.test.sh'
```

If non-empty, run every returned script with `bash <path>` and record results.

- [ ] **Step 3: Audit acceptance criteria against evidence**

1. Parameterized DirectEventSink tests prove `main/qa/designer/custom` automatic role parity.
2. Auto-off route tests prove ad-hoc manual create/query/send.
3. Existing + new main path tests prove no engineer regression.
4. Docs matrix proves trigger/config coverage.
5. `git diff --check` is clean; no secret-like values; no `CLAUDE.md` diff.

- [ ] **Step 4: Update progress one final time before the final commit**

Set implementation/verification chunks done and point to the plan. Do not run `flywheel-comm progress` after the milestone commit because its automatic ledger commit would violate the literal-last-commit contract.

- [ ] **Step 5: Create the milestone as the literal last commit**

`engineering/doc/milestones/FLY-147.md` must record delivered scope, RED/GREEN evidence, exact gate outputs, and the pre-review HEAD. The final review question/verdict and PR URL are external state created afterward, so they belong in the PR body and Lead report, not as fake placeholders in this pre-review commit. Commit only this file:

```bash
git add engineering/doc/milestones/FLY-147.md
git commit -m "docs(FLY-147): record implementation milestone"
```

- [ ] **Step 6: Register code review through the injected review lane**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
FLY_147_REVIEW_GATE_JSON="$(node "$FLYWHEEL_COMM_CLI" gate review_code \
  --lead flywheel-test-2 \
  --exec-id 09af45d5-e2d0-4807-bcf7-e15a63f3882e \
  --no-block \
  "Code review requested for FLY-147 at $(git rev-parse HEAD)")"
FLY_147_REVIEW_QID="$(printf '%s' "$FLY_147_REVIEW_GATE_JSON" | jq -er '.questionId')"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$FLY_147_REVIEW_QID"
node "$FLYWHEEL_COMM_CLI" check "$FLY_147_REVIEW_QID"
```

The Bridge runs the cross-family reviewer (`codex:rescue` path); do not invoke raw `codex exec`. On `CHANGES_REQUESTED`, fix only named blocking findings, run focused + full verification, refresh the milestone in a new literal-last milestone commit, and open a new review gate/request. On APPROVED with advisories, report advisories to Lead without treating them as blockers.

- [ ] **Step 7: Push and open PR**

After APPROVED, confirm clean status and that `git log -1 --name-only` contains only `engineering/doc/milestones/FLY-147.md`, then:

```bash
git push -u origin project-slot-2-FLY-147
FLY_147_PR_URL="$(gh pr create --base main --head project-slot-2-FLY-147 \
  --title "fix(FLY-147): enable chat-driven issue threads" \
  --body $'## Summary\n- decouple manual issue-thread creation from automatic Runner spawn policy\n- preserve role-agnostic auto creation for main, QA, designer, and custom roles\n- document independent create, auto-spawn, and reply triggers\n\n## Test plan\n- pnpm lint\n- pnpm -r build\n- pnpm test:packages:run\n\nSee engineering/doc/FLY-147-chat-driven-thread/plan.md and engineering/doc/milestones/FLY-147.md for acceptance evidence.')"
FLY_147_PR_NUMBER="$(gh pr view "$FLY_147_PR_URL" --json number --jq '.number')"
```

PR body: summary, acceptance mapping, RED/GREEN tests, exact full gates, config/rollback, code-review verdict. Do not merge or request ship approval.

- [ ] **Step 8: Report and complete the implement node**

```bash
node "$FLYWHEEL_COMM_CLI" stage set pr_created
node "$FLYWHEEL_COMM_CLI" ask \
  --lead flywheel-test-2 \
  --exec-id 09af45d5-e2d0-4807-bcf7-e15a63f3882e \
  --report "DONE: FLY-147 implementation complete; manual + automatic thread paths verified; review APPROVED ($FLY_147_REVIEW_QID); PR: $FLY_147_PR_URL"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$FLY_147_PR_NUMBER"
```

Do not dispatch QA; the DAG orchestrator owns the successor phase.

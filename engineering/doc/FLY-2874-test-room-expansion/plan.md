# FLY-2874 测试房扩容到六间 — 实施计划
Issue: FLY-2874 (https://linear.app/geoforge3d/issue/FLY-2874/529-房扩容-测试房-4-6-间加-slot-56bot文字频道bridge-端口-每间一个语音频道补-voice-test-456)
日期: 2026-09-24
基于: research.md

> **For agentic workers:** 在当前 implement 节点内逐项执行；每个行为改动必须使用 `superpowers:test-driven-development` 的 RED → GREEN → REFACTOR。不要派发子代理，不要运行本地全量 suite。

**Goal:** 把 529 测试房安全扩到 6 个配置驱动 slot，并建立 slot 1–6 的唯一文字/语音映射及可执行的部署、健康、拆房、N-to-N 验收证据。

**Architecture:** 继续以 `~/.flywheel/test-slots.json` / `scripts/test-slots.example.json` 的 `slots[]` 为唯一真源。一个小型 shell helper 统一校验连续 slot id、唯一身份/文字/端口坐标和请求范围；若 pool 声明语音映射，则要求全池语音坐标完整、唯一。部署把可用语音映射投影到 generalized room receipt，语音 runtime 再校验 fixture 与该映射一致。

**Tech Stack:** Bash 3.2 兼容 shell、jq、Node.js `node:test`、Discord REST v10、现有 529 launchd/tmux harness。

---

## 文件职责

- 新建 `scripts/lib/qa-slot-pool.sh`：只提供无副作用的 pool 结构/范围校验。
- 新建 `scripts/__tests__/fly2874-slot-pool.test.sh`：行为测试 pool 1–6、拒绝 7、拒绝重复坐标/非连续 id/半配置语音 map。
- 新建 `scripts/__tests__/fly2874-test-slot-capacity.test.mjs`：验证仓库模板的六房坐标与载体形状。
- 修改 `scripts/test-slots.example.json`：slot 1–6 完整模板与语音字段。
- 修改 `scripts/test-deploy.sh`：统一 pool 校验、读取语音字段、fixture 绑定、room/stdout 投影。
- 修改 `scripts/test-teardown.sh`：`all` 使用统一 pool 校验并在配置不可读时 fail closed。
- 修改 `scripts/qa-fly-60-driver.sh`：按配置容量接受 1–6。
- 修改 `scripts/qa/fly2655-voice-room.mjs`：room receipt 与 fixture 的语音映射一致性。
- 修改 `scripts/__tests__/fly2655-voice-room.test.mjs`：语音错配负例。
- 修改 `scripts/__tests__/test-deploy-multilead.test.sh`：六房 fixture 与 slot 5+6 campaign 覆盖。
- 修改 `scripts/__tests__/test-deploy-preflight-github.test.sh`：把 slot 99 合成池改为合法连续池，保留 GitHub preflight 断言。
- 修改 `scripts/__tests__/test-deploy-fly1389.test.sh`：把真实 fixture 端口移到与 dummy 段不重叠的固定范围。
- 修改 `.github/workflows/ci.yml`：字面枚举两个新测试，满足 Quick Gate suite enumeration。
- 修改 QA framework 的当前说明文件：六房、19871–19876、role/voice map。
- 修改本机 `~/.flywheel/test-slots.json`：只在 Founder 回传非敏感 ID 后补 slot/频道坐标；不碰 `.env` token 值。
- 新建 `engineering/doc/milestones/FLY-2874.md`：PR 的 literal last commit。

## Task 1: Pool 合同 TDD

**Files:**
- Create: `scripts/__tests__/fly2874-slot-pool.test.sh`
- Create: `scripts/lib/qa-slot-pool.sh`

- [ ] **Step 1: 写失败测试**

测试创建临时 6-slot JSON，并覆盖以下断言；除连续 id/范围/端口外，
`channelId`、`botAppId`、`tokenEnvVar` 必须唯一。语音字段可以整池缺席以兼容
纯文字合成夹具；一旦任一 slot 声明语音字段，全池都必须声明唯一、合法 snowflake
`voiceChannelId` 与对应 `voice-test-N` 名称：

```bash
size="$(qa_slot_pool_size "$slots")"
[[ "$size" == 6 ]]
qa_slot_pool_require_member "$slots" 6
! qa_slot_pool_require_member "$slots" 7
! qa_slot_pool_size "$duplicate_port_slots"
! qa_slot_pool_size "$non_contiguous_slots"
! qa_slot_pool_size "$duplicate_voice_slots"
! qa_slot_pool_size "$partial_voice_slots"
```

- [ ] **Step 2: 跑 RED**

Run: `bash scripts/__tests__/fly2874-slot-pool.test.sh`

Expected: FAIL，因为 `scripts/lib/qa-slot-pool.sh` 尚不存在。

- [ ] **Step 3: 写最小 helper**

```bash
qa_slot_pool_size() {
  local slots_file="${1:?slots file required}"
  jq -er '
    .slots as $slots
    | (($slots | type) == "array" and ($slots | length) > 0)
      and ([range(0; ($slots | length)) as $i
            | ($slots[$i].id == ($i + 1))] | all)
      and ([ $slots[].bridgePort ] | length == (unique | length))
      and ([ $slots[].channelId ] | length == (unique | length))
      and ([ $slots[].botAppId ] | length == (unique | length))
      and ([ $slots[].tokenEnvVar ] | length == (unique | length))
      # 若任一 voice 字段出现，则全池 voice id/name 必须完整且唯一；
      # voiceChannelId 另校验 17–20 位 snowflake。
    | if . then ($slots | length) else error("invalid slot pool") end
  ' "$slots_file"
}

qa_slot_pool_require_member() {
  local slots_file="${1:?slots file required}" slot="${2:?slot required}" total
  [[ "$slot" =~ ^[1-9][0-9]*$ ]] || return 1
  total="$(qa_slot_pool_size "$slots_file")" || return 1
  (( 10#$slot <= total ))
}
```

- [ ] **Step 4: 跑 GREEN**

Run: `bash scripts/__tests__/fly2874-slot-pool.test.sh`

Expected: PASS，且临时文件自动清理。

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/qa-slot-pool.sh scripts/__tests__/fly2874-slot-pool.test.sh
git commit -m "test(qa): define six-slot pool contract"
```

## Task 2: 六房模板与语音映射 TDD

**Files:**
- Create: `scripts/__tests__/fly2874-test-slot-capacity.test.mjs`
- Modify: `scripts/test-slots.example.json`

- [ ] **Step 1: 写失败测试**

```js
assert.deepEqual(slots.map((slot) => slot.id), [1, 2, 3, 4, 5, 6]);
assert.deepEqual(slots.map((slot) => slot.bridgePort), [19871, 19872, 19873, 19874, 19875, 19876]);
for (const slot of slots) {
  assert.equal(slot.botName, `flywheel-test-${slot.id}`);
  assert.equal(slot.tokenEnvVar, `TEST_BOT_TOKEN_${slot.id}`);
  assert.equal(slot.voiceChannelName, `voice-test-${slot.id}`);
  assert.ok(slot.voiceChannelId);
}
assert.equal(slots[4].backend, "codex-app-server");
assert.equal(slots[4].codexProfile, "full-access");
assert.equal(slots[5].backend, undefined);
```

- [ ] **Step 2: 跑 RED**

Run: `node --test scripts/__tests__/fly2874-test-slot-capacity.test.mjs`

Expected: FAIL，当前模板只有 4 个 slot 且无 voice fields。

- [ ] **Step 3: 补最小配置**

给 slot 1–4 仅追加：

```json
"voiceChannelId": "<voice-channel-id-N>",
"voiceChannelName": "voice-test-N"
```

slot 5 复用 slot 2 形状并设置：

```json
{
  "id": 5,
  "role": "lead",
  "identitySource": "product-lead",
  "department": "product-test-2",
  "deptLabel": "Product-Test-2",
  "botName": "flywheel-test-5",
  "botAppId": "<bot-application-id-5>",
  "tokenEnvVar": "TEST_BOT_TOKEN_5",
  "channelId": "<channel-id-5>",
  "channelName": "product-lead-test-2",
  "bridgePort": 19875,
  "voiceChannelId": "<voice-channel-id-5>",
  "voiceChannelName": "voice-test-5",
  "backend": "codex-app-server",
  "codexProfile": "full-access"
}
```

slot 6 复用 slot 3 的 ops identity，端口 19876，语音频道名明确为
`voice-test-6`，保持默认 Claude backend。slot 1–5 的对应名称分别为
`voice-test-1` 到 `voice-test-5`，其中本次 Discord 侧必须补建
`voice-test-4`、`voice-test-5`、`voice-test-6`。

- [ ] **Step 4: 跑 GREEN**

Run: `node --test scripts/__tests__/fly2874-test-slot-capacity.test.mjs`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/test-slots.example.json scripts/__tests__/fly2874-test-slot-capacity.test.mjs
git commit -m "feat(qa): describe six isolated test slots"
```

## Task 3: 部署、拆房与 driver 范围 TDD

**Files:**
- Modify: `scripts/test-deploy.sh`
- Modify: `scripts/test-teardown.sh`
- Modify: `scripts/qa-fly-60-driver.sh`
- Modify: `scripts/__tests__/fly2874-slot-pool.test.sh`
- Modify: `scripts/__tests__/test-deploy-multilead.test.sh`
- Modify: `scripts/__tests__/test-deploy-preflight-github.test.sh`
- Modify: `scripts/__tests__/test-deploy-fly1389.test.sh`

- [ ] **Step 1: 扩失败测试**

新增行为格：配置容量 6 时 driver 接受 slot 6 并继续到下一个参数错误；slot 7 在任何 preflight/写锁前被拒；teardown `all` 在配置不可读时 fail closed；multi-lead 能解析 main slot 5 + extra slot 6 且锁集合为 `[5,6]`。GitHub preflight 合成夹具改为单个合法 `id=1` pool；FLY-1389 的真实 fixture 端口使用与 dummy `20001–20029` 永不重叠的固定段。

```bash
HOME="$fake_home" bash scripts/qa-fly-60-driver.sh --slot 6 --g3-trials 0
grep -q -- '--g3-trials must be positive' "$stderr"

! HOME="$fake_home" bash scripts/qa-fly-60-driver.sh --slot 7
grep -q 'configured range 1-6' "$stderr"
```

- [ ] **Step 2: 跑 RED**

Run:

```bash
bash scripts/__tests__/fly2874-slot-pool.test.sh
bash scripts/__tests__/test-deploy-multilead.test.sh
```

Expected: slot 6/range/campaign 新断言失败。

- [ ] **Step 3: 最小接线**

三个入口 source `scripts/lib/qa-slot-pool.sh`。`test-deploy.sh` 先完成参数解析和参数间的快速 fail（例如 `--codex-home-reconcile requires --alerts`），随后在任何昂贵 GitHub preflight 和锁写入前执行 pool 校验：

```bash
TOTAL_SLOTS="$(qa_slot_pool_size "$SLOTS_FILE")" || {
  echo "ERROR: invalid slot pool in ${SLOTS_FILE}" >&2
  exit 1
}
if [[ -n "$REQUESTED_SLOT" ]] && ! qa_slot_pool_require_member "$SLOTS_FILE" "$REQUESTED_SLOT"; then
  echo "ERROR: slot must be in configured range 1-${TOTAL_SLOTS}" >&2
  exit 1
fi
```

`qa-fly-60-driver.sh` 使用同一范围检查。`test-teardown.sh all` 必须先成功解析容量；删除 `|| echo 4` fallback。mirror 仍只允许 1–3，但错误文案改为“designated mirror topology”，不再声称 slot 5/6 没有生产角色对应。

- [ ] **Step 4: 跑 GREEN**

Run:

```bash
bash scripts/__tests__/fly2874-slot-pool.test.sh
bash scripts/__tests__/test-deploy-multilead.test.sh
bash scripts/__tests__/test-deploy-preflight-github.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/test-deploy.sh scripts/test-teardown.sh scripts/qa-fly-60-driver.sh scripts/__tests__/fly2874-slot-pool.test.sh scripts/__tests__/test-deploy-multilead.test.sh scripts/__tests__/test-deploy-preflight-github.test.sh scripts/__tests__/test-deploy-fly1389.test.sh
git commit -m "feat(qa): route deploy and teardown across six slots"
```

## Task 4: 语音 receipt 绑定 TDD

**Files:**
- Modify: `scripts/test-deploy.sh`
- Modify: `scripts/qa/fly2655-voice-room.mjs`
- Modify: `scripts/__tests__/fly2655-voice-room.test.mjs`

- [ ] **Step 1: 写失败测试**

在现有 `loadSlot` fixture 中把 `room-info.json.voiceChannelId` 改成另一个 snowflake，要求抛出：

```js
assert.throws(
  () => loadSlot(slotDir, head),
  /slot_voice_mapping_drift/,
);
```

并断言 deploy source 读取 `voiceChannelId` / `voiceChannelName`、把两者写入 room-info 和 stdout。

- [ ] **Step 2: 跑 RED**

Run: `node --test scripts/__tests__/fly2655-voice-room.test.mjs`

Expected: 新错配用例未失败或缺少 room 字段。

- [ ] **Step 3: 最小实现**

`test-deploy.sh` 从已认领 slot 用 `// empty` 读取两个 voice 字段：普通纯文字部署允许两者同时缺席；存在 `--voice-fixture` 时必须显式指定 slot，且在认领/昂贵 preflight 前要求两个字段均非空、`voiceChannelId` 为合法 snowflake，再读取 public fixture 的 `voiceChannelId` 并比较：

```bash
VOICE_CHANNEL_ID=$(jq -r ".slots[${SLOT_IDX}].voiceChannelId // empty" "$SLOTS_FILE")
VOICE_CHANNEL_NAME=$(jq -r ".slots[${SLOT_IDX}].voiceChannelName // empty" "$SLOTS_FILE")
FIXTURE_VOICE_CHANNEL_ID=$(jq -er '.voiceChannelId' "$VOICE_FIXTURE")
[[ "$FIXTURE_VOICE_CHANNEL_ID" == "$VOICE_CHANNEL_ID" ]] \
  || campaign_abort "voice fixture channel does not match slot ${SLOT} mapping"
```

有映射时 generalized room receipt 与 stdout 增加两字段；voice fixture 路径一定有映射。`loadSlot()` 增加：

```js
check(
  room.voiceChannelId === fixtureReceipt.fixture.voiceChannelId,
  "slot_voice_mapping_drift",
);
```

- [ ] **Step 4: 跑 GREEN 与回归**

Run:

```bash
node --test scripts/__tests__/fly2655-voice-room.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/test-deploy.sh scripts/qa/fly2655-voice-room.mjs scripts/__tests__/fly2655-voice-room.test.mjs
git commit -m "feat(voice): bind each QA slot to its room"
```

## Task 5: 当前操作文档收敛

**Files:**
- Modify: `packages/qa-framework/README.md`
- Modify: `packages/qa-framework/agents/qa-parallel-executor.md`
- Modify: `packages/qa-framework/suites/fly-60-hard-gate.md`
- Modify: `packages/qa-framework/suites/fly-161-runner-question.md`
- Modify: `doc/qa/framework/real-runner-e2e-guide.md`
- Modify: `scripts/setup-mirror-channel.sh`
- Modify: `scripts/__tests__/test-deploy-multilead.test.sh`

- [ ] **Step 1: 更新活动说明**

把默认 pool 改为 6、端口改为 19871–19876、可用范围改为 1–6；role map 增加 slot 5/6；明确每个 slot 有专属 text + voice channel，mirror 拓扑仍固定 1–3。slot 5/6 初始只保证 per-slot 与 N-to-N；未给新 bot 配置 alerts/roundtable/mirror 共享频道 overwrite，因此这些共享模式不得宣称可用。

- [ ] **Step 2: 跑固定四房审计**

Run:

```bash
git grep -nE '1-4|1–4|19871-19874|4-slot|four test|4 个.*slot|default 4-slot|legacy 4-slot|echo 4' -- scripts packages/qa-framework doc/qa .flywheel/agents
```

Expected: 只剩 plan/research 记录、历史报告、CI 4-shard、FLY-2456 固定场景、mirror 1–3 等已列明排除项；任何活动 pool 合同命中必须修掉。

- [ ] **Step 3: Commit**

```bash
git add packages/qa-framework/README.md packages/qa-framework/agents/qa-parallel-executor.md packages/qa-framework/suites/fly-60-hard-gate.md packages/qa-framework/suites/fly-161-runner-question.md doc/qa/framework/real-runner-e2e-guide.md scripts/setup-mirror-channel.sh scripts/__tests__/test-deploy-multilead.test.sh
git commit -m "docs(qa): publish the six-room operating map"
```

## Task 6: 本地定向验证

**Files:** all changed repository files

- [ ] **Step 1: 消费者 sweep**

对每个 changed file 用完整路径、文件名、父目录运行 `git grep -lF`，把保留测试与排除命中写入 progress；历史 docs、fixtures 和无行为依赖的字符串引用逐项说明。

- [ ] **Step 2: 跑所有直接相关与新增脚本测试**

至少运行：

```bash
bash scripts/__tests__/fly2874-slot-pool.test.sh
node --test scripts/__tests__/fly2874-test-slot-capacity.test.mjs
node --test scripts/__tests__/fly2655-voice-room.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/test-deploy-multilead.test.sh
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-deploy-preflight-github.test.sh
bash scripts/__tests__/codex-home-reconcile-cadence.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/test-teardown-cmux-ownership.test.sh
bash scripts/__tests__/test-teardown-live-watcher-e2e.test.sh
bash scripts/__tests__/test-teardown-lease-contract.test.sh
```

禁止本地全 package suite。

- [ ] **Step 3: lint / shell 语法**

```bash
bash -n scripts/lib/qa-slot-pool.sh scripts/test-deploy.sh scripts/test-teardown.sh scripts/qa-fly-60-driver.sh scripts/setup-mirror-channel.sh
pnpm lint
```

本次若没有 package TypeScript/API/export 改动，则 package build 与 dependent typecheck 记为 N/A，并写明理由；如果实际 diff 增加了 package 代码，则按 owning package 补 `pnpm --filter "<pkg>..." build` 与 `vitest related <changed-ts> --run`。

两个新增测试必须在 `.github/workflows/ci.yml` 中以字面命令枚举；随后定向运行
`ci-shell-suite-enumeration.test.sh` 证明 Quick Gate 分类守卫仍绿。

- [ ] **Step 4: Commit 验证修正**

仅当验证暴露本任务回归时按 RED → GREEN 修复并单独 commit，不做顺手清理。

## Task 7: Discord ID 落地与真实 529 验收

**Files:**
- Modify: `~/.flywheel/test-slots.json`（本机状态，不进 git）
- Never modify: `~/.flywheel/.env`（Founder only）

- [ ] **Step 1: 从 runner inbox 接收 Founder setup IDs**

原 setup question 已 terminal disposed；Lead 明确会通过 runner `send` 回传 ID。每个任务边界运行
`node "$FLYWHEEL_COMM_CLI" inbox --exec-id b6c738ca-d135-4cb7-9116-17267466406b`，若摘要列出 question id，再逐个 `check` 消费；不得继续轮询旧 setup question。

只接受 application IDs 与 text/voice channel IDs；若回复含 token，不回显，立即停止并报告 Lead 走 secret 处置。
Founder 清单还必须保持既定安全边界：现有 bot 无 Manage Channels，因此 Founder
本人创建 bot，Lead 以 Founder 的 Chrome 会话创建频道；新 bot 只启用 Server Members +
Message Content privileged intents，邀请权限严格与现有 bot 对齐为 `68608`
（View/Send/Read History），不得给 Administrator、Manage Channels 或 guild 级语音权限。
Connect/Speak/Use Voice Activity 只在各自 `voice-test-5/6` 频道 overwrite 授予。

- [ ] **Step 2: 用 `apply_patch` 更新本机 slot 配置**

先备份现有文件；用 `apply_patch` 一次性应用完整 JSON diff，随后立即用 `jq` 验证。保留 slot 1–4
所有既有字段和值，只追加它们的 voice map；增加 slot 5/6。为避免自动认领在 PR review
前抢用新房，写入只在准备开始显式 slot 5/6 验收并拿到 Lead 授权后进行；校验：

```bash
jq -e '.slots | length == 6
  and ([.[].id] == [1,2,3,4,5,6])
  and ([.[].bridgePort] == [19871,19872,19873,19874,19875,19876])
  and ([.[].channelId] | length == (unique | length))
  and ([.[].voiceChannelId] | length == (unique | length))
  and ([.[].botAppId] | length == (unique | length))
  and ([.[].tokenEnvVar] | length == (unique | length))
  and all(.[].voiceChannelId; test("^[0-9]{17,20}$"))' ~/.flywheel/test-slots.json
```

仅用变量名检查 `TEST_BOT_TOKEN_5/6` 是否存在，不输出值。读取 Discord member/role 与
channel overwrite：新 bot managed role 权限必须等于现有 bot 的 `68608`；新 bot 在非 QA
语音频道不得有 Connect；在其它 slot 的文字频道读取必须返回 403；各自专属文字/语音房
则必须具有所需权限。

- [ ] **Step 3: 请求真实开/拆房授权**

通过 question gate 说明只操作 slot 5/6，等待 Lead 明确同意；不得触碰 slot 1–4。

- [ ] **Step 4: slot 5 完整闭环**

```bash
HEAD=$(git rev-parse HEAD)
scripts/test-deploy.sh --generalized --expect-head "$HEAD" 5
curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:19875/health
scripts/test-teardown.sh 5
```

验后断言 lock/slot dir/launchd labels/19875 listener 全部缺席。

另以显式 slot 5 加本房 voice fixture 做一次 generalized deploy，运行
`node scripts/qa/fly2655-voice-room.mjs prepare --slot-dir /tmp/flywheel-test-slot-5 --expected-head "$HEAD"`，由 `prepare` 内部的 `loadSlot` 校验 room/fixture 映射后拆房；fixture 使用
`voice-test-5` 的公开坐标，不含 token。Claude carrier 的 slot 3/4/6 目前结构性不满足
该 Codex voice preflight，因此它们的 voice map 本单只做配置与 Discord 权限绑定，
不虚报 live voice runtime 通过。

- [ ] **Step 5: slot 6 完整闭环**

同上，端口 19876；拆后资源全释放。

- [ ] **Step 6: slot 5+6 N-to-N**

```bash
scripts/test-deploy.sh --generalized --expect-head "$HEAD" --extra-lead 6:Ops-Test-2 5
```

断言 health 200、projects registry 恰含 slot 5/6 两个 Lead、两个 launchd label 存活；只调用 owner teardown `scripts/test-teardown.sh 5`，随后确认 slot 5/6 两把锁与两个 Lead 资源都释放。

- [ ] **Step 7: 零影响对照**

配置激活完成后再取基线：slot 1–4 的既有字段（排除本单新增 voice keys）前后必须一致。
运行资源按本次 campaignId/owner pid/launchd label 归因，证明本次 slot 5/6 验收未创建、
删除或 teardown 任一 slot 1–4 资源；其它 QA runner 对 slot 1–4 的合法并发变化不作为
本单失败证据。

## Task 8: 完成前验证、review、PR 与 handoff

**Files:**
- Create last: `engineering/doc/milestones/FLY-2874.md`
- Update: `engineering/doc/FLY-2874-test-room-expansion/progress.md`

- [ ] **Step 1: 使用 `superpowers:verification-before-completion` 做逐项审计**

重新运行当前 HEAD 的所有定向验证，核对 git diff、无 token、无 slot 1–4 值漂移、真实验收 receipts 完整。

- [ ] **Step 2: milestone 作为 literal last commit**

```bash
git add engineering/doc/milestones/FLY-2874.md
git commit -m "docs(milestone): record FLY-2874 implementation"
```

此后不再移动 HEAD；如必须修代码，修后重新生成新的 milestone last commit，并使旧 review/CI 失效。

- [ ] **Step 3: push 与 effective code review**

```bash
git push -u origin flywheel-FLY-2874
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id b6c738ca-d135-4cb7-9116-17267466406b --no-block "Code review requested for FLY-2874"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <id>
node "$FLYWHEEL_COMM_CLI" check <id>
```

只以 `reviewVerdict` 为准。CHANGES_REQUESTED 时只修 blocking finding，新 HEAD 必须重新走定向验证、push 与新 review gate。

- [ ] **Step 4: 开 PR**

PR body 披露定向本地测试、真实 slot 5/6/N-to-N receipts、CI scope 边界、Discord/secret 边界。不得请求 full CI；QA 负责冻结头 full exact-head CI。

- [ ] **Step 5: 报告与 implement 完成路由**

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead --exec-id b6c738ca-d135-4cb7-9116-17267466406b --report "DONE: FLY-2874 implement ..."
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
node "$FLYWHEEL_COMM_CLI" park
```

不派发 QA，不 merge，不 deploy production。

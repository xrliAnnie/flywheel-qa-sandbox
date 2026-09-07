# FLY-2401 Raya 读侧激活 — 实施计划
Issue: FLY-2401 (https://linear.app/geoforge3d/issue/FLY-2401/raya读侧-按-fly-2131-激活清单把-raya-codex-leadagentidraya真正激活生产里-summary-6h)
日期: 2026-09-06
基于: research.md

> **执行要求：** 当前 DAG implement 节点内联执行；每个行为变化严格使用
> `superpowers:test-driven-development` 的 RED→GREEN→REFACTOR。不得 dispatch successor/review
> nodes，不得修改生产配置、重启服务、merge 或 deploy。

**Goal:** 交付一套可审、可重跑、默认只读的 Raya 激活差异与验收工具，使 Lead 能按
FLY-2131 B/C + FLY-2259 carrier 合同批准生产窗口，并在激活后机械证明 6h round 和至少一张
summary PR 的真实读收据。

**Architecture:** 保留 FLY-2259 row/registrar/plist/wrapper 为单一来源；FLY-2401 增加
三键 env target、三键原子 transition helper、纯只读 diff renderer、两态 file-state verifier、
first-round evidence verifier 和 operator checklist。registry 行变更与 Bridge + **全 Lead fleet**
重启是同一个安静窗口事务：registry 写入后任何旧 Lead identity env 都视为失效，窗口不得恢复
Lead 写流量，直到 deployed `restart-services.sh` 完成全 fleet restart 且新 digest 逐席验绿。
所有 production path 均由 CLI 参数注入，测试只使用 temp fixtures；除显式由 Lead/operator 在
获批窗口调用的 env transition helper 外，renderer/verifier 只读输入、只写 stdout/stderr。

**Tech Stack:** Python 3 stdlib（`argparse/json/pathlib/stat/hashlib/difflib/sqlite3`）、Bash
fixture tests、Git、SQLite、`jq`、现有 `flywheel-comm`/`gh` operator commands。

---

## 0. 文件职责

| 文件 | 职责 |
| --- | --- |
| `engineering/doc/FLY-2401-raya-read-activation/materials/raya-env-target.json` | FLY-2131 C.4/C.5 三个非秘密 target 的唯一新模板 |
| `engineering/doc/FLY-2401-raya-read-activation/materials/transition-raya-env.py` | 对三个目标键做原子 apply/verify/rollback；保留其它 env 字节、owner 与 0600 mode |
| `engineering/doc/FLY-2401-raya-read-activation/materials/render-production-diff.py` | 从显式输入只读生成 scoped production diff；不写目标 |
| `engineering/doc/FLY-2401-raya-read-activation/materials/verify-activation-state.py` | 校验 `pre` / `active` 两态文件与静态 identity 坐标；不探测/改变 runtime |
| `engineering/doc/FLY-2401-raya-read-activation/materials/verify-first-round.py` | 交叉验证 canonical DB、merge receipt、GitHub PR JSON、memory provenance，并直读 Discord API message |
| `engineering/doc/FLY-2401-raya-read-activation/activation-checklist.md` | 每步验证命令、期望输出、停止线、回滚和权限归属 |
| `engineering/doc/FLY-2401-raya-read-activation/production-change-proposal.md` | 当前 live snapshot 的逐处 diff 与逆序回滚，供 Lead 审批 |
| `scripts/__tests__/fly2401-raya-read-activation.test.sh` | 四个工具的 happy/negative/zero-write/atomic-write 合同 |
| `.github/workflows/ci.yml` | 把 hermetic shell suite 加进字面枚举，避免未分类 suite 令 quick-gate fail |

不修改：FLY-2131/2216/2259 已批准 plan/runbook、production rider、merge authority、Bridge
Discord route、product brain/voice 的 0444 identity projection、`CLAUDE.md`。0444 projection
只做 drift 审计；Raya Lead launcher 的 prompt authority 是 deployed code
`~/.flywheel/raya/code/IDENTITY.md`，投影差异不进入 Lead active-ready 判据。

## Task 1: env target、production diff renderer 与三键 transition

**Files:**

- Create: `engineering/doc/FLY-2401-raya-read-activation/materials/raya-env-target.json`
- Create: `engineering/doc/FLY-2401-raya-read-activation/materials/render-production-diff.py`
- Create: `engineering/doc/FLY-2401-raya-read-activation/materials/transition-raya-env.py`
- Create/Test: `scripts/__tests__/fly2401-raya-read-activation.test.sh`

- [ ] **Step 1.1 — RED：建立 renderer fixture**

shell test 建 temp tree，写入：

```text
projects.json = [{"projectName":"existing","projectRoot":"/tmp/existing","leads":[]}]
raya.env:
  KEEP_SECRET=must-never-appear
  RAYA_MEMORY_FILE=$T/home/.flywheel/raya/memory/MEMORY.md
  RAYA_WORKSPACE_ROOTS_JSON=["$T/home/.flywheel/raya/code","$T/home/.flywheel/raya/memory"]
identity source = current constitution
identity projection = old constitution
```

复制 FLY-2259 row/template 到 fixture 参数，记录所有 input sha256。调用：

```bash
python3 "$RENDER" \
  --home "$T/home" --projects "$T/projects.json" --raya-env "$T/raya.env" \
  --identity-source "$T/code/IDENTITY.md" \
  --identity-projection "$T/identity/IDENTITY.md" \
  --project-row "$ROW" --plist-template "$PLIST" --env-target "$TARGET"
```

改前期望：rc 非零，stderr 表明 renderer 不存在。不得先创建 production code。

- [ ] **Step 1.2 — RED：钉输出与安全合同**

renderer stdout 必须是单个 JSON object：

```json
{
  "schemaVersion": 1,
  "productionWritesPerformed": false,
  "projectsPatch": [{"op":"add","path":"/1","value":{"projectName":"raya"}}],
  "fleetIdentityImpact": {"currentLeadCount":0,"targetLeadCount":1,"allExistingLeadsRequireRestart":true},
  "envPatch": [
    {"key":"RAYA_MEMORY_FILE","before":"$T/home/.flywheel/raya/memory/MEMORY.md","after":"$T/home/Dev/raya-lead-workspace/memory/MEMORY.md"},
    {"key":"RAYA_WORKSPACE_ROOTS_JSON","before":["$T/home/.flywheel/raya/code","$T/home/.flywheel/raya/memory"],"after":["$T/home/.flywheel/raya/code","$T/home/Dev/raya-lead-workspace/memory"]},
    {"key":"RAYA_VOICE_OPTIONS_JSON","before":null,"after":{"startInstructionsFile":"$T/home/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"}}
  ],
  "identityProjection": {"operation":"audit_only","mutationPlanned":false,"authoritativeForLead":false},
  "launchdPlist": {"operation":"create"}
}
```

测试实际断言完整 Raya row（不是上面为可读性缩短的 value）、三个 after、identity
source/projection sha256 与 safe audit diff、plist target path/content sha256；stdout 不含
`must-never-appear`。`--home "$T/home"` 只展开 env target；FLY-2259 row 中已经审核的生产绝对
路径保持字面不变。调用后 input sha256 与 mode 全不变，且 target workspace/plist/manifest
都未被创建。identity projection drift 只报告，不生成 copy/chmod 操作。fixture 另含至少一个
Lead，实际断言 `currentLeadCount=N,targetLeadCount=N+1` 且
`allExistingLeadsRequireRestart=true`；上面 0/1 仅是缩短后的 shape 示例。

- [ ] **Step 1.3 — GREEN：写 target 模板**

模板用 `$HOME` 相对语义避免把测试 home 写死；renderer 解析后 canonicalize：

```json
{
  "RAYA_MEMORY_FILE": "$HOME/Dev/raya-lead-workspace/memory/MEMORY.md",
  "RAYA_WORKSPACE_ROOTS_JSON": [
    "$HOME/.flywheel/raya/code",
    "$HOME/Dev/raya-lead-workspace/memory"
  ],
  "RAYA_VOICE_OPTIONS_JSON": {
    "startInstructionsFile": "$HOME/.flywheel/raya/code/apps/voice/assets/start-instructions.zh.md"
  }
}
```

- [ ] **Step 1.4 — GREEN：实现 renderer 最小路径**

实现以下纯 helper；每个输入先 `lstat`，只接受 regular non-symlink 且 ≤1MiB：

```python
def read_regular(path: Path) -> tuple[str, os.stat_result]: ...
def load_json_object(path: Path) -> dict[str, object]: ...
def parse_env_targets(text: str) -> tuple[list[str], dict[str, object]]: ...
def expand_home(value: object, home: Path) -> object: ...
def render(args: argparse.Namespace) -> dict[str, object]: ...
```

`projects.json` 必须为 array，现有 `projectName=raya`/`agentId=raya` 任一命中即拒绝生成
add patch；row 必须精确通过 FLY-2259 承重字段检查。env memory/root 各必须恰一行；voice
options 可 0/1 行，存在时必须为 JSON object并保留其它键。identity safe diff 仅含两个
identity 文件；env 只输出三个 target 的 parsed before/after，不输出全文。plist 只读模板并
校验 fixed label/wrapper/log paths。最后 `json.dump(report, stdout)`；代码中不得出现 write、
rename、copy、launchctl 或网络调用。`fleetIdentityImpact` 计数所有 registry Leads，并固定说明
assignment digest 是全表 digest，因此新增 Raya 后每个 existing Lead 都必须 rebirth。

- [ ] **Step 1.5 — RED/GREEN：负例逐个跑**

依次加入并验证：duplicate Raya、duplicate env key、invalid voice JSON、voice JSON array、
symlink projects/env/identity/template、oversize input。每格先看预期 FAIL，再补最小 guard，
每格 hash 证明零写。

- [ ] **Step 1.6 — RED：三键 transition 的 apply/verify/rollback**

在 temp 0600 env 上先跑不存在的 `transition-raya-env.py`。CLI 固定为：

```bash
python3 "$TRANSITION" apply --home "$T/home" --target "$TARGET" \
  --env "$T/raya.env" --backup "$T/raya.env.before"
python3 "$TRANSITION" verify --home "$T/home" --target "$TARGET" \
  --before "$T/raya.env.before" --current "$T/raya.env"
python3 "$TRANSITION" rollback --home "$T/home" --target "$TARGET" \
  --backup "$T/raya.env.before" --env "$T/raya.env"
```

期望 apply 原子新增/更新全部三键并创建 0600、同 owner 的 exclusive backup；verify 只允许
三个 target 发生审核过的 transition；rollback 先验证 current 正是 target，再原子恢复 exact
backup bytes/mode/owner，且保留 backup。所有 stdout/stderr 只列 key/digest，不输出 env 全文或
secret value。改前因脚本不存在而红。

- [ ] **Step 1.7 — GREEN：实现三键 transition**

复用 target 的 `$HOME` 展开语义，但不 import renderer，避免让 production writer 借到 diff
renderer 以外的能力。memory/root 在 before 必须各恰一行；voice 可 0/1 行，已有 object 时只
替换 `startInstructionsFile` 并保留其它 JSON keys，不存在时在 roots 行后新增。拒绝 symlink、
非 0600、oversize、duplicate、非法 JSON、已存在 backup 和非 exact rollback current。写入用
同目录 temp + `fchmod/fchown/fsync/os.replace`；任何失败不得留下部分 target。

- [ ] **Step 1.8 — RED/GREEN：transition 负例与反向兼容证明**

逐格验证 voice absent/present-with-extra-key、duplicate target key、invalid/array voice JSON、
wrong mode、symlink、oversize、backup exists、current drift before rollback。另明确断言：新增第三键
后**不再调用** FLY-2259 two-key `edit-raya-env.py --verify`；新 verifier 接管三个键且拒绝其它行
漂移。每格先看预期 FAIL，再补最小 guard。

- [ ] **Step 1.9 — REFACTOR + focused green + CI classification**

提取共享常量仅限各自文件；不创建通用 config mutation library。在
`.github/workflows/ci.yml` 把新 hermetic suite 加进字面 quick-gate 枚举，然后运行新 suite 与
`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`，二者全绿。

- [ ] **Step 1.10 — Commit**

```bash
git add engineering/doc/FLY-2401-raya-read-activation/materials \
  scripts/__tests__/fly2401-raya-read-activation.test.sh .github/workflows/ci.yml
git commit -m "feat(FLY-2401): prepare Raya activation config tools"
```

## Task 2: 两态 activation file verifier

**Files:**

- Create: `engineering/doc/FLY-2401-raya-read-activation/materials/verify-activation-state.py`
- Modify/Test: `scripts/__tests__/fly2401-raya-read-activation.test.sh`

- [ ] **Step 2.1 — RED：pre 态**

用 temp git repo 作为 old memory，以
`git -C "$MEMORY" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false commit -qm base`
提交后 clean；registry 无 Raya、destination/plist/manifest
不存在；装 fake `.codex-raya` 0700、`auth.json` 0600、executable standalone；installed
wrapper 与 source byte-equal；`.env` 仅含一个 `RAYA_BOT_TOKEN` key（值为 sentinel）。运行：

```bash
python3 "$VERIFY_STATE" pre \
  --home "$T/home" --projects "$T/projects.json" --raya-env "$T/raya.env" \
  --global-env "$T/global.env" --project-row "$T/projects.raya-row.json" \
  --env-target "$TARGET" --identity-source "$T/code/IDENTITY.md" \
  --identity-projection "$T/identity/IDENTITY.md" \
  --wrapper-source "$T/repo/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --wrapper-installed "$T/home/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --plist-template "$T/repo/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" \
  --installed-plist "$T/home/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist" \
  --manifest "$T/home/.flywheel/manifests/raya-raya.json"
```

期望 JSON `phase=pre,ready=true,productionWritesPerformed=false`，checks 覆盖 registry absent、
source memory clean、destination absent、account/home modes、standalone executable、wrapper
equal、row/template/asset valid、token key count 1、env 三项仍是允许的 before state、identity
source 有 summary/visible reporting。product 0444 projection 的 digest/mode 可列为 audit-only drift，
但必须带 `authoritativeForLead=false,mutationPlanned=false`，不影响 ready。改前脚本不存在而红。

- [ ] **Step 2.2 — GREEN：实现 pre verifier**

所有 check 统一输出：

```python
{"id": "codex_home", "status": "pass|pending|fail", "detail": "non-secret text"}
```

数据/安全不变量坏（非法 JSON、symlink、duplicate、unexpected partial Raya）是 `fail`/rc=1；
正常但尚缺人工前置（如 `.codex-raya` 不存在）是 `pending`/rc=2；全部 pre-window 前置齐是
rc=0。任何输出不得含 token value。git clean 用
`git -C "$T/home/.flywheel/raya/memory" status --porcelain` 只读探针。

- [ ] **Step 2.3 — RED：active 态**

把 fixture 收敛为 exact Raya row、target env、source memory absent、destination memory/state、
deployed code identity 含所需 Lead contract、manifest 五字段、正式 plist 存在且 deployed template
byte-equal。product 0444 projection 即便字节不同仍期望 `phase=active,ready=true`，只产生 audit
advisory。再分别突变 duplicate Raya、旧 env root、deployed code identity contract 缺失、manifest
wrong workspace、plist `.tui` 残留，每格期望 rc=1 且点名 check。

- [ ] **Step 2.4 — GREEN：实现 active verifier**

active 只承认已收敛字节；不把 launchd/tmux/Discord/Bridge runtime 假装成文件检查。JSON
顶层显式输出：

```json
{"runtimeChecksRequired":["launchd","tmux","heartbeat","discord_roundtrip","bridge_reload","full_fleet_identity_refresh","raya_runtime_registration"]}
```

`full_fleet_identity_refresh` 必须在 operator checklist 中逐席比较 running process env 的
`FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST` / `FLYWHEEL_LEAD_IDENTITY_DIGEST` 与 fresh resolver；
`raya_runtime_registration` 必须在 Bridge reload generation 的日志中证明 Raya 初始注册成功，
或在 30 秒 retry 后出现 exact late-registration 行，不能只用 `/health` 200 代替。

- [ ] **Step 2.5 — zero-write mutation proof + commit**

在 pre/active/hard-failure 三态前后对 fixture tree 做 sorted sha256+mode manifest，完全相等。
运行 shell suite，全部通过后提交：

```bash
git add engineering/doc/FLY-2401-raya-read-activation/materials/verify-activation-state.py \
  scripts/__tests__/fly2401-raya-read-activation.test.sh
git commit -m "feat(FLY-2401): verify Raya activation file states"
```

## Task 3: first-round 三面验收器

**Files:**

- Create: `engineering/doc/FLY-2401-raya-read-activation/materials/verify-first-round.py`
- Modify/Test: `scripts/__tests__/fly2401-raya-read-activation.test.sh`

- [ ] **Step 3.1 — RED：构造完整证据 fixture**

用 Python/`sqlite3` 在 temp 建最小 `lead_events`，写一行：

```text
lead_id=raya
event_id=summary-absorption:2026-09-07T06:00:00.000Z
event_type=summary_absorption_round
session_key=summary-absorption
delivered_at=2026-09-07 06:00:05
delivery_attempts=0
last_delivery_error=NULL
```

再写 matching receipt JSONL、GitHub PR JSON（`state=MERGED,headRefOid=` 后接测试固定的
40 位 `a` SHA）、`MEMORY.md`（含 roundId + receipt file path）。启动临时 loopback HTTP server
模拟 Discord REST `GET /channels/{channelId}/messages/{messageId}`；响应的
message/channel/author 都是审核固定 snowflake，author 是 Raya bot，content 含同一 roundId 与
`reviewed=1 absorbed=1`。verifier 必须自己发 GET 后才 `ok=true`；改前脚本不存在而红。

- [ ] **Step 3.2 — GREEN：实现 exact cross-check**

CLI 必填参数为 `--db`、`--round-id`、`--repo`、`--pr`、`--receipts`、`--memory`、
`--pr-json`、`--discord-message-url`、`--discord-bot-user-id`、`--discord-token-env`。DB 用
`sqlite3.connect('file:...?...mode=ro', uri=True)`；恰一行、字段与 delivery 状态精确。receipt
只接受 `type=merge`、同 round/repo/pr、40-hex sha、非空 files/projects；同逻辑 key 多个不同
sha 拒绝。PR 必须 MERGED 且 head 等于 receipt sha。memory 必须含 roundId 与每个 receipt
file。verifier 从真实 `https://discord.com/channels/{guild}/{channel}/{message}` URL 解析三个
snowflake，以 `os.environ[discord_token_env]` 只读请求 Discord API v10 exact message；token 缺失、
HTTP/JSON 错误都 fail-closed，token 绝不出现在输出。响应的 `channel_id`、`author.id`、message id
都精确匹配，content 含同 roundId 且 `reviewed>=1,absorbed>=1`。不得接受 operator 自填的
URL/author/count/message JSON 作为 production success。

测试专用 `--discord-api-base http://127.0.0.1:PORT --allow-loopback-test-endpoint` 只接受 loopback
HTTP；输出标记 `evidenceSource=loopback_test`。production success 必须省略这两个参数并输出
`evidenceSource=discord_api_v10`。任何非 Discord HTTPS/non-loopback override 都拒绝。

DB 的硬成功条件是 `delivered_at IS NOT NULL`；若历史 `last_delivery_error` 非空，输出
`advisories` 而不是判失败，因为 StateStore 成功投递不会清该列。

- [ ] **Step 3.3 — RED/GREEN：反证格**

依次突变：wrong DB path、0/2 rows、undelivered、receipt missing/wrong round、PR OPEN/head
mismatch、memory missing round/file、Discord token env missing、HTTP failure、wrong
channel/author/message/round、zero absorbed、非法 API override。
另加一格 `delivered_at` 非空且 stale `last_delivery_error` 非空，期望 rc=0 但 advisory 精确出现。
每格先观察期望失败，再加最小 guard；错误只输出 non-secret evidence id。

- [ ] **Step 3.4 — focused green + commit**

```bash
bash scripts/__tests__/fly2401-raya-read-activation.test.sh
git add engineering/doc/FLY-2401-raya-read-activation/materials/verify-first-round.py \
  scripts/__tests__/fly2401-raya-read-activation.test.sh
git commit -m "feat(FLY-2401): verify Raya first summary round"
```

## Task 4: operator checklist 与当前 production proposal

**Files:**

- Create: `engineering/doc/FLY-2401-raya-read-activation/activation-checklist.md`
- Create: `engineering/doc/FLY-2401-raya-read-activation/production-change-proposal.md`

- [ ] **Step 4.1 — 写 activation checklist**

逐节列：owner、是否只读、命令、期望输出、停止线、回滚。顺序固定：

1. deployed SHA / 备份 / residue / quiet window；fresh fetch 后必须满足 deployed SHA = checkout
   HEAD = origin/main，且 Lead 确认 activation window 内 main merge freeze；若有待部署 commits，
   先在**独立部署窗口**完成并重新从第 1 步审计，不能与 activation transaction 混跑；
2. founder 独立 `~/.codex-raya` login + 同版 standalone；
3. static/live Discord identity/channel read probe（零消息）；
4. renderer + pre verifier，保存 JSON；
5. `ask --lead ...` 报 exact diffs/回滚，等 Lead 明确决定；
6. 先运行 deployed `restart-services.sh --dry-run`，证明 fetch target 仍是同一 already-at SHA、
   summary/identity/plugin/tmux preflights 均通过且 commit range 为空；再在所有现有 Lead 都停止
   发写、restart transaction 随时可执行的窗口，保存
   fresh current-seat digest/PID census（本次审计是 16，执行时记为 N）；此后 registry 写入到全 fleet 新 digest 验绿之间，任何旧 Lead
   `send/respond` 都是禁止流量，不得跨人工等待或班车边界；
7. product brain stop、memory move、用新三键 transition helper 原子更新 env、product
   preflight/restart；0444 product identity projection 只做 audit，不 copy/chmod、不进 ready；
8. FLY-2259 registry registrar + summary receipt migration，紧接着 converge、唯一 manifest、plist
   正名/bootstrap 与 installed summary/launcher preflight；
9. registry 写入前最后一次 `git ls-remote origin refs/heads/main` 必须仍等于 pinned deployed
   SHA；立即执行 Lead 批准的 deployed `restart-services.sh`，它虽然 commit range 为空，仍会
   reload Bridge + restart **全 Lead fleet**；若 transaction 未能立即开始或失败，保持写流量冻结并进入 rollback，不允许留下
   16 个 stale identity env；
10. 验 Bridge `/health` 与 restart status，并逐席比较 running env 的 summary/identity digest 对
    fresh resolver；要求 old PID 不再承担 Lead 写入，且 total=N+1、failed=0；
11. 验 Raya carrier pid/pane/heartbeat/exact probe、Discord roundtrip，并从本次 Bridge generation
    日志证明 Raya runtime 初始注册或 30 秒 late-register 成功；只看到 `/health` 200 不算通过；
12. 从 live cadence/activation time 计算 next slot，等 exact round row `delivered_at IS NOT NULL`；
13. Raya 自己 review/merge 至少一张 PR，收集 receipt/memory/PR JSON，把真实 Discord message
    URL 交给 first-round verifier，由它用 Raya bot token 现场做只读 GET；
14. 任一步失败保持 write freeze，按 carrier→manifest→product/env→registry/receipt 逆序回滚，
    然后用同一 deployed restart transaction 再次 reload Bridge + restart 全 fleet 并验回旧 digest。

禁止在 checklist 中提供绕过 `summary merge` 的裸 merge 命令。

- [ ] **Step 4.2 — 生成 current proposal**

对 current live paths 跑 renderer（只读），把 JSON 中每一处变更翻译为 markdown diff；记录
as-of UTC、input sha256、当前缺项、执行 owner、rollback。production proposal 不复制任何
token/secret/完整 env；identity 大 diff 只作为 `audit_only/non_blocking` 记录 source/projection
digest，明确没有 identity projection 写入。proposal 必须单列 registry 全局 digest 爆炸半径、
write-freeze 起止点、全 fleet restart 与 rollback 后第二次全 fleet restart，并列出 fresh
`deployed..origin/main` commit range（activation window 必须为空）。若非空，只能先单独报 Lead
批准/部署并重新生成整份 proposal，不能在 registry transaction 中顺带部署。

- [ ] **Step 4.3 — 文档自审**

检查无模糊值、无未解析占位、无过期 PR state 伪装成最终事实；每个用户点名面
`projects.json/workspace/launchd-wrapper/identity/Discord/Codex home-account/6h event/PR merge`
都有命令 + 期望 + 回滚；另检查没有任何步骤在 registry 写入后、全 fleet digest 验绿前要求
旧 Lead 执行 `flywheel-comm send/respond`。

- [ ] **Step 4.4 — Commit**

```bash
git add engineering/doc/FLY-2401-raya-read-activation/activation-checklist.md \
  engineering/doc/FLY-2401-raya-read-activation/production-change-proposal.md
git commit -m "docs(FLY-2401): add Raya activation operator checklist"
```

## Task 5: verification、Lead 变更审批、code review、PR

- [ ] **Step 5.1 — 聚焦验证**

```bash
bash scripts/__tests__/fly2401-raya-read-activation.test.sh
python3 engineering/doc/FLY-2401-raya-read-activation/materials/render-production-diff.py \
  --home "$HOME" --projects "$HOME/.flywheel/projects.json" \
  --raya-env "$HOME/.flywheel/raya/raya.env" \
  --identity-source "$HOME/.flywheel/raya/code/IDENTITY.md" \
  --identity-projection "$HOME/.flywheel/raya/identity/IDENTITY.md" \
  --project-row "$HOME/Dev/flywheel/engineering/doc/FLY-2259-raya-brain-cutover/materials/projects.raya-row.json" \
  --plist-template "$HOME/Dev/flywheel/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" \
  --env-target engineering/doc/FLY-2401-raya-read-activation/materials/raya-env-target.json
python3 engineering/doc/FLY-2401-raya-read-activation/materials/verify-activation-state.py pre \
  --home "$HOME" --projects "$HOME/.flywheel/projects.json" \
  --raya-env "$HOME/.flywheel/raya/raya.env" --global-env "$HOME/.flywheel/.env" \
  --project-row "$HOME/Dev/flywheel/engineering/doc/FLY-2259-raya-brain-cutover/materials/projects.raya-row.json" \
  --env-target engineering/doc/FLY-2401-raya-read-activation/materials/raya-env-target.json \
  --identity-source "$HOME/.flywheel/raya/code/IDENTITY.md" \
  --identity-projection "$HOME/.flywheel/raya/identity/IDENTITY.md" \
  --wrapper-source "$HOME/Dev/flywheel/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --wrapper-installed "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --plist-template "$HOME/Dev/flywheel/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" \
  --installed-plist "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist" \
  --manifest "$HOME/.flywheel/manifests/raya-raya.json"
```

renderer 期望 rc=0/零写；pre verifier 在当前 `~/.codex-raya` 缺失时预期 rc=2，并准确列该
人工前置，不把 expected pending 当测试失败。执行前必须证明 `$HOME/Dev/flywheel` HEAD 等于
`$HOME/.flywheel/deployed-sha`；wrapper/plist/FLY-2259 row 的 authority 一律取该 deployed
checkout，不取 FLY-2401 worktree。

- [ ] **Step 5.2 — full repository gates**

按用户给定精确命令 fresh run：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/fly2401-raya-read-activation.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
```

节点合同要求的 `pnpm test:packages:run` 保持字面不变；但它在可驱动 Terminal.app 的 macOS
进程会运行真实 GUI 用例。不得在 founder 活跃桌面盲跑：先用 Lead question gate 协调一个不会
干扰 founder 的执行窗口，或由 Lead 指定非 GUI/Linux 执行上下文；没有这个执行条件时保持该
gate 为 pending，不以窄测试冒充全仓绿，也不通过伪造 `osascript` 来制造 skip。辅助定位可先跑
`pnpm --filter flywheel-core exec vitest run --passWithNoTests --exclude test/tmux-viewer.macos.test.ts`
和其余 package tests，但它们不能替代上面的 exact gate。

- [ ] **Step 5.3 — 向 Lead 报 production diff 与回滚**

使用 `flywheel-comm ask --lead flywheel-eng-lead --exec-id ...`，报告：

- registry JSON Patch；
- env 三项 before/after；
- identity source/projection digest 的 audit-only drift（明确 no write）；
- workspace move、manifest/plist/bootstrap、Bridge + 全 Lead fleet restart 的 runtime delta；
- Codex login 尚需 founder；
- registry 写入令全部旧 Lead digest 失效的爆炸半径、write-freeze 停止线；
- R1–R5 逆序回滚及回旧 registry 后的第二次全 fleet restart；
- 明确“实现节点未改生产，等待 Lead 批后执行或代执行”。

若 Lead instruction 要求动作，先核权限边界；每条完成后把消息里的完整
`[lead-instruction …]` id 原样放进
`ask --report "DONE: ..."` 回执。

- [ ] **Step 5.4 — request-driven code review**

进入 `code_review`。按节点合同用 `codex:rescue` 做本地 review（不运行 raw `codex exec`），
并注册：

```bash
review_question_id="$(node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead \
  --exec-id 0da88295-5180-406e-a281-998c83b2344f --no-block \
  "Code review requested for FLY-2401" | jq -er '.questionId')"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$review_question_id"
```

轮询 verdict；CHANGES_REQUESTED 修 blocking finding、fresh verification、push 新 head、开新
question；APPROVED advisories 用 `ask --report` 转 Lead。

- [ ] **Step 5.5 — PR 与 literal-last milestone**

push feature branch，创建 PR；最后新建 `engineering/doc/milestones/FLY-2401.md`，其 commit
必须是 PR literal last。不得修改 `CLAUDE.md`。

- [ ] **Step 5.6 — bounded implement completion**

通过唯一 report channel 汇报 commits/tests/review/PR/production pending，然后：

```bash
pr_number="$(gh pr view --json number --jq .number)"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$pr_number"
```

不 dispatch QA、不请求 ship approval、不 merge/deploy。生产激活与下一 6h round 验收仍按
Lead/operator window 执行；实现节点提供的 first-round verifier 是后续机械验收入口。

## Self-review

- Spec coverage：用户点名的 6 个激活面、生产禁止写、Lead diff/rollback、6h round、Raya
  summary read receipt 均有实施 task 与证据入口。
- Scope：不修改既有 activation mechanism 或 merge authority；唯一 production writer 是需
  Lead/operator 显式调用的三键 env transition helper，其余 renderer/verifier 只读。
- Type/interface consistency：四个 CLI 都只接 explicit paths；renderer、transition 与 state
  verifier 共用同一 target JSON；first-round verifier 的 roundId 同时绑定 DB/receipt/memory/
  Discord API live message。
- Failure semantics：输入异常 rc=1，正常人工缺项 rc=2，全部条件成立 rc=0；输出不含 secret。
- Review round 1 的三个 HIGH 已闭合：registry 写入被收进 write-freeze + Bridge/全 fleet restart
  事务；新 hermetic suite 明确登记 `ci.yml`；三键 env 有自己的 atomic apply/verify/rollback，
  不再让 FLY-2259 two-key verifier 误判。
- 其余审查项：0444 projection 改为 audit-only；runtime registration 加独立日志证据；visible
  report 改成 verifier 现场 GET Discord REST message；deployed checkout 成为 wrapper/plist authority；stale
  delivery error 降为 advisory。真实 Terminal.app suite 与节点要求的 exact package gate 有直接
  冲突，因此保留 exact gate、增加 Lead 协调的非干扰执行条件，不伪造 skip。
- Review round 2 的 HIGH 已闭合：承认 `restart-services.sh` 是 deploy transaction；activation
  窗口要求 fresh origin/main = checkout HEAD = deployed SHA、dry-run 全绿及 main merge freeze。
  任意待部署 commit 必须先走独立窗口并重新基线，registry 写入后不顺带部署。

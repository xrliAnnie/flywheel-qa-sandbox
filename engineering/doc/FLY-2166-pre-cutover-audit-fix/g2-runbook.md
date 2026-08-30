# FLY-2166 FLY-2103 手工 G2 — 运行手册

Issue: FLY-2166 (https://linear.app/geoforge3d/issue/FLY-2166/fly-2103-遗留-迁移脚本-pre-cutover-审计对真实仓库结构性不可通过g1-receipt-不可获得已手工等价完成迁移)
日期: 2026-08-29
基于: plan.md

## 0. 适用范围与停手规则

这份手册只用于完成 FLY-2103 已约定的手工 post-deploy:在**新 Bridge** 上写第 7 行
`ponytail/*=0`,然后执行 G2。原迁移脚本的 G1 receipt 结构性不可获得;这里不伪造、
不补铸任何 `status: passed` receipt。6 行 G1 manifest 已于 2026-08-29 通过真实 Bridge
`stage → apply` 手工写入并逐行复核。

以下任一项不符合预期就立即停止,保留现场,把证据贴入 FLY-2103 thread,交 Lead/founder
裁决。不得「修到看起来对」、不得接受多余行、不得用 snapshot 代替完整可观察面核对。

## 1. 先绑定环境并创建证据目录

操作者先填写四个**绝对路径/loopback origin**,不要沿用别的终端里碰巧存在的环境变量:

```bash
export FLY2103_BRIDGE_ORIGIN='http://127.0.0.1:9876'
export FLY2103_DB_PATH='/absolute/path/to/the-bridge-teamlead.db'
export FLY2103_PROJECTS_FILE='/absolute/path/to/projects.json'
export FLY2103_FLYWHEEL_ROOT='/absolute/path/to/flywheel-main-checkout'
export FLY2103_EVIDENCE_DIR='/absolute/path/to/FLY-2103-g2-evidence'
mkdir -p "$FLY2103_EVIDENCE_DIR"
```

### 1.1 证明 SQL、写入与 snapshot 指向同一个 Bridge/DB

1. 先验证 origin 是裸 loopback origin,并解析监听端口:

   ```bash
   export FLY2103_BRIDGE_PORT="$(
     node -e 'const u=new URL(process.argv[1]); if(!["127.0.0.1","localhost","::1","[::1]"].includes(u.hostname)||u.username||u.password||!/^\/?$/.test(u.pathname)||u.search||u.hash) process.exit(2); console.log(u.port || (u.protocol === "https:" ? "443" : "80"))' \
       "$FLY2103_BRIDGE_ORIGIN"
   )"
   export FLY2103_DB_REALPATH="$(realpath "$FLY2103_DB_PATH")"
   ```

2. 监听端口必须只有一个 PID;该 PID 必须实际打开上面的 DB realpath。`lsof` 输出保存为
   证据,不能只相信默认的 `~/.flywheel/teamlead.db`:

   ```bash
   export FLY2103_BRIDGE_PID="$(
     lsof -nP -iTCP:"$FLY2103_BRIDGE_PORT" -sTCP:LISTEN -t | sort -u
   )"
   test -n "$FLY2103_BRIDGE_PID"
   test "$(printf '%s\n' "$FLY2103_BRIDGE_PID" | wc -l | tr -d ' ')" -eq 1
   lsof -nP -a -p "$FLY2103_BRIDGE_PID" "$FLY2103_DB_REALPATH" \
     > "$FLY2103_EVIDENCE_DIR/bridge-db-binding.txt"
   test -s "$FLY2103_EVIDENCE_DIR/bridge-db-binding.txt"
   sed -n '1,20p' "$FLY2103_EVIDENCE_DIR/bridge-db-binding.txt"
   ```

3. 先拷贝写前 snapshot,并记录 UTC、Bridge PID、DB realpath。snapshot 请求失败不能继续:

   ```bash
   date -u +%Y-%m-%dT%H:%M:%SZ \
     | tee "$FLY2103_EVIDENCE_DIR/started-at.txt"
   printf 'bridge_origin=%s\nbridge_pid=%s\ndb_realpath=%s\n' \
     "$FLY2103_BRIDGE_ORIGIN" "$FLY2103_BRIDGE_PID" "$FLY2103_DB_REALPATH" \
     | tee "$FLY2103_EVIDENCE_DIR/environment-binding.txt"
   curl --fail-with-body --silent --show-error \
     "$FLY2103_BRIDGE_ORIGIN/api/fleet/snapshot" \
     | jq -S . | tee "$FLY2103_EVIDENCE_DIR/snapshot-before.json" >/dev/null
   ```

### 1.2 绑定六个 checkout 的 Git 身份

`projects.json` 必须恰好列出 flywheel / geoforge3d / growth / joycon-typeless /
personal-assistant / tidal-echo。逐仓记录 checkout realpath、HEAD、upstream ref 与 upstream SHA:

```bash
(
  set -euo pipefail
  identity_file="$FLY2103_EVIDENCE_DIR/checkout-identities.tsv"
  : > "$identity_file"
  jq -e '[.[].projectName] | sort == [
    "flywheel", "geoforge3d", "growth", "joycon-typeless",
    "personal-assistant", "tidal-echo"
  ]' "$FLY2103_PROJECTS_FILE" \
    > "$FLY2103_EVIDENCE_DIR/project-set-check.txt"

  while IFS=$'\t' read -r project root; do
    upstream_error="$FLY2103_EVIDENCE_DIR/${project}-upstream-errors.txt"
    : > "$upstream_error"
    root_real="$(realpath "$root")"
    upstream_ref="$(
      git -C "$root_real" rev-parse --symbolic-full-name '@{upstream}' \
        2> "$upstream_error"
    )"
    test -n "$upstream_ref"
    head_sha="$(git -C "$root_real" rev-parse HEAD 2>> "$upstream_error")"
    upstream_sha="$(
      git -C "$root_real" rev-parse "${upstream_ref}^{commit}" \
        2>> "$upstream_error"
    )"
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$project" "$root_real" "$head_sha" "$upstream_ref" "$upstream_sha" \
      >> "$identity_file"
  done < <(jq -er '.[] | [.projectName,.projectRoot] | @tsv' "$FLY2103_PROJECTS_FILE")

  test "$(wc -l < "$identity_file" | tr -d ' ')" -eq 6
  cat "$identity_file"
)
```

## 2. 维护窗内保全式收敛六仓 config

先确认 GeoForge3D#283、joycon-typeless#49、belle-workspace#3、growth#25、
tidal-echo#28 已合并并 fetch 到各仓 upstream;flywheel 的 #987 已在 upstream。每仓执行:

1. 在任何修改前保存 `status`、完整 `config.yaml` diff、worktree 文件和 upstream 文件。
2. 从 upstream log 明确认出对应 companion merge/commit。
3. 只调和 retired-key 对应的 hunk。推荐用
   `git restore --source=<upstream-sha> --patch -- .flywheel/config.yaml` 逐 hunk 选择;禁止整文件
   `reset` / blanket `restore` / 随手 commit。joycon-typeless 等仓的无关未提交配置必须保留。
4. 保存修改后 diff,人工逐 hunk 证明:retired-key 投影已跟 upstream 一致且为空;修改前存在的
   非 retired 内容仍原样存在。冲突或无法证明时停止。

证据命令形状:

```bash
git -C '<project-root>' status --short -- .flywheel/config.yaml \
  > "$FLY2103_EVIDENCE_DIR/<project>-status-before.txt"
git -C '<project-root>' diff -- .flywheel/config.yaml \
  > "$FLY2103_EVIDENCE_DIR/<project>-config-before.diff"
cp '<project-root>/.flywheel/config.yaml' \
  "$FLY2103_EVIDENCE_DIR/<project>-config-worktree-before.yaml"
git -C '<project-root>' show '<upstream-sha>:.flywheel/config.yaml' \
  > "$FLY2103_EVIDENCE_DIR/<project>-config-upstream.yaml"

# 逐 hunk 选择,只接受 companion PR 的 retired-key 清理
git -C '<project-root>' restore --source='<upstream-sha>' --patch -- \
  .flywheel/config.yaml

git -C '<project-root>' diff -- .flywheel/config.yaml \
  > "$FLY2103_EVIDENCE_DIR/<project>-config-after.diff"
git -C '<project-root>' diff --check -- .flywheel/config.yaml
```

最终对 worktree 与刷新后的 committed upstream 双侧做 YAML-aware 审计。以下脚本打印 8 个
审计类别(覆盖原 9 类 retired flag path;`pipeline` 整块算一类)并以 exit 1 表示有残留;
空输出 + exit 0 才通过。对每仓的 worktree 文件和
`git show <upstream-sha>:.flywheel/config.yaml` 保存文件各跑一次:

```bash
FLY2103_CONFIG_INPUT='<absolute-config-yaml>' \
pnpm --dir "$FLY2103_FLYWHEEL_ROOT" exec tsx -e '
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const c = parse(readFileSync(process.env.FLY2103_CONFIG_INPUT!, "utf8")) ?? {};
const hit: string[] = [];
for (const [name, value] of Object.entries(c.checkpoints ?? {}))
  if (value && typeof value === "object" && Object.hasOwn(value, "enabled"))
    hit.push(`checkpoints.${name}.enabled`);
if (c.doc_flow && Object.hasOwn(c.doc_flow, "enabled")) hit.push("doc_flow.enabled");
if (Object.hasOwn(c, "pipeline")) hit.push("pipeline");
if (c.skills?.proofshot && Object.hasOwn(c.skills.proofshot, "enabled"))
  hit.push("skills.proofshot.enabled");
if (c.xiaohongshu_learning && Object.hasOwn(c.xiaohongshu_learning, "enabled"))
  hit.push("xiaohongshu_learning.enabled");
for (const [index, col] of (c.xiaohongshu_learning?.collections ?? []).entries())
  if (col && typeof col === "object" && Object.hasOwn(col, "auto_create"))
    hit.push(`xiaohongshu_learning.collections[${index}].auto_create`);
if (Object.hasOwn(c, "ponytail")) hit.push("ponytail");
if (Object.hasOwn(c, "skill_framework")) hit.push("skill_framework");
if (hit.length) console.log(hit.sort().join("\n"));
if (hit.length) process.exitCode = 1;
'
```

## 3. 写前 preflight:只接受 exact 6 或 exact 7

审计域固定为 7 个 flag。先从**已绑定的 DB realpath**读取全部行(包括
`has_override=0`),保存原始证据:

```bash
sqlite3 -json "$FLY2103_DB_REALPATH" \
  "SELECT flag_name AS name, scope, has_override AS hasOverride, raw_value AS raw
     FROM flag_values
    WHERE flag_name IN ('doc_flow','pipeline_dag','pipeline_work_kind','proofshot',
      'xiaohongshu_learning','ponytail','skill_framework_split_participation')
    ORDER BY flag_name, scope;" \
  | jq -S . | tee "$FLY2103_EVIDENCE_DIR/rows-preflight.json"
```

允许的 G1 六行与最终七行只有下面两个 exact set。这里的字面行也是 FLY-1436 enrollment
回归测试的仓内锚点:

```ts
{ name: "doc_flow", scope: "flywheel", raw: "1" }
{ name: "doc_flow", scope: "joycon-typeless", raw: "1" }
{ name: "doc_flow", scope: "personal-assistant", raw: "1" }
{ name: "doc_flow", scope: "tidal-echo", raw: "1" }
{ name: "pipeline_dag", scope: "flywheel", raw: "1" }
{ name: "pipeline_work_kind", scope: "flywheel", raw: "1" }
{ name: "ponytail", scope: "*", raw: "0" }
```

判定:

- 恰好前 6 行,且每行 `hasOverride=1` → 允许进入 §4 写第 7 行。
- 恰好最终 7 行,且每行 `hasOverride=1` → 安全重入,**不再 stage/apply**,直接进入 §5。
- 其他任何状态(缺 G1 行、异值、`hasOverride=0`、已有 `ponytail/*=1`、任意额外
  name/scope 行) → 停止并裁决,不得触碰 `/stage`。

## 4. 在新 Bridge 上 stage → apply 第 7 行

只有 §3 判定为 exact 6 时执行。stage payload 必须是以下固定值;`Origin` 必须与 loopback
origin 完全一致。`curl --fail-with-body` 保证任一步非 2xx 立即失败:

```bash
jq -n '{
  name: "ponytail",
  to: false,
  project: "*",
  op: "set",
  reason: "FLY-2103 config.yaml flag migration"
}' > "$FLY2103_EVIDENCE_DIR/stage-request.json"

curl --fail-with-body --silent --show-error \
  -X POST "$FLY2103_BRIDGE_ORIGIN/api/fleet/flag/stage" \
  -H 'Content-Type: application/json' \
  -H "Origin: $FLY2103_BRIDGE_ORIGIN" \
  --data-binary @"$FLY2103_EVIDENCE_DIR/stage-request.json" \
  | jq -S . | tee "$FLY2103_EVIDENCE_DIR/stage-response.json"

jq -e '
  .canonical.kind == "flag_store" and
  .canonical.name == "ponytail" and
  .canonical.scope == "*" and
  .canonical.op == "set" and
  .canonical.rawTo == "0" and
  .canonical.actor == "bridge-local-operator" and
  .canonical.reason == "FLY-2103 config.yaml flag migration" and
  (.confirmToken | type == "string" and length > 0)
' "$FLY2103_EVIDENCE_DIR/stage-response.json"

jq '{canonical, confirmToken}' "$FLY2103_EVIDENCE_DIR/stage-response.json" \
  > "$FLY2103_EVIDENCE_DIR/apply-request.json"

curl --fail-with-body --silent --show-error \
  -X POST "$FLY2103_BRIDGE_ORIGIN/api/fleet/flag/apply" \
  -H 'Content-Type: application/json' \
  -H "Origin: $FLY2103_BRIDGE_ORIGIN" \
  --data-binary @"$FLY2103_EVIDENCE_DIR/apply-request.json" \
  | jq -S . | tee "$FLY2103_EVIDENCE_DIR/apply-response.json"
jq -e '.ok == true' "$FLY2103_EVIDENCE_DIR/apply-response.json"
```

不得手改 stage 返回的 `canonical`,不得重用 confirmToken。stage 后 apply 失败时停止并重新从
§3 读 DB;不要盲重放旧 token。

## 5. G2-a:DB exact-set 必须恰好 7 行

重跑 §3 的完整 SQL,输出存为 `rows-g2.json`。结果必须逐行等于 §3 的最终 7 行且全部
`hasOverride=1`;顺序按 `flag_name, scope`。然后核对本次写入的 changelog actor/reason:

```bash
sqlite3 -json "$FLY2103_DB_REALPATH" \
  "SELECT flag_name AS name, scope, has_override AS hasOverride, raw_value AS raw
     FROM flag_values
    WHERE flag_name IN ('doc_flow','pipeline_dag','pipeline_work_kind','proofshot',
      'xiaohongshu_learning','ponytail','skill_framework_split_participation')
    ORDER BY flag_name, scope;" \
  | jq -S . | tee "$FLY2103_EVIDENCE_DIR/rows-g2.json"

sqlite3 -json "$FLY2103_DB_REALPATH" \
  "SELECT flag_name, scope, from_raw, to_raw, changed_by, reason, changed_at
     FROM flag_value_changelog
    WHERE flag_name='ponytail' AND scope='*'
    ORDER BY id DESC LIMIT 1;" \
  | jq -S . | tee "$FLY2103_EVIDENCE_DIR/ponytail-changelog.json"
```

`ponytail-changelog.json` 必须显示 `to_raw="0"`、changed_by=`bridge-local-operator`、reason=
`FLY-2103 config.yaml flag migration`,且时间落在本窗口。任何额外行也算 G2 FAIL。

## 6. G2-b:六仓 config 残留清零

对 §1.2 绑定的每个 worktree config 和对应 upstream SHA 文件重跑 §2 的 YAML-aware 审计。
12 次都必须空输出、exit 0。保存每次 stdout/stderr 和 exit code。再复核:

- 六仓 worktree 与 committed 的 retired-key 投影都为空;
- 每仓非 retired 的本地 diff 与 §2 修改前证据一致;
- 没有为了过门而 reset/commit 无关修改。

## 7. G2-c:完整可观察面核对

先保存写后 snapshot:

```bash
curl --fail-with-body --silent --show-error \
  "$FLY2103_BRIDGE_ORIGIN/api/fleet/snapshot" \
  | jq -S . | tee "$FLY2103_EVIDENCE_DIR/snapshot-after.json" >/dev/null
jq '.flags[] | select(.name == "doc_flow" or .name == "pipeline_dag" or
  .name == "pipeline_work_kind" or .name == "proofshot" or
  .name == "xiaohongshu_learning" or .name == "ponytail" or
  .name == "skill_framework_split_participation")' \
  "$FLY2103_EVIDENCE_DIR/snapshot-after.json" \
  | tee "$FLY2103_EVIDENCE_DIR/snapshot-seven-flags.json"
```

snapshot 的 7×6 effective 基准:

| flag | flywheel | geoforge3d | growth | joycon-typeless | personal-assistant | tidal-echo |
|---|---|---|---|---|---|---|
| `doc_flow` | ON | OFF | OFF | ON | ON | ON |
| `pipeline_dag` | ON | ON | ON | ON | ON | ON |
| `pipeline_work_kind` | ON | OFF | OFF | OFF | OFF | OFF |
| `proofshot` | OFF | OFF | OFF | OFF | OFF | OFF |
| `xiaohongshu_learning` | OFF | OFF | OFF | OFF | OFF | OFF |
| `ponytail` | OFF | OFF | OFF | OFF | OFF | OFF |
| `skill_framework_split_participation` | ON | ON | ON | ON | ON | ON |

snapshot 只是底层核对。还必须逐项执行并记录以下真实可观察结果:

1. **fresh DAG dispatch**:经正常 Lead/Bridge 流程启动一个事先批准的测试 issue,记录 issue、
   execution/run id、启动时间与 cmux/Bridge 证据;确认新 dispatch 没有被错误 held。不得用生产
   issue 做无授权试验。
2. **active DAG recovery**:在维护窗重启前绑定一个已在跑的 DAG execution;新 Bridge 后确认
   同一 run 被恢复且不是 `held`。若窗口内没有可安全观察的 active run,明确记为缺口并交
   Lead/founder 裁决,不得写 PASS。
3. **DOC-FLOW prompt**:对六项目的受控 fresh start 检查实际 runner prompt。flywheel /
   joycon-typeless / personal-assistant / tidal-echo 必须含 DOC-FLOW block;geoforge3d / growth
   必须不含。记录 execution id 与 prompt 证据,不能仅据 snapshot 推断。
4. **flywheel work_kind**:fresh flywheel issue 必须走 work-kind routing;记录选中的 workflow/
   node 与 dispatch 证据。其他五项目仍 OFF。
5. **ProofShot `session_params`**:fresh execution 开始后,从同一 DB 查询对应 session 的
   `json_extract(session_params,'$.proofshot.config')`;必须存在有效配置且 effective
   `enabled=false`。记录 execution id + SQL 输出,证明写入的是持久化 session 形状。
6. **ponytail resolver**:无 per-run/label/arm 信号的六项目 fresh start 必须持久化
   `off:default`(project store 的 `*=0` 与旧 `undefined` 字节等价)。另用受控 selector case
   确认既有 per-run / `ponytail` / `ponytail-off` / conflict 路没有被迁移破坏;记录
   `sessions.ponytail_condition`。明确区分「project default 全 OFF」和仍合法的显式 selector。
7. **split participation**:六项目均解析为 ON;受控 execution 记录参与臂/持久化 stamp。
   store 读取失败的 fail-closed A 臂是故障语义,不能拿来冒充成功观察。
8. **xiaohongshu planner**:以 scheduler 的 dry/plan-only 观察路径跑一轮,六项目
   `xiaohongshu_learning` 都为 OFF,不得产生 learning spawn;保存 planner 输出。若 gated-pilot
   入口在窗口内不可安全运行,记录缺口并交裁决,不能仅用 snapshot 代替。

上面任一项真实结果与基准不同、无法观察、或证据没有绑定 execution/run id,都不能静默跳过。

## 8. 记录与收尾

遵守「证据先拷后引」:每个会改变/销毁现场的动作之前先把 SQL、snapshot、stage/apply 响应、
Git diff 与运行证据复制进证据目录。最后记录 UTC 完成时间和证据目录 digest:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ \
  | tee "$FLY2103_EVIDENCE_DIR/completed-at.txt"
find "$FLY2103_EVIDENCE_DIR" -type f ! -name SHA256SUMS -print \
  | LC_ALL=C sort \
  | while IFS= read -r evidence_file; do shasum -a 256 "$evidence_file"; done \
  | tee "$FLY2103_EVIDENCE_DIR/SHA256SUMS"
```

把以下内容贴入 FLY-2103 thread:环境绑定、六仓 SHA、preflight 判定、stage/apply 响应、
G2-a/b/c 逐项 PASS/FAIL、所有显式 observation gap、证据目录/附件链接。G1 receipt 一栏写
「结构性不可获得,FLY-2166 已判死」,不要制造替代 receipt。

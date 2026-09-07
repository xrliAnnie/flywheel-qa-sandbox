# FLY-2401 Raya 读侧激活 — 激活检查单
Issue: FLY-2401 (https://linear.app/geoforge3d/issue/FLY-2401/raya读侧-按-fly-2131-激活清单把-raya-codex-leadagentidraya真正激活生产里-summary-6h)
日期: 2026-09-06
基于: plan.md

这是 FLY-2131 B/C 与 FLY-2259 激活事务的 fail-closed 执行版，不是部署授权。实现节点不执行
production mutation；只有 Lead 明确批准的 operator 才能执行。Raya 的 summary PR 只能由 Raya
自己通过 `flywheel-comm summary merge` 合并，本页不提供裸 merge 命令。

## Lead 已裁定的 Preconditions（production mutation 前全部满足）

1. **P1 — production 先追平。** 独立部署必须至少包含 `b63a2d97dc914a7b19dea17fe6c5bf0587354e3c`，
   且 fresh `origin/main`、`~/Dev/flywheel` HEAD、`~/.flywheel/deployed-sha` 三者相等。部署追平后，
   必须从新 checkout 重新 render registry/env 候选；本页记录的旧审计 hash 不能直接执行。
2. **P2 — FLY-2404 先落地。** `~/.codex-raya` 不由 founder 再登录一次，也不复制凭据；必须等
   FLY-2404 的 link-truth helper 实现、合并、部署后，由该 helper 从共享 business truth
   `~/.codex/auth.json` 投影并按其最终 shipped contract 验证。helper 或最终 runbook 尚不存在时，
   本激活事务 fail closed。
3. **P3 — 只搭 R4 舰队班车。** Raya 加席导致 17 席 digest 重算；forward 与 rollback 的 full-fleet
   restart 都只能由获批 updater/bus 窗口执行，禁止为 FLY-2401 单独调用 restart。目标窗口为
   `2026-09-08 00:00 PT`；若 FLY-2404 提前落地，可改搭 `2026-09-07 12:00 PT`。只有当班车
   已确认即将触发时才可进入 write freeze 与 registry mutation，事务中不得跨等待边界。
4. **P4 — 执行与 QA 分工。** Lead 是逐步执行者，先跑 dry-run；`send/respond` freeze 与 R1–R5
   保持不变。实现/QA 节点只验证包完整性和 dry-run，不把生产 mutation、真实 6h event 或 merge
   收据当作本节点完成条件；生产激活与后验收由上述 Lead 窗口执行。

## 0. 固定坐标与总停止线

```bash
set -euo pipefail
umask 077
export FLYWHEEL_REPO="$HOME/Dev/flywheel"
export FLYWHEEL_CLI="$FLYWHEEL_REPO/packages/flywheel-comm/dist/index.js"
export FLY2401="$FLYWHEEL_REPO/engineering/doc/FLY-2401-raya-read-activation"
export FLY2259="$FLYWHEEL_REPO/engineering/doc/FLY-2259-raya-brain-cutover"
export PROJECTS="$HOME/.flywheel/projects.json"
export RECEIPT="$HOME/.flywheel/state/summary-registry/migration-receipt.json"
export RAYA_ENV="$HOME/.flywheel/raya/raya.env"
export RAYA_WORKSPACE="$HOME/Dev/raya-lead-workspace"
export RAYA_PLIST="$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.plist"
export RAYA_LABEL="com.flywheel.lead.raya-raya"
export WINDOW_ROOT="$HOME/.flywheel/state/FLY-2401-window"
export EVIDENCE="$WINDOW_ROOT/evidence-$(date -u +%Y%m%dT%H%M%SZ)"
export ENV_BACKUP="$EVIDENCE/raya.env.transition.backup"
```

总停止线：任一断言失败，停止向前，保持 Lead 写流量冻结，并按 §14 从当前层逆序回滚。registry
写入后到 17 席新 digest 全绿前，不跨人工等待、班车边界或 main merge；任何旧 Lead 的
`flywheel-comm send/respond` 都是禁止流量。

## 1. 独立部署、三 SHA、备份、残留与安静窗口

- Owner / 写入：Lead/operator；`git fetch`、证据与备份仅在批准窗口执行。待部署代码先走独立窗口。
- 验证命令：

```bash
remote_sha="$(git -C "$FLYWHEEL_REPO" ls-remote origin refs/heads/main | awk '{print $1}')"
checkout_sha="$(git -C "$FLYWHEEL_REPO" rev-parse HEAD)"
deployed_sha="$(tr -d '\n' < "$HOME/.flywheel/deployed-sha")"
[ "$remote_sha" = "$checkout_sha" ] && [ "$checkout_sha" = "$deployed_sha" ]
[ "$(git -C "$FLYWHEEL_REPO" rev-list --count "$deployed_sha..$remote_sha")" -eq 0 ]
[ -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$FLYWHEEL_REPO" status --porcelain=v1)" ]
# Lead 同时在审批 thread 确认：至 §10 解冻前 main merge freeze。
install -d -m 700 "$WINDOW_ROOT" "$EVIDENCE"
for source in "$PROJECTS" "$RECEIPT" "$RAYA_ENV"; do
  [ -f "$source" ] && [ ! -L "$source" ] && [ -r "$source" ]
  cp -p "$source" "$EVIDENCE/$(basename "$source").before"
done
[ "$(stat -f %Lp "$RAYA_ENV")" = 600 ]
[ -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$HOME/.flywheel/raya/memory" status --porcelain)" ]
for residue in "$HOME/.flywheel/manifests/raya-raya.json" "$RAYA_PLIST" \
  "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" \
  "$HOME/.flywheel/state/codex-lead/raya" "$HOME/.flywheel/logs/lead-raya-raya.log" \
  "$RAYA_WORKSPACE/memory"; do [ ! -e "$residue" ] && [ ! -L "$residue" ]; done
jq -e '[.[] | select(.projectName == "raya")] | length == 0' "$PROJECTS" >/dev/null
! launchctl print "gui/$(id -u)/$RAYA_LABEL" >/dev/null 2>&1
```

- 期望：三 SHA 同一 40-hex，range=0，repo clean；备份保留 mode；Raya 的 project、workspace、
  manifest、两种 plist、state/log/label 全不存在。
- 停止 / 回滚：range 非空只做独立部署，之后从本节重跑并重生成 proposal。此节未改 registry，
  无服务回滚。

## 2. FLY-2404 共享 business truth 投影与同版 standalone

- Owner / 写入：FLY-2404 的 deployed link-truth helper；Lead/operator 按它的最终 shipped runbook
  调用。禁止 founder 为 Raya 再登录、禁止复制 `auth.json`、禁止猜测仍在设计中的 helper CLI。
- 验证命令：

```bash
# 先执行 deployed FLY-2404 runbook 中针对 ~/.codex-raya 的 exact helper command；再把该
# runbook 指定的 helper 绝对路径导出为 FLY2404_HELPER。FLY-2401 不猜它的文件名或 CLI。
[ -x "${FLY2404_HELPER:?export the exact helper path from the shipped FLY-2404 runbook}" ]
case "$FLY2404_HELPER" in "$FLYWHEEL_REPO"/*) : ;; *) false ;; esac
git -C "$FLYWHEEL_REPO" ls-files --error-unmatch "${FLY2404_HELPER#"$FLYWHEEL_REPO"/}" \
  >"$EVIDENCE/fly2404-helper.path"
[ -d "$HOME/.codex-raya" ] && [ ! -L "$HOME/.codex-raya" ]
[ "$(stat -f '%Lp %Su' "$HOME/.codex-raya")" = '700 xiaorongli' ]
[ -f "$HOME/.codex/auth.json" ] && [ ! -L "$HOME/.codex/auth.json" ]
[ "$(stat -f '%Lp %Su' "$HOME/.codex/auth.json")" = '600 xiaorongli' ]
[ -L "$HOME/.codex-raya/auth.json" ]
[ "$(readlink "$HOME/.codex-raya/auth.json")" = "$HOME/.codex/auth.json" ]
CODEX_HOME="$HOME/.codex-raya" codex login status | tee "$EVIDENCE/codex-login-status.txt"
grep -Fq 'Logged in using ChatGPT' "$EVIDENCE/codex-login-status.txt"
"$HOME/.codex-raya/packages/standalone/current/codex" -V >"$EVIDENCE/raya.version"
"$HOME/.codex-mufasa/packages/standalone/current/codex" -V >"$EVIDENCE/mufasa.version"
"$HOME/.codex-infra-bot/packages/standalone/current/codex" -V >"$EVIDENCE/infra.version"
cmp "$EVIDENCE/raya.version" "$EVIDENCE/mufasa.version"
cmp "$EVIDENCE/raya.version" "$EVIDENCE/infra.version"
```

- 期望：home 是 `700 xiaorongli` 的真实目录；canonical truth 是 `600 xiaorongli` 的普通文件；
  Raya `auth.json` 是指向它的 absolute symlink；business identity healthy；三版本一致且无 copied auth。
- 停止 / 回滚：FLY-2404 未部署，或 truth/link/mode/owner/账号/版本任一不符即停止。只用
  FLY-2404 的 shipped rollback contract 撤本次投影；本单不 logout、不删除共享 truth。

## 3. Discord bot 身份与 #raya 频道零消息探针

- Owner / 写入：Lead/operator；只读 Discord REST GET，发送消息数为 0。只提取一个 token 键，
  不 `source ~/.flywheel/.env`，不打印 token。
- 验证命令：

```bash
python3 - <<'PY' | tee "$EVIDENCE/discord-read-probe.json"
import json, pathlib, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, target): return None
opener = urllib.request.build_opener(NoRedirect())
p = pathlib.Path.home()/'.flywheel'/'.env'
values = [line.split('=',1)[1].strip() for line in p.read_text().splitlines()
          if line.startswith('RAYA_BOT_TOKEN=')]
assert len(values) == 1 and values[0]
token = values[0]
if len(token) >= 2 and token[0] == token[-1] and token[0] in "'\"": token = token[1:-1]
headers = {'Authorization': f'Bot {token}', 'User-Agent': 'flywheel-fly2401-preflight/1'}
def get(path):
    with opener.open(urllib.request.Request('https://discord.com/api/v10'+path,
                     headers=headers), timeout=10) as response: return json.load(response)
user, channel = get('/users/@me'), get('/channels/1542079099928059987')
out = {'botUserId':user.get('id'),'channelId':channel.get('id'),'channelType':channel.get('type'),
       'tokenSelectorCount':len(values),'messagesSent':0}
out['ok'] = out['botUserId']=='1542068543645024257' and out['channelId']=='1542079099928059987'
print(json.dumps(out,sort_keys=True)); assert out['ok']
PY
jq -e '.ok == true and .botUserId == "1542068543645024257" and
  .channelId == "1542079099928059987" and .channelType == 0 and
  .tokenSelectorCount == 1 and .messagesSent == 0' "$EVIDENCE/discord-read-probe.json" >/dev/null
```

- 期望：上述 jq 为真。
- 停止 / 回滚：token 键不唯一、HTTP 或 snowflake 不符即停；零写，无回滚。

## 4. Read-only renderer 与 pre-state verifier

- Owner / 写入：Lead/operator；只写 evidence，两个工具对输入零写。
- 验证命令：

```bash
python3 "$FLY2401/materials/render-production-diff.py" --home "$HOME" \
  --projects "$PROJECTS" --raya-env "$RAYA_ENV" \
  --identity-source "$HOME/.flywheel/raya/code/IDENTITY.md" \
  --identity-projection "$HOME/.flywheel/raya/identity/IDENTITY.md" \
  --project-row "$FLY2259/materials/projects.raya-row.json" \
  --plist-template "$FLYWHEEL_REPO/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" \
  --env-target "$FLY2401/materials/raya-env-target.json" | tee "$EVIDENCE/render.json"
jq -e '.productionWritesPerformed == false and .fleetIdentityImpact.currentLeadCount == 16 and
  .fleetIdentityImpact.targetLeadCount == 17 and .identityProjection.operation == "audit_only" and
  .identityProjection.mutationPlanned == false' "$EVIDENCE/render.json" >/dev/null
python3 "$FLY2401/materials/verify-activation-state.py" pre --home "$HOME" \
  --projects "$PROJECTS" --raya-env "$RAYA_ENV" --global-env "$HOME/.flywheel/.env" \
  --project-row "$FLY2259/materials/projects.raya-row.json" \
  --env-target "$FLY2401/materials/raya-env-target.json" \
  --identity-source "$HOME/.flywheel/raya/code/IDENTITY.md" \
  --identity-projection "$HOME/.flywheel/raya/identity/IDENTITY.md" \
  --wrapper-source "$FLYWHEEL_REPO/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --wrapper-installed "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --plist-template "$FLYWHEEL_REPO/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" \
  --installed-plist "$RAYA_PLIST" --manifest "$HOME/.flywheel/manifests/raya-raya.json" \
  | tee "$EVIDENCE/pre-state.json"
jq -e '.phase == "pre" and .ready == true and
  ([.checks[] | select(.status != "pass")] | length) == 0' "$EVIDENCE/pre-state.json" >/dev/null
```

- 期望：renderer rc=0/零写；FLY-2404 完成 §2 后 pre verifier rc=0/ready=true。
- 停止 / 回滚：当前若 Codex home 缺失，rc=2 是 pending 不是绿；projection drift 只作 advisory，
  不生成 copy/chmod。零 production write。

## 5. Lead 审批闸

- Owner / 写入：实现节点报告、Lead 决策；零 production write。
- 验证命令：报告必须覆盖 registry patch、env 三项、workspace、manifest/plist、Bridge+17 席 restart、
  projection audit-only 与 §14 回滚；用报告返回的 id 执行 `node "$FLYWHEEL_CLI" check "$QUESTION_ID"`。
- 期望：Lead 明确批准本版 input sha256、deployed SHA 与窗口。沉默、普通聊天、旧 SHA 批准均无效。
- 停止 / 回滚：未批准不得执行 §6 后的写操作；无回滚。

## 6. Deployed restart dry-run、N=16 census 与 write freeze

- Owner / 写入：Lead/operator；dry-run 不改服务，census 只写 evidence。dry-run 只打印 host-tmux
  gate，不能替代 §9 的独立 read-only census。
- 验证命令：

```bash
fresh_remote="$(git -C "$FLYWHEEL_REPO" ls-remote origin refs/heads/main | awk '{print $1}')"
[ "$fresh_remote" = "$(git -C "$FLYWHEEL_REPO" rev-parse HEAD)" ]
[ "$fresh_remote" = "$(tr -d '\n' < "$HOME/.flywheel/deployed-sha")" ]
bash "$FLYWHEEL_REPO/scripts/restart-services.sh" --dry-run --reason FLY-2401-activation \
  | tee "$EVIDENCE/restart.dry-run.log"
grep -Fq 'Already built at' "$EVIDENCE/restart.dry-run.log"
grep -Fq 'DRY RUN: Would restart Bridge + voice-bridge' "$EVIDENCE/restart.dry-run.log"
jq -r '.[] | .projectName as $p | .leads[] | [$p,.agentId,($p+"-"+.agentId)] | @tsv' \
  "$PROJECTS" >"$EVIDENCE/leads.before.tsv"
[ "$(wc -l < "$EVIDENCE/leads.before.tsv" | tr -d ' ')" -eq 16 ]
while IFS=$'\t' read -r project lead key; do
  out="$(launchctl print "gui/$(id -u)/com.flywheel.lead.$key")"
  pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$out")"; [ -n "$pid" ]
  identity="$(node "$FLYWHEEL_CLI" lead-identity resolve --projects-file "$PROJECTS" \
    --project "$project" --lead "$lead" --format json)"
  summary_digest="$(jq -er .summaryAssignmentDigest <<<"$identity")"
  identity_digest="$(jq -er .identityDigest <<<"$identity")"
  process_env="$(LC_ALL=C ps eww -p "$pid" -o command=)"
  tr ' ' '\n' <<<"$process_env" | grep -Fxq "FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=$summary_digest"
  tr ' ' '\n' <<<"$process_env" | grep -Fxq "FLYWHEEL_LEAD_IDENTITY_DIGEST=$identity_digest"
  printf '%s\t%s\t%s\t%s\n' "$key" "$pid" "$summary_digest" "$identity_digest"
done <"$EVIDENCE/leads.before.tsv" >"$EVIDENCE/lead-digests.before.tsv"
wc -c </tmp/flywheel-bridge.log >"$EVIDENCE/bridge-log.before-bytes"
```

- 期望：fetch target 是同一 already-at SHA，所有 preflight 绿，恰 16 个 pid/digest 匹配 resolver。
- 停止 / 回滚：Lead 此刻宣布 write freeze；若 §7–§10 不能立即连续完成，不写 registry。此节
  尚未改 registry，解除 freeze 前复核磁盘 digest 未变。

## 7. 产品 brain stop、memory move、三键 env 原子切换

- Owner / 写入：Lead/operator；写 workspace、memory 位置与 `raya.env`，重启产品 brain。0444
  identity projection 绝不写。
- 验证命令：先严格执行 FLY-2259 activation runbook §4.0.4，保存产品 brain 的 pid/lstart、两份
  product plist sha/mode/restartability，并证明 voice 未运行；再执行：

```bash
launchctl bootout "gui/$(id -u)/com.xrli.raya.brain"
! launchctl print "gui/$(id -u)/com.xrli.raya.brain" >/dev/null 2>&1
[ -z "$(/usr/sbin/lsof +D "$HOME/.flywheel/raya/memory" 2>/dev/null || true)" ]
install -d -m 700 "$RAYA_WORKSPACE" "$RAYA_WORKSPACE/state"
[ ! -e "$RAYA_WORKSPACE/memory" ] && [ ! -L "$RAYA_WORKSPACE/memory" ]
mv "$HOME/.flywheel/raya/memory" "$RAYA_WORKSPACE/memory"
python3 "$FLY2401/materials/transition-raya-env.py" apply --home "$HOME" \
  --target "$FLY2401/materials/raya-env-target.json" --env "$RAYA_ENV" --backup "$ENV_BACKUP"
python3 "$FLY2401/materials/transition-raya-env.py" verify --home "$HOME" \
  --target "$FLY2401/materials/raya-env-target.json" --before "$ENV_BACKUP" --current "$RAYA_ENV"
for product in brain voice; do
  plist="$HOME/Library/LaunchAgents/com.xrli.raya.$product.plist"
  env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin RAYA_ENV_FILE="$RAYA_ENV" \
    "$(plutil -extract ProgramArguments.0 raw "$plist")" \
    "$(plutil -extract ProgramArguments.1 raw "$plist")" preflight
done
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.xrli.raya.brain.plist"
launchctl print "gui/$(id -u)/com.xrli.raya.brain" | grep -qE '^[[:space:]]*state = running'
```

- 期望：memory 只在新路径；env mode 600 且三个 target 精确；brain 是新 pid/running；voice
  preflight 绿；projection sha/mode 不变。
- 停止 / 回滚：路径占用、backup 已存在、env drift 或产品 preflight/restart 失败即走 §14 R3→R5；
  禁止手改 env。

## 8. Registry、receipt、preflight、manifest 与正式 plist

- Owner / 写入：Lead/operator；写 canonical registry/receipt、installed bin、唯一 manifest、正式
  plist 并 bootstrap Raya job。
- 验证命令：

```bash
bash "$FLYWHEEL_REPO/scripts/flywheel-config-lock.sh" "$PROJECTS.cfglock" 5 \
  python3 "$FLY2259/materials/register-codex-lead.py" "$PROJECTS" \
  "$FLY2259/materials/projects.raya-row.json"
node "$FLYWHEEL_CLI" lead-identity resolve --projects-file "$PROJECTS" --project raya --lead raya \
  --format json | tee "$EVIDENCE/raya-identity.json"
jq -e '.role=="cos" and .botUserId=="1542068543645024257" and .model=="gpt-5.6-sol" and
  .effort=="xhigh" and .modelContextWindow==1000000 and .summaryRole=="recipient" and
  .hasSummaryDuty==false' "$EVIDENCE/raya-identity.json" >/dev/null
bash "$FLYWHEEL_REPO/scripts/migrate-summary-registry.sh" "$PROJECTS" \
  "$FLY2259/materials/assignments.json" "$RECEIPT" \
  "$(shasum -a 256 "$PROJECTS" | awk '{print $1}')"
(cd "$FLYWHEEL_REPO" && TMPDIR=/tmp pnpm exec tsx \
  packages/flywheel-comm/src/bin/summary-registry.ts verify-activation \
  --projects-file "$PROJECTS" --receipt-file "$RECEIPT") \
  | tee "$EVIDENCE/summary-registry.verify.json"
jq -e '.ok==true and .granularity=="per-lead"' "$EVIDENCE/summary-registry.verify.json" >/dev/null
RAYA_SUMMARY_FIXTURE_PR=15 RAYA_LEAD_WORKSPACE="$RAYA_WORKSPACE" \
  bash "$FLYWHEEL_REPO/packages/teamlead/scripts/raya-activation-preflight.sh" \
  | tee "$EVIDENCE/raya-activation-preflight.log"
tail -n 1 "$EVIDENCE/raya-activation-preflight.log" | \
  grep -Fxq '[raya-activation-preflight] PASS: summary latch, canonical identity, workspace, and TUI launcher'
bash "$FLYWHEEL_REPO/scripts/converge-flywheel-bin.sh" | tee "$EVIDENCE/converge.log"
before_manifests="$(find "$HOME/.flywheel/manifests" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
[ "$before_manifests" -eq 16 ]
bash "$FLYWHEEL_REPO/scripts/materialize-lead-manifests.sh" | tee "$EVIDENCE/materialize.log"
[ "$(find "$HOME/.flywheel/manifests" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')" -eq 17 ]
jq -e --arg home "$HOME" '.projectName=="raya" and .leadId=="raya" and
  .projectDir==($home+"/Dev/raya-lead-workspace") and .workspace==.projectDir and
  .leadBackend.backendId=="codex-app-server"' "$HOME/.flywheel/manifests/raya-raya.json" >/dev/null
[ ! -e "$RAYA_PLIST" ] && [ ! -L "$RAYA_PLIST" ]
[ ! -e "$HOME/Library/LaunchAgents/com.flywheel.lead.raya-raya.tui.plist" ]
cp "$FLYWHEEL_REPO/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" "$RAYA_PLIST"
plutil -lint "$RAYA_PLIST"
launchctl bootstrap "gui/$(id -u)" "$RAYA_PLIST"
python3 "$FLY2401/materials/verify-activation-state.py" active --home "$HOME" \
  --projects "$PROJECTS" --raya-env "$RAYA_ENV" --global-env "$HOME/.flywheel/.env" \
  --project-row "$FLY2259/materials/projects.raya-row.json" \
  --env-target "$FLY2401/materials/raya-env-target.json" \
  --identity-source "$HOME/.flywheel/raya/code/IDENTITY.md" \
  --identity-projection "$HOME/.flywheel/raya/identity/IDENTITY.md" \
  --wrapper-source "$FLYWHEEL_REPO/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --wrapper-installed "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" \
  --plist-template "$FLYWHEEL_REPO/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist" \
  --installed-plist "$RAYA_PLIST" --manifest "$HOME/.flywheel/manifests/raya-raya.json" \
  | tee "$EVIDENCE/active-state.json"
jq -e '.phase=="active" and .ready==true and
  ([.checks[]|select(.status!="pass")]|length)==0' "$EVIDENCE/active-state.json" >/dev/null
```

- 期望：唯一 `raya/raya`；receipt digest 与 registry 相符；activation PASS；17 manifests 且新增
  仅 Raya；五字段精确；`.tui` 残留为 0；formal label running。PR 15 只作 dry-run fixture。
- 停止 / 回滚：registry 与 receipt 连续完成且不跨班车；materializer 若非只新增 Raya 即停，
  走 §14 R1→R5。

## 9. Restart 前第二次远端锁定与独立 host-tmux census

- Owner / 写入：Lead/operator；只写 evidence。此步弥补 restart dry-run 不执行 host census。
- 验证命令：

```bash
fresh_remote="$(git -C "$FLYWHEEL_REPO" ls-remote origin refs/heads/main | awk '{print $1}')"
[ "$fresh_remote" = "$(git -C "$FLYWHEEL_REPO" rev-parse HEAD)" ]
[ "$fresh_remote" = "$(tr -d '\n' < "$HOME/.flywheel/deployed-sha")" ]
jq -r '.[] | .projectName as $p | .leads[] | ($p+"-"+.agentId)' "$PROJECTS" | while read -r key; do
  launchctl print "gui/$(id -u)/com.flywheel.lead.$key" >/dev/null
  printf '%s\t-\t-\t-\trestart\tplist\n' "$key"
done >"$EVIDENCE/loaded-candidates.tsv"
[ "$(wc -l < "$EVIDENCE/loaded-candidates.tsv" | tr -d ' ')" -eq 17 ]
bash "$FLYWHEEL_REPO/scripts/host-tmux-selection-gate.sh" census \
  "$EVIDENCE/loaded-candidates.tsv" | tee "$EVIDENCE/host-tmux-census.txt"
grep -Fq 'census pass plists=17' "$EVIDENCE/host-tmux-census.txt"
grep -Fq 'codex-raya=1' "$EVIDENCE/host-tmux-census.txt"
```

- 期望：第二次 `ls-remote` 仍等于 pinned SHA；17 个 loaded plist；census pass/codex-raya=1。
- 停止 / 回滚：远端漂移、transaction 不能立即开始或 census 失败时保持 freeze，执行 §14。

## 10. 同一获批 updater/bus transaction 与 17 席 digest 验绿

- Owner / 写入：Lead/operator + updater/bus；只通过 P3 已批准的班车 reload Bridge + restart 全
  fleet，commit range 必须为空。禁止在本节直接调用 `restart-services.sh`；班车触发命令属于 updater
  调度面，本页只验证本次新 generation。
- 验证命令：

```bash
restart_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Lead 在批准的班车工单中确认 updater 已开始本 generation；此处不单独触发 restart。
for _ in $(seq 1 180); do
  if jq -e --arg at "$restart_started_at" '
    .reason=="updater" and .recordedAt>$at and
    .leadsRestartStatus=="healthy" and .failed==0 and .total==17' \
    "$HOME/.flywheel/leads-restart-status.json" >/dev/null 2>&1; then break; fi
  sleep 10
done
health="$(curl -fsS --max-time 10 http://127.0.0.1:9876/health)"
jq -e --arg sha "$(tr -d '\n' < "$HOME/.flywheel/deployed-sha")" '
  .ok==true and .shuttingDown==false and .buildSha==$sha and .artifactBuildSha==$sha' \
  <<<"$health" >/dev/null
jq -e '.leadsRestartStatus=="healthy" and .failed==0 and .total==17' \
  "$HOME/.flywheel/leads-restart-status.json" >/dev/null
bridge_before_bytes="$(tr -d ' ' <"$EVIDENCE/bridge-log.before-bytes")"
[ "$(wc -c </tmp/flywheel-bridge.log | tr -d ' ')" -gt "$bridge_before_bytes" ]
tail -c "+$((bridge_before_bytes + 1))" /tmp/flywheel-bridge.log \
  >"$EVIDENCE/bridge-generation.log"
jq -r '.[] | .projectName as $p | .leads[] | [$p,.agentId,($p+"-"+.agentId)] | @tsv' \
  "$PROJECTS" >"$EVIDENCE/leads.after.tsv"
[ "$(wc -l < "$EVIDENCE/leads.after.tsv" | tr -d ' ')" -eq 17 ]
while IFS=$'\t' read -r project lead key; do
  out="$(launchctl print "gui/$(id -u)/com.flywheel.lead.$key")"
  pid="$(awk '/^[[:space:]]*pid = [0-9]+[[:space:]]*$/ {print $3}' <<<"$out")"; [ -n "$pid" ]
  identity="$(node "$FLYWHEEL_CLI" lead-identity resolve --projects-file "$PROJECTS" \
    --project "$project" --lead "$lead" --format json)"
  summary_digest="$(jq -er .summaryAssignmentDigest <<<"$identity")"
  identity_digest="$(jq -er .identityDigest <<<"$identity")"
  process_env="$(LC_ALL=C ps eww -p "$pid" -o command=)"
  tr ' ' '\n' <<<"$process_env" | grep -Fxq "FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST=$summary_digest"
  tr ' ' '\n' <<<"$process_env" | grep -Fxq "FLYWHEEL_LEAD_IDENTITY_DIGEST=$identity_digest"
  printf '%s\t%s\t%s\t%s\n' "$key" "$pid" "$summary_digest" "$identity_digest"
done <"$EVIDENCE/leads.after.tsv" >"$EVIDENCE/lead-digests.after.tsv"
```

- 期望：health 绑定 deployed SHA；restart status total=17/failed=0；17 席 running env 与 fresh
  resolver 精确相等，§6 old pid 不再承担写入。
- 停止 / 回滚：任一席失败继续 freeze；只凭 health 200 不解冻。执行完整 §14，旧 digest 全绿后
  才解冻。

## 11. Raya carrier、heartbeat、probe、Discord roundtrip 与 runtime 注册

- Owner / 写入：Lead/operator；founder 发一句、Raya 回一句，两条真实 Discord 消息。
- 验证命令：

```bash
raya_out="$(launchctl print "gui/$(id -u)/$RAYA_LABEL")"
grep -qE '^[[:space:]]*state = running' <<<"$raya_out"
[ "$(grep -cE '^[[:space:]]*pid = [0-9]+' <<<"$raya_out")" -eq 1 ]
tmux -L default capture-pane -p -t flywheel:raya-raya >"$EVIDENCE/raya-pane.txt"
grep -Fq 'codex' "$EVIDENCE/raya-pane.txt"
HB="$HOME/.flywheel/state/codex-lead/raya/brain/heartbeat.json"
cp -p "$HB" "$EVIDENCE/heartbeat.h1.json"; sleep 10; cp -p "$HB" "$EVIDENCE/heartbeat.h2.json"
jq -e '.state=="online" and .lastGatewayPollStatus=="ok"' "$EVIDENCE/heartbeat.h1.json" >/dev/null
jq -e '.state=="online" and .lastGatewayPollStatus=="ok"' "$EVIDENCE/heartbeat.h2.json" >/dev/null
[ "$(jq -er .updatedAt "$EVIDENCE/heartbeat.h1.json")" != \
  "$(jq -er .updatedAt "$EVIDENCE/heartbeat.h2.json")" ]
bash "$FLYWHEEL_REPO/scripts/resident-codex-lead-recover.sh" --project raya --lead raya --probe \
  | tee "$EVIDENCE/raya-probe.json"
jq -e '.state=="exact" and .label=="com.flywheel.lead.raya-raya" and
  .wrapper=="flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh" and
  .codexHome=="/Users/xiaorongli/.codex-raya"' "$EVIDENCE/raya-probe.json" >/dev/null
grep -Fq '[Bridge] RuntimeRegistry: 17 lead runtime(s) registered' "$EVIDENCE/bridge-generation.log" || \
  grep -Fq '[Bridge] Late-registered runtime for "raya" (project: raya)' "$EVIDENCE/bridge-generation.log"
! grep -Fq '[Bridge] Skipping runtime for "raya"' "$EVIDENCE/bridge-generation.log" || \
  grep -Fq '[Bridge] Late-registered runtime for "raya" (project: raya)' "$EVIDENCE/bridge-generation.log"
```

- 期望：唯一 pid、真 TUI、online heartbeat 推进、probe exact/独立 home；本代日志证明 initial
  17-seat registration 或 exact late-register。保存 founder/Raya 两条 message URL，并复核 bot/channel。
- 停止 / 回滚：只有 health 200、只有 skip、pane/heartbeat/probe 任一缺失都不能等 6h；走 §14。

## 12. 计算 next 6h slot 并等真实 delivered event

- Owner / 写入：Bridge 按 cadence 写 canonical DB；operator 只读。
- 验证命令：

```bash
ROUND_ID="$(python3 - <<'PY'
import datetime, sqlite3, time
db = sqlite3.connect('file:/Users/xiaorongli/.flywheel/teamlead.db?mode=ro', uri=True)
cadence = int(db.execute("SELECT last_effective FROM flag_values WHERE flag_name=? AND scope='*'",
                         ('summary_absorption_cadence_ms',)).fetchone()[0])
assert cadence == 21600000
next_ms = (time.time_ns() // 1_000_000 // cadence + 1) * cadence
stamp = datetime.datetime.fromtimestamp(next_ms/1000, datetime.UTC).isoformat(timespec='milliseconds')
print('summary-absorption:' + stamp.replace('+00:00','Z'))
PY
)"
printf '%s\n' "$ROUND_ID" | tee "$EVIDENCE/round-id.txt"
sqlite3 -readonly "$HOME/.flywheel/teamlead.db" ".mode json" \
  "SELECT seq,lead_id,event_id,event_type,session_key,created_at,delivered_at,
          delivery_attempts,last_delivery_error FROM lead_events
   WHERE lead_id='raya' AND event_type='summary_absorption_round' AND event_id='$ROUND_ID';" \
  | tee "$EVIDENCE/round-row.json"
jq -e --arg round "$ROUND_ID" 'length==1 and .[0].lead_id=="raya" and
  .[0].event_id==$round and .[0].session_key=="summary-absorption" and .[0].delivered_at!=null' \
  "$EVIDENCE/round-row.json" >/dev/null
```

- 期望：cadence=21600000；exact next boundary 恰一行，`delivered_at` 非空。历史
  `last_delivery_error` 非空只作 advisory，因为成功投递不会清它。
- 停止 / 回滚：零/重复/undelivered 都失败；禁止手写 DB 补证。保留 DB 取证并走 §14。

## 13. Raya 自己 merge read receipt 与首轮五面验收

- Owner / 写入：Raya 执行 read/merge/memory/report；operator 只收证据。唯一允许的写命令形状是
  `flywheel-comm summary merge --repo xrliAnnie/raya --pr "$SNAPSHOT_PR" --round "$ROUND_ID"`，且
  所有变更必须在 `summaries/`；operator 不代 merge，不运行裸 `gh pr merge`。
- 验证命令：`MERGED_PR` 和 `DISCORD_MESSAGE_URL` 必须来自本轮真实 ledger/report：

```bash
export MERGE_RECEIPTS="$RAYA_WORKSPACE/state/summary-merge-receipts.jsonl"
export MEMORY_FILE="$RAYA_WORKSPACE/memory/MEMORY.md"
MERGED_PR="$(jq -sr --arg round "$ROUND_ID" '
  [.[]|select(.type=="merge" and .roundId==$round and .repo=="xrliAnnie/raya")|.pr]|
  unique|if length>=1 then min else error("no merge receipt for round") end' "$MERGE_RECEIPTS")"
gh pr view "$MERGED_PR" --repo xrliAnnie/raya --json number,state,headRefOid \
  >"$EVIDENCE/merged-pr.json"
[ -n "${DISCORD_MESSAGE_URL:?exact Raya round report URL is required}" ]
case "$DISCORD_MESSAGE_URL" in https://discord.com/channels/*) : ;; *) false ;; esac
RAYA_BOT_TOKEN="$(python3 - <<'PY'
import pathlib
values=[line.split('=',1)[1].strip() for line in
        (pathlib.Path.home()/'.flywheel'/'.env').read_text().splitlines()
        if line.startswith('RAYA_BOT_TOKEN=')]
assert len(values)==1 and values[0]
v=values[0]
if len(v)>=2 and v[0]==v[-1] and v[0] in "'\"": v=v[1:-1]
print(v)
PY
)" python3 "$FLY2401/materials/verify-first-round.py" \
  --db "$HOME/.flywheel/teamlead.db" --round-id "$ROUND_ID" --repo xrliAnnie/raya \
  --pr "$MERGED_PR" --receipts "$MERGE_RECEIPTS" --memory "$MEMORY_FILE" \
  --pr-json "$EVIDENCE/merged-pr.json" --discord-message-url "$DISCORD_MESSAGE_URL" \
  --discord-bot-user-id 1542068543645024257 --discord-token-env RAYA_BOT_TOKEN \
  | tee "$EVIDENCE/first-round.json"
jq -e '.ok==true and .productionWritesPerformed==false and .evidenceSource=="discord_api_v10" and
  .reviewed>=1 and .absorbed>=1' "$EVIDENCE/first-round.json" >/dev/null
```

- 期望：DB/round、receipt/verified head、GitHub MERGED head、memory round+每个 summary path、
  exact Discord message 五面一致，且脚本现场 GET 后 `evidenceSource=discord_api_v10`。
- 停止 / 回滚：operator 自填 JSON、loopback override、zero absorbed、head/provenance mismatch 都失败。
  已发生的合规 merge 是 canonical 已读事实，不伪造 revert；停用新 Lead并保留取证。

## 14. 固定逆序回滚

全程保持 write freeze；每层只撤本次 before/after 集合差，防覆盖谓词沿用 FLY-2259
`activation-runbook.md §4.11`。

1. **R1 carrier**：bootout `com.flywheel.lead.raya-raya`；归档后移除本次 formal plist、Raya
   state/log、tmux window；验证 label、window、两种 plist 均不存在。
2. **R2 manifest**：只归档/移除 manifest before→after 的新增集合；期望仅 `raya-raya.json`；
   installed wrapper/helper 不删。
3. **R3 product/env/workspace**：

```bash
python3 "$FLY2401/materials/transition-raya-env.py" rollback --home "$HOME" \
  --target "$FLY2401/materials/raya-env-target.json" --env "$RAYA_ENV" --backup "$ENV_BACKUP"
[ ! -e "$HOME/.flywheel/raya/memory" ]
mv "$RAYA_WORKSPACE/memory" "$HOME/.flywheel/raya/memory"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.xrli.raya.brain.plist"
launchctl print "gui/$(id -u)/com.xrli.raya.brain" | grep -qE '^[[:space:]]*state = running'
```

4. **R4 registry/receipt**：在 config lock 下恢复 `projects.json.before` 与 receipt backup 的原 mode/
   原字节；跑 old `summary-registry verify-activation`，确认 6 projects/16 Leads/无 Raya。
5. **R5 第二次 full-fleet restart**：再证 `ls-remote==HEAD==deployed SHA`；只通过同一获批
   updater/bus 窗口的 rollback leg 启动 old generation，禁止单独调用 restart。要求 status
   `reason=updater`、`total=16,failed=0`，Bridge old generation 与逐席 env 等于 fresh old resolver，
   之后才解冻。

`~/.codex-raya` 的共享 truth 投影由 FLY-2404 rollback contract 管理；本单不 logout、不删除
canonical truth。0444 identity projection 从未写过，无回滚动作。

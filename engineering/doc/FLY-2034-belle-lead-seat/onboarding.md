# FLY-2034 Belle 完整 Lead 席位 — 接入与切换清单
Issue: FLY-2034 (https://linear.app/geoforge3d/issue/FLY-2034/belle接入-belle-完整-lead-席位自有代码仓产出归档-flywheel-派工席位定时任务-skill-化随后)
日期: 2026-08-24
基于: plan.md

## 0. 当前交付状态与权限边界

截至 2026-08-24，implement 节点已经完成、但**没有执行 live cutover**：

- private 仓已建：`https://github.com/xrliAnnie/belle-workspace`；当前 `main` =
  `726c5204afc9dca22a8989c01ad0a10b93accd69`（初始 scaffold `26ce9855…`，随后
  按 Founder 裁定把 agent matcher 改为 `personal-assistant`）。
- 仓内已有 `.claude/skills/`、顶层 `skills` 相对 symlink、`archive/weekly/`、
  `MEMORY.md`、life executor、generic menu roster/adoption 和 identity 升级稿。
- Flywheel 侧只改了版本库中的 cross-dept roster 文案与本文件/验证脚本。
- `~/Dev/personal-assistant`、`~/.flywheel/projects.json`、live identity、launcher、
  manifest、plist、Bridge 与 Belle 进程**均未改**。
- Founder 已通过 question gate `6adce1ff-7706-439b-b5db-10f10384aedc` 明确裁定
  “just use a personal-assistant label”；`personal-assistant` label 已建在 `LEARN`
  （Personal）团队，id=`eb1437bf-4599-4535-b2ac-7bbf348d71d8`。原 `life` matcher
  必须在同一次原子 cutover 中替换，不能留下 label/路由错配。

本文件由 Founder/Belle 侧在一个短维护窗执行。Implement Runner 不替她们改 live
配置、不发紧急重启票、不冒用 Belle 做真派工。验收样例由后续 DAG QA 节点在 cutover
完成后执行。

## 1. 维护窗 admission（全部满足才开始）

1. 本 Flywheel PR 已 merge，且 updater 已把包含该 merge 的版本部署到生产。
2. Founder 批准的 `personal-assistant` label 在 LEARN team 恰好可查到一条。
3. Belle 没有在飞任务；Founder 在场，可以核 identity diff、projects diff、重启回执。
4. `belle-workspace` 保持 private，remote `main` 等于上面的已验证 commit。
5. 已预留回滚时间；整个窗内不执行任何下单/付款或私人数据批量提交。

先 fail-closed 核对本清单依赖的工具；缺一个就保持当前 shell，不开始维护窗：

```bash
FLY2034_TOOLS_OK=true
for FLY2034_TOOL in git gh jq node pnpm rg shasum stat install mktemp; do
  if ! command -v "$FLY2034_TOOL" >/dev/null 2>&1; then
    printf 'missing required tool: %s\n' "$FLY2034_TOOL" >&2
    FLY2034_TOOLS_OK=false
  fi
done
test "$FLY2034_TOOLS_OK" = true
```

先验证部署前置。把 PR 实际 merge SHA 填入变量；不要用 PR head 代替 merge SHA：

```bash
FLY2034_FLYWHEEL_REPO="$HOME/Dev/flywheel"
FLY2034_MERGE_SHA="<FLY-2034-PR-MERGE-SHA>"
FLY2034_DEPLOYED_SHA="$(tr -d '[:space:]' < "$HOME/.flywheel/deployed-sha")"

git -C "$FLY2034_FLYWHEEL_REPO" merge-base --is-ancestor \
  "$FLY2034_MERGE_SHA" "$FLY2034_DEPLOYED_SHA"
git -C "$FLY2034_FLYWHEEL_REPO" show \
  "$FLY2034_DEPLOYED_SHA:packages/teamlead/lead-rules-base/cross-dept-channel-rules.md" \
  | rg -F '**Belle** | Life Assistant (life dept Lead)'
```

任一命令非零：不开维护窗。

### Linear label 只读核验

这一步只读，不创建 label，也不打印 API key：

```bash
set -a
. "$HOME/.flywheel/.env"
set +a
node --input-type=module -e '
  import { LinearClient } from "@linear/sdk";
  const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  const teams = await client.teams({ filter: { key: { eq: "LEARN" } } });
  const team = teams.nodes[0];
  if (!team) throw new Error("LEARN team missing");
  const labels = await client.issueLabels({ filter: { team: { id: { eq: team.id } } } });
  const hits = labels.nodes.filter(
    (label) => label.name.trim().toLowerCase() === "personal-assistant",
  );
  console.log(JSON.stringify({ team: team.key, matches: hits.map(({ id, name }) => ({ id, name })) }));
  if (hits.length !== 1 || hits[0]?.id !== "eb1437bf-4599-4535-b2ac-7bbf348d71d8") process.exit(4);
'
```

只能接受恰好一条大小写归一后等于 `personal-assistant`、且 id 为
`eb1437bf-4599-4535-b2ac-7bbf348d71d8` 的结果。零条、多条或 id 漂移都停下交 Lead
处理。

## 2. 先连接现有目录，不动席位配置

### 2.1 仓外备份三个冲突文件

冲突面按 root-relative path 实测恰好是 `README.md`、`CLAUDE.md`、`.gitignore`。
备份放仓外，两个目录都显式 0700：

```bash
FLY2034_PROJECT="$HOME/Dev/personal-assistant"
FLY2034_BACKUP_ROOT="$HOME/.flywheel/backups/fly2034"
FLY2034_PRE_REPO="$FLY2034_BACKUP_ROOT/pre-repo"

install -d -m 700 "$FLY2034_BACKUP_ROOT"
install -d -m 700 "$FLY2034_PRE_REPO"
cd "$FLY2034_PROJECT"

for FLY2034_FILE in README.md CLAUDE.md .gitignore; do
  shasum -a 256 "$FLY2034_FILE" >> "$FLY2034_PRE_REPO/digests.txt"
  stat -f '%Lp %Su %Sg %N' "$FLY2034_FILE" >> "$FLY2034_PRE_REPO/modes.txt"
done
chmod 600 "$FLY2034_PRE_REPO/digests.txt" "$FLY2034_PRE_REPO/modes.txt"

mv README.md "$FLY2034_PRE_REPO/README.md"
mv CLAUDE.md "$FLY2034_PRE_REPO/CLAUDE.md"
mv .gitignore "$FLY2034_PRE_REPO/gitignore"
```

不要删备份；它们也是“scaffold 完整折入旧规则”的当天证据。

### 2.2 原地连接 private remote

```bash
cd "$FLY2034_PROJECT"
git init
git remote add origin git@github.com:xrliAnnie/belle-workspace.git
git fetch origin
git checkout -b main --track origin/main

diff -u "$FLY2034_PRE_REPO/README.md" README.md
diff -u "$FLY2034_PRE_REPO/CLAUDE.md" CLAUDE.md
diff -u "$FLY2034_PRE_REPO/gitignore" .gitignore
```

三个 diff 只应显示 scaffold 在旧文件**末尾追加**内容；旧文件完整字节必须仍是新文件
前缀。若旧文件从 implement 快照后又变过，先把新变化人工折回仓版，再继续。

## 3. 存量内容逐路径落格（禁止 `git add -A`）

先只输出可疑**文件名**，不要把 secret 内容打到终端：

```bash
cd "$FLY2034_PROJECT"
find tasks -type f \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
  -o -name '.netrc' -o -name '.npmrc' -o -name 'credentials' -o -name '*.credentials.json' \) -print
rg --hidden --no-ignore-vcs -l '/Users/' \
  tasks BELLE.md memory .lead .claude/skills || true
rg --hidden --no-ignore-vcs -l \
  'BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{16}' \
  tasks BELLE.md memory .lead .claude/skills || true
git status --short --untracked-files=all
```

每个 live root-relative path 必须落入下表一格；她们侧可把 `commit` 改成更保守的
`ignore`/移出仓外，但不能留“没人决定”的路径：

| 路径 | 预填 disposition | 说明 |
|---|---|---|
| `tasks/` | commit（先做上面的凭据/机器路径扫描） | `.gitignore` 已挡嵌套 `.env` |
| `BELLE.md` | commit，需 Belle/Founder 过目 | private repo 内的 persona |
| `memory/` | commit，需 Belle/Founder 过目 | 保留既有主题文件 + 新 README |
| `.lead/belle-lead/identity.md` | commit baseline | 后续 identity change 单独一 commit |
| `.claude/skills/meal-prep/`、`.claude/skills/weee-weekly/` | commit | 现有 skills；不在本单重写 |
| `.mcp.json` | ignore | credential/runtime config |
| `scratchpad/`、`tmp/`、`belle/` | ignore | 私密素材/临时文件/退役 daemon 残留 |
| `BELLE-WRITE-TEST.txt` | ignore | runtime probe |
| `.claude/settings.local.json` | ignore | machine-local setting |
| 其余新出现路径 | 先停下分类 | 不得靠 `git add -A` 猜 |

只显式 add 已批准路径，例如：

```bash
git add tasks BELLE.md memory .lead/belle-lead/identity.md \
  .claude/skills/meal-prep .claude/skills/weee-weekly
git status --short --untracked-files=all

# 后续 gate 必须读取 Git index blob；working tree 可能已被再次编辑，不能代表 commit 内容。
fly2034_scan_staged_credentials() {
  local FLY2034_STAGED_LIST="$FLY2034_BACKUP_ROOT/staged-paths.nul"
  local FLY2034_STAGED_PATH
  local FLY2034_SCAN_RC
  local FLY2034_SECRET_HITS=""

  install -m 600 /dev/null "$FLY2034_STAGED_LIST" || return 2
  if ! git diff --cached --name-only --diff-filter=ACMR -z > "$FLY2034_STAGED_LIST"; then
    printf 'credential scan could not enumerate staged paths\n' >&2
    return 2
  fi
  while IFS= read -r -d '' FLY2034_STAGED_PATH; do
    git grep --cached -a -q -E \
      -e 'BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]|sk-[A-Za-z0-9]|AKIA[0-9A-Z]{16}' \
      -- "$FLY2034_STAGED_PATH"
    FLY2034_SCAN_RC=$?
    case "$FLY2034_SCAN_RC" in
      0)
        FLY2034_SECRET_HITS="${FLY2034_SECRET_HITS}${FLY2034_STAGED_PATH}
"
        ;;
      1) ;;
      *)
        printf 'credential scanner failed (rc=%s): %s\n' \
          "$FLY2034_SCAN_RC" "$FLY2034_STAGED_PATH" >&2
        return 2
        ;;
    esac
  done < "$FLY2034_STAGED_LIST"
  if test -n "$FLY2034_SECRET_HITS"; then
    printf 'refusing staged credential-like paths:\n%s' "$FLY2034_SECRET_HITS" >&2
    return 1
  fi
  return 0
}

if fly2034_scan_staged_credentials; then
  git diff --cached --check &&
    git commit -m 'chore: connect Belle existing workspace history' &&
    git push origin main
else
  printf 'STOP: staged credential gate did not pass; keep this shell for triage/rollback.\n' >&2
fi
```

完成判据：`git status` 中每个剩余路径都能在 disposition 表找到，且所有 ignored 路径
都可被 `git check-ignore -v <path>` 解释。

## 4. 合并 identity 派工职责（单独 commit）

远端 scaffold 带的是 proposed addendum，launcher 不读取它。必须把两处 exact replacement
合进 live `identity.md`，否则 Belle 虽有权限仍会被自身“不开 Runner”规则禁止。

```bash
cd "$FLY2034_PROJECT"
FLY2034_BASELINE_SHA="$(git rev-parse HEAD)"
cp -p .lead/belle-lead/identity.md "$FLY2034_BACKUP_ROOT/identity.md.bak"
shasum -a 256 "$FLY2034_BACKUP_ROOT/identity.md.bak" \
  > "$FLY2034_BACKUP_ROOT/identity.md.bak.sha256"
chmod 600 "$FLY2034_BACKUP_ROOT/identity.md.bak" \
  "$FLY2034_BACKUP_ROOT/identity.md.bak.sha256"

sed -n '1,220p' .lead/belle-lead/identity-dispatch-addendum.proposed.md
# 用编辑器把 addendum 的两个 exact replacement 合入 identity.md；不要改其余 persona 正文。
git diff --check -- .lead/belle-lead/identity.md
git diff -- .lead/belle-lead/identity.md
git add .lead/belle-lead/identity.md
git commit -m 'feat: let Belle delegate bounded life tasks'
FLY2034_IDENTITY_CHANGE_SHA="$(git rev-parse HEAD)"
git push origin main
```

Founder/Belle 必须看过 diff，并把 `FLY2034_BASELINE_SHA` 与
`FLY2034_IDENTITY_CHANGE_SHA` 记进维护窗记录。

## 5. 构造并验证 projects.json 候选，再原子替换

### 5.1 基线与备份

```bash
FLY2034_PROJECTS="$HOME/.flywheel/projects.json"
FLY2034_PROJECTS_BACKUP="$FLY2034_BACKUP_ROOT/projects.json.pre-fly2034.bak"
FLY2034_PROJECTS_OWNER="$(stat -f '%Su' "$FLY2034_PROJECTS")"
cp -p "$FLY2034_PROJECTS" "$FLY2034_PROJECTS_BACKUP"
chmod 600 "$FLY2034_PROJECTS_BACKUP"
shasum -a 256 "$FLY2034_PROJECTS_BACKUP" \
  > "$FLY2034_PROJECTS_BACKUP.sha256"
chmod 600 "$FLY2034_PROJECTS_BACKUP.sha256"

jq -e '[.[] | select(.projectName == "personal-assistant")] | length == 1' \
  "$FLY2034_PROJECTS"
jq -e '[.[] | select(.projectName == "personal-assistant") | .leads[] |
  select(.agentId == "belle-lead" and .companion == true and
    .canSpawnRunners == false and .match.labels == ["life"] and
    .department == "life")] |
  length == 1' "$FLY2034_PROJECTS"
```

### 5.2 同目录 0600 candidate

`mv` 只有同文件系统才原子；candidate 必须建在 `~/.flywheel/`，不能放 `/tmp`：

```bash
FLY2034_PROJECTS_CANDIDATE="$(mktemp "$HOME/.flywheel/projects.fly2034.XXXXXX")"
chmod 600 "$FLY2034_PROJECTS_CANDIDATE"

fly2034_build_projects_candidate() {
  local FLY2034_PROJECTS_NEXT="$FLY2034_PROJECTS_CANDIDATE.next"
  install -m 600 /dev/null "$FLY2034_PROJECTS_NEXT" || return 1
  if ! jq 'map(
    if .projectName == "personal-assistant" then
      .projectRepo = "xrliAnnie/belle-workspace"
      | .memoryAllowedUsers = ["annie", "belle-lead", "personal-assistant"]
      | .leads |= map(
          if .agentId == "belle-lead" then
            del(.companion)
            | .canSpawnRunners = true
            | .match.labels = ["personal-assistant"]
            | .department = "life"
          else . end
        )
    else . end
  )' "$FLY2034_PROJECTS" > "$FLY2034_PROJECTS_NEXT"; then
    rm -f "$FLY2034_PROJECTS_NEXT" "$FLY2034_PROJECTS_CANDIDATE"
    return 1
  fi
  mv "$FLY2034_PROJECTS_NEXT" "$FLY2034_PROJECTS_CANDIDATE"
}

fly2034_build_projects_candidate || {
  printf 'STOP: candidate build failed; keep this shell for triage/rollback.\n' >&2
  false
}
```

上面函数若返回非零，shell 与已有变量/备份会保留，但必须停在本节，不能继续跑 5.3。

### 5.3 三道硬门

```bash
FLY2034_VALIDATOR="$FLY2034_FLYWHEEL_REPO/packages/teamlead/dist/bin/validate-projects.js"
test -f "$FLY2034_VALIDATOR"
jq . "$FLY2034_PROJECTS_CANDIDATE" >/dev/null
node "$FLY2034_VALIDATOR" "$FLY2034_PROJECTS_CANDIDATE"

cd "$FLY2034_FLYWHEEL_REPO"
pnpm exec tsx engineering/doc/FLY-2034-belle-lead-seat/qa/verify-belle-projects-cutover.ts \
  "$FLY2034_PROJECTS" "$FLY2034_PROJECTS_CANDIDATE"

diff -u <(jq -S . "$FLY2034_PROJECTS") \
  <(jq -S . "$FLY2034_PROJECTS_CANDIDATE")
```

Delta verifier 只允许五项语义变化：`projectRepo`、`memoryAllowedUsers`、删除
`companion`、`canSpawnRunners=true`、Belle matcher 从 `life` 精确改为
`personal-assistant`；既有 `department="life"` 必须原样保留，防止 label 改名把 doc-flow
与 agent department 静默漂成 `personal-assistant`。任何其他变化都拒绝。

Founder 看完 diff 后才替换：

```bash
mv "$FLY2034_PROJECTS_CANDIDATE" "$FLY2034_PROJECTS"
test "$(stat -f '%Lp' "$FLY2034_PROJECTS")" = '600'
test "$(stat -f '%Su' "$FLY2034_PROJECTS")" = "$FLY2034_PROJECTS_OWNER"
node "$FLY2034_VALIDATOR" "$FLY2034_PROJECTS"
```

## 6. 重启前 live 终验

这一步使用 `--runtime-only`，只读版本化合同文件，不扫描私密/ignored 内容；receipt
只报告一个 `scaffoldRoot`，因为该路径此时就是已连接的 live workspace：

```bash
cd "$FLY2034_FLYWHEEL_REPO"
pnpm exec tsx engineering/doc/FLY-2034-belle-lead-seat/qa/verify-belle-workspace.ts \
  --runtime-only "$FLY2034_PROJECT"

git -C "$FLY2034_PROJECT" status --short --branch
git -C "$FLY2034_PROJECT" rev-parse HEAD
git -C "$FLY2034_PROJECT" ls-remote origin refs/heads/main
```

Verifier 会跑真实 `ConfigLoader`、`loadProjectMenuConfig`、
`resolveLeadMenus("belle-lead")` 和 `tpl_generic_menu` v2 snapshot，断言 execute 内嵌
life-executor bytes/digest；它还会在隔离副本中删 roster/删 executor 做两条负向对照。

## 7. Manifest、Belle 与 Bridge 收敛

记录翻转前证据：

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'
stat -f '%m %Sm %N' "$FLY2034_PROJECTS"
curl -fsS http://127.0.0.1:9876/health | jq '{ok, buildSha, buildMode}'
"$FLY2034_FLYWHEEL_REPO/scripts/flywheel-daemon.sh" status
```

物化命令不带 `--force`；既有 manifest 预期被保留，因为 companion/spawn 字段不属于
manifest：

```bash
"$FLY2034_FLYWHEEL_REPO/scripts/materialize-lead-manifests.sh" \
  --projects "$FLY2034_PROJECTS"
"$FLY2034_FLYWHEEL_REPO/scripts/flywheel-daemon.sh" \
  install personal-assistant-belle-lead
```

然后由 **Founder 本人**在本次明确授权的维护窗投恰好一张紧急票：

```bash
"$FLY2034_FLYWHEEL_REPO/scripts/request-restart.sh"
```

“已受理”不等于完成。不要重复投票；等待 `/tmp/flywheel-updater.log` 的本轮完成记录、
reason=updater founder 播报和 `~/.flywheel/deployed-sha` 收敛：

```bash
tail -n 200 /tmp/flywheel-updater.log
FLY2034_AFTER_DEPLOYED_SHA="$(tr -d '[:space:]' < "$HOME/.flywheel/deployed-sha")"
git -C "$FLY2034_FLYWHEEL_REPO" merge-base --is-ancestor \
  "$FLY2034_MERGE_SHA" "$FLY2034_AFTER_DEPLOYED_SHA"
curl -fsS http://127.0.0.1:9876/health | jq '{ok, buildSha, buildMode}'
"$FLY2034_FLYWHEEL_REPO/scripts/flywheel-daemon.sh" status
```

## 8. Cutover 验证

全部满足才把席位标成已接入：

1. Belle 新启动日志**没有**
   `Role: companion ... skipping engineering-governance rules + capability`。
2. `~/.flywheel/lead-rules-bundles/` 对 Belle 的 active receipt 指向 dept bundle，并实际
   含 `department-lead-rules.md`、`founder-only-authority.md`、
   `cross-dept-channel-rules.md`。
3. Bridge `/health` 正常，且新 Bridge 进程启动晚于 `projects.json` mtime。
4. Belle 在 Discord 真回话，并能接上 cutover 前语境；这是会话/记忆连续性验收。
5. `git -C ~/Dev/personal-assistant status --short --branch` 无未落格路径，local HEAD
   与 remote main 相同。
6. LEARN `personal-assistant` label 恰一条；personal-assistant 的六类 binding 可查，generic exact
   binding 指向 `tpl_generic_menu`。注意：binding 翻转前已可能存在，不能单独证明
   cutover 成功。

## 9. 后续 DAG QA：由 Belle 真派一次菜单任务

这不是 Founder 手工裸 POST 验收；必须从 Belle 席位发起：

1. 建/复用一张 LEARN issue，label=`personal-assistant`，taskCategory=`generic`，任务为“按
   meal-menu skill 生成本周菜单并归档”。
2. Belle 在自己的频道真实调用派工合同；保留 session transcript/tool call 与 Bridge
   run-start 时间的对应证据。
3. Snapshot 必须是 `tpl_generic_menu`：恰一个 executable generic node + founder gate +
   land；execute 内嵌 agent digest 等于 `life-executor`。
4. 首次 start 后、execute attempt=1 仍 admitted/running 时，从 StateStore 读取生成的
   start reservation key，QA 用相同 body/auth/key 主动重放一次；必须返回同一
   run/execution。重放是 QA 故障注入，不算 Belle 派工归属证据。
5. Runner transcript 必须显示真实加载 `/meal-menu`，而不是只生成长得像菜单的文件。
6. PR 必须包含：
   `archive/meal-menu/<date>-menu.md`、
   `archive/weekly/<YYYY-Www>.md`，以及 skill 规定的 task run log（若 task 目录存在）。
7. Founder merge 后，在 merge commit 上用 `git show <merge-sha>:<path>` 读取两个 archive
   文件，并用 `rg` 查到 weekly 行；全生命周期只允许一个 worktree、一个 PR、一套归档。

只有这组证据通过，issue 验收②才完成。

## 10. 对称回滚

任一 cutover 硬门失败就停止继续派工。由 Founder 决定执行回滚并授权第二张紧急票：

```bash
# 1. projects.json 回退并复验
shasum -a 256 -c "$FLY2034_PROJECTS_BACKUP.sha256"
cp -p "$FLY2034_PROJECTS_BACKUP" "$HOME/.flywheel/projects.fly2034.rollback"
chmod 600 "$HOME/.flywheel/projects.fly2034.rollback"
node "$FLY2034_VALIDATOR" "$HOME/.flywheel/projects.fly2034.rollback"
mv "$HOME/.flywheel/projects.fly2034.rollback" "$FLY2034_PROJECTS"
test "$(stat -f '%Lp' "$FLY2034_PROJECTS")" = '600'

# 2. identity 回退的是 identity change commit，不是 baseline commit
cd "$FLY2034_PROJECT"
git revert --no-edit "$FLY2034_IDENTITY_CHANGE_SHA"
git push origin main
git diff --exit-code "$FLY2034_BASELINE_SHA" HEAD -- \
  .lead/belle-lead/identity.md

# 3. Founder 单次明确授权后再收敛 Bridge + Belle
"$FLY2034_FLYWHEEL_REPO/scripts/request-restart.sh"
```

等待 updater 完成后，验证 Belle 恢复 companion 日志与正常回话。原地 git 化无需回滚；
Flywheel cross-dept roster 两行也不在机器上手改。若回滚成为长期状态，由 Lead 决定另开
revert PR，避免让临时描述错配永久化。

## 11. 会过期的结论

| 结论 | as-of | 重核命令/来源 |
|---|---|---|
| `belle-workspace` private main = `726c5204…` | 2026-08-24 | `gh repo view` + `git ls-remote` |
| live project 仍非 git、未接 remote | 2026-08-24 implement | `git -C ~/Dev/personal-assistant status` |
| LEARN `personal-assistant` label id=`eb1437bf-4599-4535-b2ac-7bbf348d71d8` | 2026-08-24 16:xx PT | 本文件 §1 Linear 只读核验 |
| question gate 已获 Founder 裁定：不用 `life`，改用 `personal-assistant` | 2026-08-24 | `flywheel-comm check 6adce1ff-7706-439b-b5db-10f10384aedc` |
| projects.json Belle 仍是 companion + spawn=false | 2026-08-24 implement | `jq` §5.1 基线门 |
| projects.json mode=0600 | 2026-08-24 implement | `stat -f '%Lp' ~/.flywheel/projects.json` |
| 三个 root-relative 冲突文件恰为 README/CLAUDE/.gitignore | 2026-08-24 | scaffold verifier；连接当天必须重跑 |
| generic role 无 default_agent fallback | 2026-08-24 source audit | `workflow-run-snapshot.ts` 的 `resolveMenuAgentFile` 调用点 |
| Bridge boot 前已有 binding，不能当 cutover 证据 | 2026-08-24 design review | StateStore binding 只读核对；QA 改看新 snapshot/进程时序 |
| 紧急票受理是异步，不代表部署完成 | 2026-08-24 | `scripts/request-restart.sh` + updater 日志 |

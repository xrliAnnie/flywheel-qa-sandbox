# FLY-957 record_deployed_range 收尾 grep 杀死部署 — 探索

Issue: FLY-957 (https://linear.app/geoforge3d/issue/FLY-957/infradeploy-record-deployed-range-一行-grep-杀死部署收尾-无-pr-号-commit)
日期: 2026-07-07
基于: 无

## Scope 说明(Lead 指令 a23bf30e,2026-07-07)

原 issue 含两个 bug。**Annie 决定 ②($USER 未设置崩溃)由 FLY-648 自己修进 PR #477**,不归本 issue。本设计**只覆盖 ①**:`record_deployed_range` 收尾 grep 一行修 + 单测。不碰 `provision-fleet-host.sh` / `linux-preflight.sh`。

## 问题(现象)

`scripts/restart-services.sh` 的部署收尾阶段整个死掉:

- `~/.flywheel/deployed-sha` **永不推进** —— 下次部署的 diff 范围越滚越大,而且一旦范围里出现一个"杀手 commit",之后**每次**部署收尾都会死在同一个地方(范围只会包含更多 commit,不会变少),形成永久 wedge,直到人工干预;
- `✅ Flywheel 已更新到 …` Discord 播报**永不发出**(`notify_discord` 在收尾之后,`restart-services.sh:1190`);
- `update_project_shas`(FLY-43,`restart-services.sh:1188`)同样被跳过。

2026-07-06 两次实锤复现(issue 标题);另外本机当前 `deployed-sha` = `9e73093e` 落后 origin/main(`f55d7bc8`)2 个 commit——这两个 commit 都带 PR 号,当前滞后更可能是 updater 周期未到(两个 commit 分别 merge 于 07-06 21:09 / 07-07 00:04),不作为本 bug 的直接证据,如实记录。

## 根因(已验证)

`restart-services.sh:12` 是 `set -euo pipefail`。`record_deployed_range()`(`restart-services.sh:36-60`,FLY-727 引入)在 while 循环体里做:

```bash
# restart-services.sh:46-47
issue=$(printf '%s' "$subj" | grep -oE '[A-Z]+-[0-9]+' | head -1)
pr=$(printf '%s' "$subj" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
```

杀伤链条(逐环验证过):

1. commit subject 里**没有 PR 号**(或没有 issue 号)→ `grep` 无匹配,exit 1;
2. `pipefail` 让整条 `printf | grep | head | tr` 管道的 exit status = 1;
3. 命令替换的 exit status 变成**赋值语句**的 exit status = 1;
4. while 循环是 `git log … | while …` 管道的右端,跑在**子 shell** 里,`set -e` 被继承 → 赋值失败当场杀死子 shell;
5. 子 shell 非零退出 → 整条外层管道非零 → 函数体中该语句失败 → `set -e` 杀死**整个脚本**,`return 0`(line 59)永远走不到;
6. 三个调用点(`restart-services.sh:488 / 503 / 1183`)都是裸调用,函数死 = 脚本死,死在 `echo "$CURRENT_HEAD" > "$DEPLOYED_SHA_FILE"`(line 489/504/1184)**之前** → deployed-sha 不推进、✅ 不播报。

**函数自己的注释宣称 "Fully best-effort: it NEVER affects the deploy outcome (all failures swallowed)"(line 35)——实现违反了自己的契约。**

### 触发面:为什么现在天天踩

三段式管线(FLY-871 起)让 main 上大量出现**直接 commit**(非 squash-merge、subject 无 `#N`):`chore(progress): FLY-913 implement 1/5`、`fix(FLY-913): …`、`docs(FLY-887): …` 等。抽样 origin/main 最近 40 个非 merge commit,**30+ 个没有 PR 号**,还有 1 个连 issue 号都没有(`49271b65 chore(ci): …`,会死在 line 46 的 issue grep)。也就是说现在几乎任何跨度超过一个 squash-merge 的部署范围都必踩。

### 最小复现(真机验证,bash 3.2 + 5.3 双版本)

```bash
set -euo pipefail
printf '%s\n' "aaaa chore(progress): FLY-913 implement 1/5" | \
while read -r hash subj; do
  pr=$(printf '%s' "$subj" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
  echo "never reached"
done
echo "never reached either"   # 实测:整个进程 exit 1,两行 echo 都不执行
```

## 方案

### 方案 A(推荐):`done` 后追加一个 `|| true`

```bash
git -C "$FLYWHEEL_DIR" log … | \
while read -r hash subj; do
    …
done || true
```

bash 语义(手册明文):管道处于 `||` 列表中 → 整个复合命令在 "`-e` 被忽略的上下文" 里执行,**这个忽略会传染进管道子 shell 内部** —— grep 无匹配时赋值语句返回 1 但不再杀子 shell,`pr` 拿到空串、循环**继续处理后续 commit**(line 48 的 `[[ -z … ]] && continue` 本来就为空值设计)。同时它把 `git log` 本身失败(如 old SHA 在本地不存在)等**一切**失败模式都挡在函数内,真正兑现 "NEVER affects the deploy outcome" 的契约。

- 已在 bash 3.2.57(macOS /bin/bash)和 bash 5.3.9 上真机验证:三种 commit 形态(有 issue 有 PR / 有 issue 无 PR / 全无)全部继续处理、函数 exit 0。
- 字面意义的"一行修",与 issue 框定一致。
- 弱点:依赖 bash 的 `-e` 上下文抑制语义,较隐晦 → 用**注释 + 单测钉死**(单测进 CI,未来重构破坏此语义会红)。

### 方案 B:两个 grep 命令替换各加 `|| true`

`…| head -1 || true)` ×2。杀点局部自解释,但**不**覆盖 `git log` 失败等其它失败模式,函数契约仍是破的;改动 2 行。

### 方案 C:A + B 都做

防御纵深最强,但对"一行 bug"是 3 处改动;B 的部分与 A 语义重复。

**推荐 A**:一行、结构性兑现契约、双 bash 版本验证过、由 CI 单测钉住语义。

## 测试策略(概要,细节进 plan)

新增 `scripts/__tests__/restart-deployed-range.test.sh` 并接入 `.github/workflows/ci.yml` 的 shell-test 块:

1. 用 `sed` 从 `restart-services.sh` 提取 `record_deployed_range` 函数源码,在 `set -euo pipefail` 的 bash 里 eval(不复制粘贴,避免 drift);
2. 沙箱造一个真 git repo,4 种 subject 形态各一个 commit(issue+PR / issue 无 PR / 全无 / PR 无 issue);
3. PATH shim 假 `node` 捕获 `report-deployed` 实参;
4. 断言:函数 exit 0;杀手 commit **之后**的 commit 依然被上报(继续处理);全无标记的 commit 被跳过;`git log` 失败(伪造非法 old SHA)时函数仍 exit 0。
5. 该测试在修复前必须红(复现)、修复后必须绿。

## 影响范围

- 只改 `scripts/restart-services.sh` 的 1 行 + 注释,新增 1 个测试文件 + ci.yml 1 行。
- `record_deployed_range` 是纯 telemetry(deploy-events fallback 上报),行为变化只有"不再杀死部署收尾";上报内容本身不变。

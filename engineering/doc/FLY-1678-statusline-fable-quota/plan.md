# FLY-1678 statusline 增显 Fable 限额 — 实施计划

Issue: FLY-1678 (https://linear.app/geoforge3d/issue/FLY-1678/statusline-增显-fable-模型限额-5h7d-旁加第三个用量条)
日期: 2026-08-10
基于: research.md

> 修订记录：
> - v2 — 折入 Codex design review R1 全部 7 条（1/2/3 HIGH、4/5/6 MEDIUM、7 LOW），无一项驳回。R1 抓出的真 bug 与本人实测复现见 §3.1。
> - v3 — 折入 R2 全部 5 条。其中 R2#1 我实测后**修正了它的归因**（真正的变量是 locale，不是 BSD-vs-GNU），并因此发现 v2 自己钉的 `LC_ALL=C` 是个会烤出坏 golden 的 bug —— 见 §5.1。
> - v5 — 过 R2/R3。R3 里我实测**部分推翻**了它对时间戳的归因（真 BSD `date` 能解析裸 `Z`，它看到的 `?` 其实是**我的 date shim 比 BSD 更严**——shim 保真度 bug）；真缺陷是非零时区偏移会显示错时间，已收窄 `stamp()` 到 UTC。见 §10。
> - v4 — 实现完成后过 **Codex code review R1**，折入其全部 9 条（2 HIGH + 6 MEDIUM + 1 LOW），无一驳回。四条我逐一复现确认后才动手（见 §9）。同时按实测更正了 §3.4 里一句我自己写过头的性能说法。

---

## 0. 一句话

在 statusline 第二行 `5h` / `7d` 之后追加**一条**模型级限额条，数据取自 statusline **已经在读的那份缓存**里的 `limits[]`（零新增 API 调用）；同时把这个至今无人纳管的脚本收进仓库并配幂等 installer。

## 1. 变更清单

| # | 文件 | 动作 |
|---|---|---|
| 1 | `scripts/statusline-command.sh` | **新增** — 逐字节收编 `~/.claude/statusline-command.sh` 现状（基线提交，零改动，独立 commit） |
| 2 | `scripts/statusline-command.sh` | **改** — 追加模型级限额渲染（第二个 commit） |
| 3 | `scripts/install-statusline.sh` | **新增** — 校验先于写入 + 自动回滚的 installer |
| 4 | `scripts/__tests__/fixtures/fly1678/` | **新增** — cache 快照 fixture + golden + 确定性 `date`/`stat`/`tr`/`curl`/`security` shim |
| 5 | `scripts/__tests__/fly1678-statusline-fable.test.sh` | **新增** — 渲染 + 零回归 + 边界 |
| 6 | `scripts/__tests__/fly1678-install-statusline.test.sh` | **新增** — installer 契约 |
| 7 | `.github/workflows/ci.yml` | **改** — 两个测试接进 `script-tests` job |

TS / packages **零改动**（research §2 已证 `limits[]` 在两条写入路径上都完整存活）。`~/.claude/settings.json` **零改动**（research §5.1）。

基线导入与功能改动**分两个 commit**，让「逐字节相同」这件事在 git 历史里可独立审计（Codex R1 建议）。git 里保留可执行位。

## 2. 第 1 步:先建立可信基线

先把 `~/.claude/statusline-command.sh` **一字不改**提交进 `scripts/statusline-command.sh`，提交前用 `cmp` 证明与线上逐字节相同。

这是后面所有「零回归」断言的锚；也保住了原始版本——万一 installer 的 `.bak` 被二次运行覆盖，git 历史里永远有那一份。

验收：`cmp -s scripts/statusline-command.sh ~/.claude/statusline-command.sh` 退出 0。

## 3. 第 2 步:脚本改动(唯一的功能改动)

### 3.1 读取 — 边界校验与消毒全部在 jq 里做完

**这一节是 R1 最重的一条，起因是一个我自己漏掉、Codex 抓出、我复现确认的真 bug。**

v1 计划只在 shell 里用 `case` 挡非数字。实测（生产同款 bash 3.2.57）：

```
$ /bin/bash -c 's=09.5; i=${s%.*}; case "$i" in ""|*[!0-9]*) echo REJECTED;; *) echo "PASSED as: $i";; esac'
PASSED as: 09
$ /bin/bash -c 'pct=09; echo $(( pct * 10 / 100 ))'
/bin/bash: 09: value too great for base (error token is "09")
```

即：API 若把 `percent` 给成字符串 `"09.5"`，我的守卫会放行 `09`，随后 `make_bar` 的算术把它当**八进制**直接报错——statusline 当场崩。这类问题必须在进入 shell 算术之前就消灭。

因此把类型/范围/消毒**全部下沉到 jq**，shell 只接受已经规范化的小整数：

```bash
# NOTE: `label` 是 jq 保留字(label/break),def 必须叫别的名字 —— 实测踩过。
scoped=$(jq -r '
  def mname: (.scope.model.display_name | gsub("[[:cntrl:]]";" ")
              | sub("^ +";"") | sub(" +$";"") | .[0:16]);
  (if (.limits|type)=="array" then .limits else [] end)
  | map(select(type=="object"))
  | map(select((.scope|type)=="object" and (.scope.model|type)=="object"))
  | map(select((.scope.model.display_name|type)=="string"))
  | map(select((mname|length) > 0))
  | map(select((.percent|type)=="number" and .percent>=0 and .percent<=100))
  | map([ mname,
          (.percent|floor|. + 0|tostring),
          (if (.resets_at|type)=="string"
             and (.resets_at|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
           then .resets_at else "" end) ])
  | .[0:1][] | @tsv' "$CACHE" 2>/dev/null)
```

逐条对应 R1 的要求：

| 要求 | 实现 |
|---|---|
| `limits` 非数组不可用 | `if (.limits\|type)=="array" ... else []` |
| 跳过非对象成员且不泄漏 jq 诊断 | `map(select(type=="object"))` + `2>/dev/null` |
| `display_name` 必须非空字符串 | 类型检查 + **消毒后**再查 `length>0`（消毒后全空白也拒） |
| `percent` 必须是 0–100 的 JSON 数字，jq 内 `floor`，**拒绝**数字样字符串 | `type=="number"` + 范围 + `floor\|. + 0\|tostring`（不产生前导零，八进制隐患从源头消失；`. + 0` 见下方带符号零） |
| **带符号零归一**（R2#4） | JSON 合法的 `-0` / `-0.0` 通过范围检查后，`floor\|tostring` 实测产出 `"-0"`，随后被 shell 数字守卫静默丢弃 → 条子无声消失。加 `. + 0` 后实测产出 `"0"`，契约才真正成立 |
| `resets_at` 仅接受字符串或 null，null 归一为空 | 类型检查 + ISO 前缀正则，其余一律 `""` |
| 消毒 C0/C1 控制字符并限长 | `gsub("[[:cntrl:]]";" ")` + trim + `.[0:16]` |
| 用带转义的分帧格式，不用裸插值 | `@tsv`（且已先消毒，实际无需转义） |

### 3.1.1 边界矩阵 — 16 例已真跑,不是推演

在真 jq 上逐例执行（探针脚本见实施时的测试 fixture）：

| 输入 | 输出 | rc |
|---|---|---|
| **真实 live cache** | `Fable⇥4⇥2026-08-14T05:59:59...` | 0 |
| `display_name: ""` / `"   "` | 空 | 0 |
| 空名在前、好名在后 | `Fable⇥77⇥...`（拿到**第一个合法**的，不是第一个原始的） | 0 |
| `"  Fable  "` | `Fable`（已 trim） | 0 |
| 35 字符长名 | `SuperLongModelNa`（截 16） | 0 |
| `percent: "09.5"`（字符串） | 空 ✅ **原 bug 已封死** | 0 |
| `percent: -5` / `150` | 空 | 0 |
| `percent: 9e1` | `C⇥90⇥`（指数形正确归一为 90） | 0 |
| `limits` 是对象 | 空 | 0 |
| `limits` 含标量成员 `[3,"x",null,{good}]` | `OK⇥42⇥...`（跳过标量，好的存活） | 0 |
| `limits` 缺失 | 空 | 0 |
| 两条 model-scoped | 只出第一条 | 0 |
| 仅 surface-scoped | 空 | 0 |
| `resets_at: "garbage"` | `Fable⇥90⇥`（空 → `fmt_reset` 出 `?`） | 0 |
| 整个文件不是 JSON | 空（stderr 已抑制） | 5 |
| `percent: -0` / `-0.0`（v3 新增） | 加 `. + 0` 前实测出 `-0` → 被 shell 丢弃；加之后出 `0`，正常渲染空条 | 0 |
| 名字含真 TAB/换行/ESC + `%s` | `Fa b le [2J%s-ta`——单行、无 `^I`/`^[`、限长 16 | 0 |

最后一例用 `cat -v` 验过：**控制字节确实没有落到终端**，TSV 分帧未被破坏。

### 3.2 渲染(插在 7d 段之后、那句 `echo ""` 之前)

```bash
  if [ -n "$scoped" ]; then
    while IFS=$'\t' read -r s_name s_pct s_reset; do
      [ -n "$s_name" ] || continue
      case "$s_pct" in ''|*[!0-9]*) continue ;; esac
      s_pcti=$((10#$s_pct))          # 强制十进制 —— 八进制的第二道防线

      printf '%b  |  %b' "$GRAY" "$RST"
      printf '%b%s %b' "$DIM" "$s_name" "$RST"
      pick_color "$s_pcti"
      make_bar "$s_pcti"
      printf ' %d%%%b' "$s_pcti" "$RST"
      printf '%b reset %s%b' "$GRAY" "$(fmt_reset "$s_reset")" "$RST"
    done <<< "$scoped"
  fi
```

- **常量格式串**：新增的 `printf` 全部用固定格式 + `%s`/`%b` 参数（R1 建议）。API 来的文本永远是**参数**不是格式串，`%` 与反斜杠一律惰性。
- **`$((10#$s_pct))`**：即便 jq 那层将来被绕过，也不会再有八进制解释。纵深防御，不替代 jq 的规范化。
- **`[[:cntrl:]]` 已在 jq 消毒**，此处不再重复。
- 整块仍在现有 `if [ -n "$u5" ] && [ -n "$u7" ]` 之内：拿不到 5h/7d 时第二行本来就不渲染；`limits[]` 缺失时 `$scoped` 为空而 5h/7d **照常** —— 这是零回归的关键路径。
- `<<<` here-string 在 bash 3.2 可用，且循环体**不在管道子 shell** 里（R1 已核）；循环后也不消费任何状态。

### 3.3 只渲染一条 — 有界,且是显式产品决定

v1 计划里的「遍历所有 model-scoped 条目」是我悄悄扩大了产品范围：founder 要的是**第三个**条，一条。若将来 API 返回多条模型限额，无界循环会把行撑爆，比已知的 116 字符问题严重得多。

**定案：最多渲染一条，取 `limits[]` 里第一个通过全部校验的 model-scoped 条目**（jq 的 `.[0:1]`）。今天本机就是 Fable。

选「API 顺序里第一个」而不是「百分比最高」，是因为后者是产品判断，不该由我单方面替 founder 做。若将来真出现多条模型限额，这需要 founder 拍板（多条怎么排、要不要换行），届时单独立单——**不留一个会自己长出来的行为**。

### 3.4 预期真机效果(按抓取当刻的真数据)

```
5h ▓▓▓▓▓▓▓▓▓░ 96% reset today 14:30  |  7d ▓▓▓▓▓▓▓░░░ 75% reset tmrw 00:00  |  Fable ▓▓▓▓▓▓▓▓▓░ 90% reset tmrw 00:00
```

**两点如实说明**：

1. 该行从 ~74 字符涨到 ~116 字符，窄终端会折行。founder 明确要求「旁加」（同一行），我按她说的做，把事实写在这里供她随时改主意，不擅自改成第三行。
2. 上面这行是 12:53 抓取时刻的形态。**审查期间同一条 Fable 限额已从 90% 变成 4%**（7d 窗重置，`resets_at` 也移到了 08-14）——用量数据本就在动。所以任何 fixture 都是**带日期的快照**，不是「当前实时数据」，断言里绝不写死 90（见 §6）。

### 3.5 明确不碰的东西

- `refresh_cache` 的 `LOCK="/tmp/claude-usage-refresh.lock"` 硬编码在 `/tmp`（不跟随 `$HOME`）。既有实现，与本单无关，**不改**。测试侧靠确定性 shim + 打桩规避，并**断言该 lock 未被创建或修改**。
- 生产脚本的 BSD-only 命令（`stat -f`、`date -juf/-v/-jf`）**本单不改**（R1 明确要求不要在这单里动）。跨平台由测试 shim 承担。
- Line 1 一字不动。
- 顶层 `seven_day_opus` / `nimbus_quill` 等代号字段一律不读（research §1.2）。

## 4. 第 3 步:installer — 校验先于写入,失败自动回滚

`scripts/install-statusline.sh`。R1 的第 3、4 条把 v1 那版的两个真问题点出来了：原子 rename 只防「写了一半」，不防「原子地装了个坏文件」；而 v1 的落地回读失败只是 `exit 1`，那时坏文件**已经在线上了**。全机每个 pane 都在渲染这个文件，一个语法错误就是全灭。

流程（任一步失败 → 全局零改动或已回滚）：

1. **worktree/temp 拒绝**：`source scripts/lib/path-hygiene.sh`；`is_temp_or_worktree_root "$REPO_ROOT"` 为真 → exit 1，**在任何全局写入之前**。（我此刻就跑在 worktree，这条对我自己生效。）
2. **源存在性** → 缺失 exit 1。
3. **语法闸**：`/bin/bash -n "$SOURCE"` —— 不过就 exit 1，**零全局改动**。
4. **冒烟渲染**：在临时假 `HOME` 里用固定 fixture cache + 固定 stdin 跑一遍源脚本，要求 exit 0 且输出恰好两行。语法对但运行时炸的情况也挡在门外。
5. **settings 只读硬闸**：先 `jq empty` 校验 `~/.claude/settings.json`，再要求 `.statusLine.type == "command"`，且 `.statusLine.command` **精确等于**下列受支持形式之一（不做子串匹配——子串会放行「只是提到路径却并不执行它」的命令）：
   - `bash <TARGET>`
   - `/bin/bash <TARGET>`
   - `<TARGET>`

   不匹配 → 打印**安全引用**后的实际值并 exit 1，且不动 target / .bak / settings / 临时文件。此处**只读校验，绝不擅自改写全局 settings**。
6. **幂等短路**：`cmp -s` 源与目标内容相同 → 若权限已是 0755 则打印 `already current` exit 0、**不动 `.bak`**；若权限不对则**只修权限**（同样不动 `.bak`），因为 §1 承诺了 0755。内容相同却留着 0644 不算收敛。
7. **暂存 → 校验**：同目录 `mktemp` → `cp` → `chmod 0755` → 对**暂存文件**也跑一次 `/bin/bash -n`（字节本应与源相同，但要证明而不是假定）→ 对暂存文件再冒烟渲染一次。
8. **建回滚点**：暂存件全部验过之后、rename **之前**，才原子写 `${TARGET}.bak`。
9. **rename**：`mv` 暂存件到目标。
10. **落地回读 + 冒烟**：`cmp` 目标与源、再冒烟渲染一次。**任一失败 → 原子恢复 `.bak` 并校验恢复结果**；恢复也失败则打印手工恢复命令并 exit 1。全新安装（无 `.bak`）路径的失败行为：删除刚落地的目标，回到「无该文件」的原状。
11. **`trap` 清理**：所有退出路径删除临时文件。

**关于 `.bak` 的承诺,说准不说大（R2#5）**：v2 把备份排在暂存校验**之前**，于是「任一失败都零全局改动」这句话对 `.bak` 并不成立——一次失败的尝试会白白推进备份。v3 把顺序改成**先暂存校验、后建回滚点**（步骤 7→8），所以：

- 语法/冒烟/settings/worktree 任一闸拦下 → **全局零改动**，`.bak` 也一动不动。
- 只有在暂存件已全部验过之后才建回滚点，紧接着就 rename——两者之间没有会失败的步骤。
- rename 之后若回读/冒烟失败 → 自动恢复 `.bak` 并校验恢复结果。

**承诺的准确边界（R3 建议 2）**：`.bak` 一旦写下，就进入了**提交阶段**；此后连 `mv` 本身都可能失败，那时线上目标仍是安全的旧版，但 `.bak` 已经推进了一格。所以准确的说法是——**「零全局改动」这条保证止于「已验证的安装进入备份/rename 提交阶段」那一刻**；进入之后，保证降级为更重要的那一条：**绝不让坏文件留在线上**。为了让这句话不是空话，另加一个注入 `mv` 失败的用例（见 §5.3）。

**冒烟环境**：装前与装后两次冒烟都使用**完整的确定性 shim 集**（`date` / `stat` / `tr` / `curl` / `security`）+ 假 `HOME`，所以「hermetic」同时意味着不碰钥匙串、不碰网络。

回滚（人工）：`mv ~/.claude/statusline-command.sh.bak ~/.claude/statusline-command.sh`，下一帧生效，无需重启任何服务。

## 5. 第 4 步:测试

### 5.1 跨平台确定性 — R1 第 2 条,这是测试能否真跑的前提

v1 说「touch 缓存就 hermetic」是**错的**。生产脚本无条件调用 BSD-only 的 `stat -f %m`（GNU `stat -f` 是"文件系统信息"，输出多行 → 命令替换塞进 `$(( ))` 直接算术语法错）和 BSD-only 的 `date -juf` / `date -v+1d` / `date -jf`。所以按 v1 的写法，这些测试在 Ubuntu 的 `script-tests` job 上**根本跑不成**。

修法：`PATH` 前置一个 shim 目录，除 `curl` / `security` 外，再加**确定性的 `date`、`stat` 与 `tr`**，并钉死 `TZ=UTC`、`LC_ALL=C`（见 §5.1.1 —— 有了 `tr` shim 之后它重新安全且更可取）、以及假 `now`（`FLY1678_FAKE_NOW` epoch）。

需要模拟的调用面是封闭的（已从脚本逐行枚举）：**8 种 `date`/`stat` 形式**，外加 §5.1.1 的 **2 种 `tr` 形式**；`curl` 与 `security` 不是要模拟的语义，而是「一旦被调用就算失败」的标记桩。8 种如下：

| 调用 | shim 语义 |
|---|---|
| `date +%s` | 输出 `FLY1678_FAKE_NOW` |
| `date +%Y-%m-%d` | 假 now 的日期 |
| `date -v+1d +%Y-%m-%d` | 假 now +86400 的日期 |
| `date -juf "%Y-%m-%dT%H:%M:%S" <s> +%s` | 把 ISO 当 UTC 解析成 epoch |
| `date -jf "%s" <e> +%Y-%m-%d` / `+%H:%M` / `+%a` | 从 epoch 格式化 |
| `stat -f %m <file>` | 返回受控 mtime |

底层用 `date -u -d @N`（GNU）或 `date -u -r N`（BSD）实现，启动时探测一次。

这不只是为了让 CI 跑得起来——钉死时间同时消灭了 golden 漂移：真实时钟推进会让 reset 标签从 `tmrw` 变成某个 weekday，golden 就会莫名其妙红。

`TZ=UTC` 意味着测试里的时间标签与 Annie 在 PT 下看到的不同。这是刻意的：测试断言的是**契约**（`today`/`tmrw`/weekday 三分支与格式），不是她的墙钟。

### 5.1.1 `tr` 也必须 shim —— 而且真正的变量是 locale,不是 BSD-vs-GNU

R2#1 指出 `make_bar()` 里还有两个平台相关调用（`tr ' ' '▓'` / `tr ' ' '░'`），v2 把调用面说成「date + stat 就封闭了」是错的。**结论我接受，但归因我实测后要更正**——这直接决定 shim 怎么写。

R2 的说法是「生产 Mac 的 BSD `tr` 输出完整三字节字形，GNU `tr` 不行」。我在生产机上实跑，真正的分界是 **locale**：

| 条件 | 每格字节 | 整行 UTF-8 有效? |
|---|---|---|
| BSD `/usr/bin/tr`，`LC_ALL=C` | 裸 `e2`（1 字节） | ❌ 否 |
| BSD `/usr/bin/tr`，`LC_ALL=en_US.UTF-8` | `e2 96 93` / `e2 96 91`（完整） | ✅ 是 |
| GNU `tr` 9.11，`LC_ALL=C` | 裸 `e2` | ❌ |
| GNU `tr` 9.11，`LC_ALL=en_US.UTF-8` | 裸 `e2`（**locale 救不了 GNU**） | ❌ |

取证方式不是拿 `tr` 单独试，而是**在沙箱里跑真 statusline 脚本**（假 HOME + 真 cache 副本 + curl/security 打桩，marker 证实零网络零钥匙串），再对 stdout 数字节：

- `LC_ALL=C`：268 字节，30 个裸 `e2`，完整 `e2 96 93` 计数 **0**，Python 解 UTF-8 **失败**。
- `LC_ALL=en_US.UTF-8`：328 字节，完整 `e2 96 93` × 5、`e2 96 91` × 25，解 UTF-8 **成功**。

两条推论：

1. **v2 自己钉的 `LC_ALL=C` 是个 bug。** 照 v2 写，golden 会用 1 字节坏条烤出来——那既不是 Annie 屏幕上的字节，测试还会自信地绿。这是「空过绿测」的典型形态，幸亏 R2 逼我去查这一片。
2. GNU `tr` 在任何 locale 下都做不出多字节字形（coreutils `tr` 是面向字节的，已知限制），所以**光靠 locale 无法让 CI 与 Mac 字节一致**——R2 要求 shim `tr` 的结论成立。

因此 shim 里加一个**与 locale 无关**的 `tr`：只支持上述两种确切调用形式，对每个输入空格吐出**一个完整字形**，其余任何调用形式 fail-closed 报错退出。这样 Mac 与 Linux 产出同一串字节，且这串字节正是 Annie 在 UTF-8 终端下看到的那串。生产 `make_bar()` **不动**（动它会改变现有 5h/7d 与 ctx 条的基线）。

**locale 怎么钉（R3 建议 1，采纳）**：`LC_ALL=C` 之所以有害，只发生在「真·locale 敏感的 BSD `tr` 还在测试路径上」的那一刻。一旦 shim 把两处 bar 调用都截走，`LC_ALL=C` 就重新安全，而且是**更可取**的——否则 `date` 的 `%a` 会继承宿主的本地化星期名，让号称确定性的 golden 变成依赖宿主。所以：harness 钉 `LC_ALL=C`，并在 `date` shim 内部再显式钉 `LC_TIME=C`，双保险。

追加断言：每条 10 格条必须是**合法 UTF-8**、且字节序列恰为期望的 `▓`/`░` 组合——Mac 与 Linux 两侧都断。

**如实标注一个既有性质（本单不改）**：生产渲染是否正确本就依赖 pane 的 locale 是 UTF-8。founder 截图里条是好的，说明她的 pane 确实跑在 UTF-8 下。我新增的第三条复用同一个 `make_bar`，**不引入新风险**，但也不假装修好了这件事。

**CI 的 bash 不能证明 bash 3.2 兼容性**（本机实测：`/bin/bash` 是 3.2.57，PATH 上的 `bash` 是 5.3.9）。所以 §7 的发布闸里，生产 Mac 上的 `/bin/bash -n` + 至少一次 `/bin/bash` 完整渲染是**必跑项**。

### 5.2 `fly1678-statusline-fable.test.sh`

统一夹具：临时 `HOME`（含假 `.claude/usage-api-cache.json`、`.claude.json`、`.claude/settings.json`）、固定 stdin session JSON、上述确定性 shim、缓存 mtime 设为「新鲜」以走不刷新分支。

| 用例 | 断言 |
|---|---|
| A 快照 fixture（真缓存副本，含一条 model-scoped） | 第三段出现，标签/百分比/reset 标签与**从该 fixture 现算的期望值**一致 |
| B **零回归** | Line 1 与 golden 逐字节相同；Line 2 以 golden 前缀**逐字节开头**，其后紧跟新分隔符（§6 定义） |
| C–Q | §3.1.1 那 16 个边界逐条成为用例（含 `"09.5"`、`-0`/`-0.0`、TAB/NL/ESC、`%s`、非数组 limits、标量成员、两条取一、surface-only、坏 `resets_at`、坏 JSON） |
| 无网络 | curl / security marker 均不存在；`/tmp/claude-usage-refresh.lock` 未被创建或修改。marker 检查前短暂轮询，避免与后台 spawn 竞态 |

#### 5.2.1 畸形输入的**两套**契约(R2#2 —— v2 写了个不可能成立的统一不变量)

v2 要求「每个畸形用例都 exit 0、恰好两行、5h/7d 字节完好」，并把「整个文件不是 JSON」也塞进同一批。这自相矛盾：5h/7d 本身就是从**同一个文件**的四次 jq 读取来的，文件整体无效时它们也为空，现有的 Line 2 守卫为假，**基线行为本来就只有 Line 1**。要求新代码变出 5h/7d，等于要求它凭空捏造数据。拆成两套：

- **契约 A — cache JSON 有效、只是 `limits` 缺失/畸形**：exit 0、**恰好两行**、5h/7d 段**逐字节**不变。
- **契约 B — cache JSON 整体无效**：exit 0、输出与**基线脚本吃同一份无效输入**的结果**逐字节相同**（当下即「只有 Line 1」），且无 stderr 泄漏、无后台刷新。

契约 B 才是真正的零回归判据——拿基线当尺子，而不是把一个基线从未有过的行为强加上去。

#### 5.2.2 「无控制字节」的正确断法(R2#3 —— v2 那条断言必然失败)

v2 写「stdout 无控制字节残留（`cat -v` 断言）」是错的：statusline 的每一行**本来就**满是 ESC 颜色序列，`cat -v` 必然打出一堆 `^[`；而且 UTF-8 字形的续字节落在 C1 的数值区间，裸扫 C1 会大量误报。改成白名单式、按码位判断：

1. 只允许脚本实际会发的那几种 ANSI 序列（`\033[0m` / `[2m` / `[32m` / `[33m` / `[35m` / `[36m` / `[90m` / `[91m`）。
2. 把这些已知序列**剥掉**，剩余部分按 UTF-8 解码，再拒绝除换行以外的任何 C0/C1 **码位**。
3. 敌意名字那一例另加针对性断言：TAB 不在、注入的额外换行不在、注入的 `ESC[2J` 不在、`%s` 以**字面**出现。

§3.1.1 那张 jq 矩阵仍可用 `cat -v` 证明 TSV 行本身无控制字符——那是**单独一行纯文本**，和检查整条带色 statusline 是两回事。

### 5.3 `fly1678-install-statusline.test.sh`

positive 用例不能直接从本 checkout 跑（它自己就是 worktree）。照 `scripts/__tests__/install-hooks-fly1389.test.sh` 的做法：构造一个最小可信 fixture checkout（真 `.git` **目录**、非 temp 的规范路径），另造 worktree fixture 与 temp fixture 作反例。所有目标 `HOME` 全是假的。

| 用例 | 断言 |
|---|---|
| worktree 源 / temp 源 | exit≠0，全局目标未被创建或修改 |
| 源语法错误 | exit≠0，**全局零写入**（target/.bak 均未动） |
| settings.json 无效 JSON / `type` 非 command / command 不等于受支持形式 | exit≠0，打印实际值，零写入 |
| 干净安装 | 目标内容 == 源，权限 0755 |
| 已有旧版 | `.bak` == 安装前那一版 |
| 重跑（内容相同、权限正确） | exit 0、`already current`、target 与 `.bak` 的 mtime 均不变 |
| 内容相同但权限 0644 | 权限被修成 0755，`.bak` 未被创建/改动 |
| **注入 rename 后校验失败** | 自动恢复 `.bak`，且恢复结果被校验；exit≠0 |
| 全新安装 + 注入校验失败 | 目标被移除，回到原状 |
| 临时文件残留 | 所有路径结束后 fixture 目录无 `*.XXXXXX` 残留 |
| **失败尝试不得推进 `.bak`** | 语法闸/冒烟闸/settings 闸拦下时，已存在的 `.bak` 内容与 mtime 均不变（R2#5 的顺序修正的直接验证） |
| **注入 `mv` 本身失败**（R3#2） | 线上目标仍是旧版且完好可渲染；exit≠0；日志明说 `.bak` 已推进 —— 证明「保证止于提交阶段」这句话是真的，不是托词 |

### 5.4 CI

两个测试接进 `.github/workflows/ci.yml` 的 `script-tests` job（新增一个带注释的 step）。**不接就等于没跑。**

## 6. 证据纪律 — 说得准,不说大

- **fixture 是带日期的快照**，文件名与文件头都写明抓取时刻，绝不称其为「当前实时数据」。
- **live-cache 证据的取法**：先把 live cache **复制**进隔离 `HOME`，期望值从**这份副本**现算，再拿脚本渲染这份副本。绝不在 live 证据里写死 90——审查期间它已经变成 4 了；也避免观察与渲染之间被后台刷新改掉。
- **逐字节比较的精确定义**：存两个 golden——完整的 Line 1，以及**不含结尾换行**的 Line 2 前缀。断言 Line 1 全等；断言新 Line 2 **以该前缀开头，且紧随其后的是新分隔符** `\033[90m  |  \033[0m`。这既避免松散的子串匹配，又允许有意新增的后缀。
- golden 由**改动前**的基线脚本（第 1 步）在同一套确定性 shim 下生成并提交。

## 7. 发布闸(与影响半径匹配)与验收边界

**PR 阶段必跑并附结果：**

1. 生产 Mac 上 `/bin/bash -n scripts/statusline-command.sh scripts/install-statusline.sh`。
2. 渲染套件：Mac 上用 `/bin/bash`（3.2）跑一遍 + CI 上在确定性 shim 下跑一遍。
3. installer 套件（fixture checkout，假 HOME）。
4. 两个新/改脚本的 ShellCheck；既有基线告警**如实记录**，不静默扩大。
5. 条形字节断言：Mac 与 Linux 两侧各断一次「10 格条是合法 UTF-8 且字节序列精确」。
6. `pnpm lint` + `pnpm -r build` 绿。
7. 真 live cache 副本的渲染证据（按 §6 取法）。

**PR 阶段给不了的：** 一张「活 Lead pane 里第三个条已在」的截图——那需要先把文件装进 `~/.claude/`，即部署。FLY-1389 铁律禁止从 worktree 安装全局配置，而本节点合同禁止请求 ship/merge。此事已非阻塞抛给 Tadashi（exploration §3.2）。**无论他怎么定，第 1–5 步完全不变**，差别只在最后 `bash scripts/install-statusline.sh` 谁跑、何时跑。

**授权部署之后**（不在本节点）：立即做活 pane 目视验证，并保留 `.bak` 直到验证通过；回滚命令已在 §4 末尾，且经测试覆盖。

我不会把「harness 渲染输出」说成「真机截图」——那是两件事。

## 8. 风险

| 风险 | 处置 |
|---|---|
| 坏脚本装上线 → 全机 statusline 全灭 | installer 三道闸：装前 `bash -n` + 冒烟；暂存件再验；落地后回读+冒烟失败**自动回滚**并校验恢复 |
| bash 3.2 八进制/算术炸 | jq 侧 `floor\|tostring` 从源头产出干净十进制 + shell 侧 `10#` 纵深防御；已用生产同款 3.2.57 复现原 bug 并验证修复 |
| API 文本注入控制字节污染终端 | jq `[[:cntrl:]]` 消毒 + 限长 16 + 常量格式串；已用真 TAB/NL/ESC 字节 + `cat -v` 验过 |
| API 未来改 `limits[]` 形状 | 全链类型校验，取不到就**静默不渲染第三段**，5h/7d 不受影响（16 例边界已验） |
| 多条模型限额把行撑爆 | 硬性只渲染一条；多条场景显式留给 founder 拍板，不留会自己长大的行为 |
| 测试在 Linux 上假绿/漂移 | 确定性 `date`/`stat`/**`tr`** shim + 钉死 epoch/TZ；Mac 上 bash 3.2 实跑作为**独立必跑闸** |
| **golden 用坏字节烤出来（v2 的 `LC_ALL=C` bug）** | 已实测定位为 locale 而非 BSD/GNU；`tr` 改为 locale 无关 shim，并断言每条 10 格条是合法 UTF-8 且字节序列精确（§5.1.1） |
| `percent: -0` 让条子无声消失 | jq 侧 `floor \| . + 0 \| tostring` 归一，`-0`/`-0.0` 进边界矩阵（§3.1.1） |
| 测试误触发后台 curl 烧真 token 预算 | shim + 打桩 + 显式断言零调用 + 断言 `/tmp` 那个 lock 未被触碰 |
| installer 二次运行覆盖 `.bak` | 第 1 步已把原始版本逐字节存进 git；且内容相同时短路不动 `.bak` |
| 装了但 Claude Code 不读这个文件 | settings 精确形式匹配的 fail-closed 硬闸，不匹配就拒装并报出实际值 |


---

## 9. 实施后:Codex code review R1 的实测与处置

计划批准 ≠ 实现正确。实现完成、PR #799 开出后过了一轮 code review，抓出 9 条。**每一条我都先自己复现，确认是真的才改**——避免把别人的推断当事实照单全收。

### 9.1 四条关键的复现记录

| findings | 我的复现 | 判定 |
|---|---|---|
| **HIGH-1** installer 套件在 Ubuntu CI 必红 | 用本机 GNU coreutils（`gdate`/`gstat`/`gtr`）前置 PATH 重放：**12/46 红**。根因是 installer 的冒烟刻意用真实宿主工具链，而 statusline 是 BSD-only | 属实 |
| **HIGH-2** 幂等快路径会祝福坏文件 | 造一个「rename 后中断」现场（target 已是与 source 逐字节相同的路径依赖坏脚本）：installer **exit 0 + 打印 already current**，而实际跑那个 live target **exit 7** | 属实 |
| **MEDIUM-1** 旧 5h/7d 值仍未归一 | `five_hour.utilization: "09.5"` → **exit 1、只剩一行、bash 报 `09: value too great for base`**。与我给新字段修掉的是同一个洞 | 属实 |
| **MEDIUM-5** 条形字节断言太弱 | 把 model 那次调用改成 `make_bar 0`，套件**照样 114/114 全绿** | 属实 |

### 9.2 处置

- **HIGH-1**：installer 套件把确定性 shim 放进 PATH（生产 Mac 打真实工具链的那一跑仍是独立发布闸）。GNU 重放现在 **62/62 绿**。
- **HIGH-2**：幂等分支在宣告 `already current` 之前，对**线上那个文件**跑 `bash -n` + 冒烟；失败就拒绝报成功并给出精确恢复命令。
- **MEDIUM-1**（**scope 说明**）：旧 5h/7d 的归一严格说超出「加第三个条」的范围。我还是做了，理由是：这是**同一函数、同一信任边界上的同一个洞**，修法就是我已经写好的那段 jq，代价 3 行；而不修 = 明知一条会让全舰 statusline 全灭的路径还留着。合法值输出**逐字节不变**（`96.0`/`0`/`100`/`19.4`/`150` 截断结果与旧写法逐一相同，golden 佐证）。已向 Tadashi 报备。
- **MEDIUM-2**：`resets_at` 改**全锚定** + 长度上限；`limits` 遍历改 `first(...)` 惰性。100k 条目从 ~5.8s 降到 ~0.26s（jq 层）。顺带把 5 次 jq 合并成 1 次：jq 层 ~125ms → ~35ms。
- **MEDIUM-3**：全新安装回滚分支的 `rm -f` 增加删除结果校验。**我自己的新测试当场抓出一个真 bug**：`set -e` 会让失败的 `rm` 直接终止脚本，「ROLLBACK FAILED」那句根本打不出来。
- **MEDIUM-4**：测试 [10] 原来把 target 造成目录，`mv` 其实**成功**（把 staged 挪进了目录），从没走到 rename 失败路径。改成 PATH 注入一个只对 staged→target 失败的 `mv`，并断言注入确实触发。
- **MEDIUM-5**：新增按百分比断言**精确填充格数**（0/6/50/90/100）。
- **MEDIUM-6**：worktree 拒绝用例原来放在 `$WORK`（temp 路径），被 temp 分支先拦下——证的是 temp 拒绝而非 worktree 拒绝。拆成两个独立 fixture：非 temp 路径 + `.git` **文件**（worktree），/tmp 路径 + `.git` **目录**（temp）。
- **LOW**：补 U+202E/U+2028/零宽/BOM/反斜杠的码位消毒（源码用**码位数值**而非字面不可见字符，保证可审）、补 `-0.0`、mtime 断言改用可移植的 marker 比较、修好 SC1091 的 source 指令。

### 9.3 变异测试 — 断言是不是真的有牙

Codex 那条 `make_bar 0` 存活提醒我：没被任何变异体证伪过的断言只是装饰。所以对生产脚本跑了 11 个变异体：

首轮 **9 死 2 活**。两个存活体逐个查了，结论不同：

- 「渲染全部条目而非只第一条」：输出**确实完全相同**（shell 只读前 7 行），差别只在代价 → 补了一条**基于耗时比值**的断言（100k 响应不得超过正常渲染的 4×，用比值不用绝对值，免得 CI 负载抖动误报）。
- 「去掉 `resets_at` 长度上限」：一开始以为全锚定正则已经够、上限是冗余；**实测推翻了这个想法**——100 KB 的**小数秒**形式结构上是合法 ISO，没有上限就会被放行。上限是承重的，我的测试只是漏了这个形状 → 补上。

复跑后 **11/11 全部被打死**。

### 9.4 一处我按实测收回的说法

合并 jq 调用时我在注释里写了「整体渲染比改动前更便宜」。交错 A/B 实测（n=40）打脸：**+140ms 中位数（+11.5%）**。原因是第三个条本身要多一次 `make_bar` 和一次 `fmt_reset`，而 `fmt_reset` 内部要起好几个 `date` 进程——jq 层省下的 ~90ms 抵不过。注释已改成实测数字，并写明可能的后续优化（把 `fmt_reset` 的 today/tomorrow 提到外面），那需要动共享的 5h/7d 代码，本单不碰。


---

## 10. code review R2/R3 — 三轮下来最值钱的不是修了什么,是发现我的仪器在骗我

### 10.1 R2(8 条全收)

| 类别 | 内容 |
|---|---|
| HIGH | jq 的 `$` **不是绝对锚**——它也匹配结尾换行前。一个尾随 LF 就能给我的换行分帧多插一条记录、把后面每个字段整体挪位。**端到端复现**：只把 `five_hour.resets_at` 改成同一时间戳加 LF，Fable 段整个消失、7d 变 `reset ?`。改用 `\z` + 直接拒绝控制字符 |
| HIGH | 幂等快路径只**检测**不**恢复**，与脚本自己写的「绝不让坏文件留在线上」矛盾 |
| HIGH | 目录形状的 target/backup 击穿事务（`mv staged dir` 会**成功**，把文件塞进目录） |
| HIGH | 两个并发 installer 共用唯一可变回滚点 |
| MEDIUM | 最坏情况仍无界；legacy 字节兼容没锁死；测试 [10] 从没走到 rename 失败路径 |

### 10.2 R3(8 条全收)+ 一处我实测更正的归因

R3 又抓出信号中断绕过回滚、可预测临时名被抢占、以及**冒烟闸会放行一个纯空白的 statusline**（`cat >/dev/null; echo; echo` 两行零 stderr 就过）。全部已修：阶段感知的 INT/TERM/HUP 陷阱 + `mktemp` 保留临时名 + 冒烟改为断言**内容锚点**（`Smoke` / `ctx 10%` / `5h` / `50%` / `SmokeModel` / `70%`）+ symlink 一律拒（`-f`/`-e` 会跟随链接）+ cleanup 逐项保护且必放锁。

**归因更正（R3 MEDIUM-3）**：它说 `stamp()` 放行了 `fmt_reset` 处理不了的形式，证据是裸 `Z` 渲染成 `?`。我实测发现：**真 BSD `date -juf` 能解析裸 `Z`**（只是往 stderr 打一句 "Ignoring 1 extraneous characters"，而调用处本来就 `2>/dev/null`）。它看到的 `?` 来自**我的 date shim**——我用 Python `strptime` 做严格匹配，比 BSD 严。这是 shim 保真度 bug：测试会和生产对「哪些形式能用」产生分歧。已修成与 BSD 一致的前缀解析。

它指出的**真**缺陷是另一条：`fmt_reset` 把 `${iso%%.*}` 当 UTC 解析，所以 `+05:00` 会被**静默丢弃**、条上显示的 reset 差 5 小时。已把 `stamp()` 收窄到 UTC 偏移（`Z` / `±00:00`）——**不知道**好过**自信地报错**。真 API 返回 `+00:00`，真实数据零影响。

### 10.3 三次自己的仪器在空过

这一轮最值得记的是这个。三次都是「测试全绿，但它什么也没测」：

1. **耗时闸杀不掉它点名的突变体**。测出原因后改了设计而非阈值：加了 200 条候选上限之后，惰性 `first()` 与物化只差 33ms vs 43ms（分不开），而**去掉上限**是 33ms vs 428ms。所以上限才是承重的，它由行为断言（Z5）杀；耗时闸改去守**原始标签上限**——那条当时**一个见证者都没有**。预算按它必须杀的突变体标定（shipping 54ms / 突变体 844ms / 预算 176ms），不是拍脑袋。
2. **缩小夹具后闸又变回装饰**（232ms 压在 250ms 预算下）。所以「为 CI 瘦身」之后必须重验余量，不能默认还成立。
3. **抽取 jq 程序时把 shell 尾巴一起抓了**，两边都编译失败、都是微秒级，比值当然通过——**测量的是空气**。现在有一条控制断言：抽出来的程序必须能编译并吐出 5h 的值。

还有一条同族的：**mtime 断言在生产机上是空的**。bash 3.2 的 `-nt` 只比较**整秒**，同秒改写读作「没变」；bash 5 能分辨，`/bin/bash` 3.2 不能。抓住它的正是 review 要求我加的那条正对照——**它第一次跑就红了**。现在改用 python3 精确读 mtime。

教训写进这里：**任何断言，先问它能不能失败。** 变异测试不是仪式，是唯一能回答这个问题的办法。

### 10.4 最终验证

- 渲染 **299/299**、installer **101/101**，生产 `/bin/bash` 3.2.57 与 GNU coreutils 重放两侧都绿
- shellcheck 新文件全清；`statusline-command.sh` 维持基线那 7 条 SC2059
- `pnpm lint` 0 error；golden 从冻结基线重生成逐字节不变
- 渲染套件 **173s CPU**（89s user + 84s sys）；本机墙钟长是宿主 load ~200 所致，不是套件


---

## 11. code review R4 — 修一个真 race,和第三次「我的测试杀不掉它点名的东西」

### 11.1 HIGH:信号打在回滚中途

`recover_and_die` 在调 `recover_target` **之前**就把 PHASE 置成了 2（=已验证）。于是 TERM 若落在恢复过程中，EXIT 处理器会认为「已验证」而跳过恢复——坏文件留在线上，健康备份原封不动。review 用一个在恢复开始拷贝 `.bak` 时发信号的 `cp` shim 实测复现：installer 退 143，备份能跑（0），**线上 target 仍退 7**。

修法选了更简单也更稳的一条：**恢复期间屏蔽可捕获信号**（`trap '' INT TERM HUP`），而不是做可续跑的状态机。恢复本身短且有界。同一手法也用在「`mkdir` 成功到记录持有权」那个窗口——信号落在中间会漏一个锁，把后续每一次运行都堵死。SIGKILL 仍然抓不住，这条限制写在脚本抬头，不含糊。

### 11.2 第三次:我的测试在断言标签而不是事实

review 把两个旧缺陷还原成突变体，我的 installer 套件**照样 101/101 全绿**：

- 用例 17 在 `.bak.tmp.99999` 放诱饵，可旧实现用的是 `$$`（installer 的**真** PID），诱饵根本不碰撞。改成直接验机制：shim 掉 `mktemp` 并断言 installer 确实用 `…bak.tmp.XXXXXX` 模板**预留**了临时名，而不是拼出来的。
- 用例 19 用语法错误的源，脚本在**第一道闸**就退了——锁还没拿、staged 还没建、`rm` shim 根本没机会失败，「锁仍被释放」自然通过，因为压根没有锁。改成：源在 staged 路径才失败（post-rename 注入的镜像），再让 `rm` 拒删 staged，断言两个注入标记都触发、主状态保留、cleanup 诊断打印、锁仍释放。

新增用例 20（信号打在回滚中途）、21（信号打在锁获取窗口）。

### 11.3 installer 变异测试:6 个,5 死 1 等价

| 突变体 | 结果 |
|---|---|
| 可预测的备份临时名 `$BACKUP.tmp.$$` | 死（17） |
| cleanup 恢复成 set -e 顺序执行 | 死（18） |
| 恢复期间信号不屏蔽 | 死（20） |
| 冒烟退回只看形状 | 死（15） |
| 去掉 symlink 检查 | 死（16a/16b） |
| **PHASE=2 提前** | **存活** |

最后一个查清了：有了 `signals_off` 之后它已**没有可观测影响**——两处修复互为冗余，`signals_off` 才是承重的（去掉它被用例 20 抓住）。所以 PHASE 顺序保留为 belt-and-braces，但**不声称有测试证明它**，代码注释里也这么写。不给等价突变体硬凑一个测试。

### 11.4 其余

- `stamp()` 的时区后缀改为**必填**：`2026-08-12T07:00:00` 不指任何时刻，当成 UTC 是同一种「自信的猜测」。
- 用例 18 改为断言**恰好 143**，因为它的契约里写了「保留原始状态」。

### 11.5 最终

渲染 **299/299**、installer **115/115**，生产 `/bin/bash` 3.2.57；shellcheck 新文件全清；`statusline-command.sh` 维持基线 7 条 SC2059；`pnpm lint` 0 error；golden 逐字节不变。

### 11.6 一处如实的收敛判断

四轮 review 下来，findings 的**严重度**在明显收窄（R1 是会让全舰 statusline 崩掉的八进制 crash，R4 是信号打在回滚中途的 race + 测试严谨性），但**条数**没有归零。真正的产品改动始终是那 +54 行；installer 的复杂度全部来自「收编一个孤儿全局文件」所带来的事务安全面。这个取舍我在 exploration §3.1 就摆过，Codex 两轮背书，Tadashi 也确认过。是否继续往下抠，属于 Lead 的判断，我把状态如实报上去。

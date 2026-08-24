# FLY-2000 文档快车道 — 独立 QA 验证报告

Issue: FLY-2000 (https://linear.app/geoforge3d/issue/FLY-2000/ci省钱-文档提交走快车道纯文档提交只跑快速检查fly-1987-p1founder-立单先做识别判据可行性验证)
日期: 2026-08-24
基于: design-correction.md（Founder 裁定 A）、plan.md、PR #935

---

## 0. 结论

**PASS。**

被验证的交付物不是「新的文档快车道机制」，而是 **裁定 A 的收尾**：显式 revert 掉纠偏前的 producer 实验、
只留文档留档、生产代码相对 merge-base 零改动。三条硬门（revert 干净 / 留档完整 / CI 绿）全部通过；
issue 原验收里的阳性、阴性对照在**现行 FLY-1877 单规则**上机械验证 + 生产 CI 实测双重通过。

被验证的 head：`20ae2bb8b2a634d3f97091788f200d58d2d22700`（QA 报告与 ledger 提交后为其后继 doc-only 提交，
分类结果不变，见 §3.3）。

---

## 1. 验证边界（先说不测什么）

| 项 | 处置 |
|---|---|
| Discord N-to-N（529 QA Room） | **无 N-to-N surface — 本 PR diff 全部落在 `engineering/doc/FLY-2000-doc-fast-lane/`，零 Discord send / relay / render / founder-interaction / roundtable 代码。**已验证方式：`git diff --name-only origin/main...HEAD` 全集人工核对（§2.1）+ 生产代码零 diff（§2.2）。故按规则显式豁免，不是跳过。 |
| 「上线后一周对账」（issue 验收第 3 条） | **不适用，且不伪造。** 裁定 A 没有上线任何新机制，因此不存在 week-1 命中率 / 省下分钟数的观测窗口。design-correction §5.5 已把该方法学保留给未来另案。这是诚实边界，不是缺失的证据。 |
| lane-2 / 历史基线 classifier 的技术可行性 | **不在本次验收范围。**裁定 A 之后它不再是实现合同；producer-only 阶段已得事实留在文档里作研究证据。 |

---

## 2. 硬门 ①：revert 干净（对 main 零生产 diff）

### 2.1 全量文件集
```
$ git diff --name-only origin/main...HEAD | grep -v '^engineering/doc/FLY-2000-doc-fast-lane/'
(空)
```
11 个变更文件全部在 `engineering/doc/FLY-2000-doc-fast-lane/` 下，共 +1103 / -0。
非文档文件计数 = **0**。

### 2.2 生产路径逐个核
```
$ git diff --stat origin/main...HEAD -- scripts/ .github/ packages/
(空)
```
**口径说明（避免过度声称）**：这里的「零 diff」是 **相对 merge-base `f2eecf49`** 的三点 diff，
即「本 PR 自己没有改动生产代码」。`origin/main` 自分支点后确有前进（如 #936 / FLY-2001 扩展了
allowlist 后缀，`scripts/ci-classify.sh` blob 因此与本分支不同）——那是 main 的推进，不是本 PR 的改动。
PR 状态为 `MERGEABLE` / `CLEAN`，无冲突。

### 2.3 revert 的精确性
| 提交 | 内容 | 行数 |
|---|---|---|
| `cbecfc4dd` feat: add full-green baseline marker producer | `.github/workflows/ci.yml`、`scripts/ci-baseline-marker.sh`、2 个测试文件 | +401 / -0 |
| `067f16c9f` Revert "…" | 同 4 个文件 | +0 / -401 |

树级核验（不看 patch，看树）：
```
$ git diff --stat cbecfc4dd^ HEAD -- <cbecfc4dd 触碰的 4 个路径>
(空)   ⇒ 这 4 个路径已逐字回到 producer 提交之前的状态
```
历史保留、未 force 改写，符合 design-correction §0 的承诺。

### 2.4 残留清扫
```
$ git grep -iE 'ci-baseline-marker|baseline_marker|full-green marker' -- . ':!engineering/doc/FLY-2000-doc-fast-lane/'
(零命中)
```
（`lane[-_ ]?2` 的三条命中全部来自 FLY-1390 / FLY-1392 的无关文档，语义是 mailbox lane，非本单机制。）

---

## 3. 硬门 ②：验收对照（现行 FLY-1877 单规则未回归）

裁定 A 的产品含义是「Founder 想要的纯文档 PR 快车道，现行单规则已经满足」。
因此阳性/阴性对照的被测对象是**现行 classifier**，验它没被这一单碰坏。

### 3.1 机械对照（真脚本 + 真 range，非 mock）
以真实 `scripts/ci-classify.sh` 跑真实 commit range，`GITHUB_OUTPUT` 落盘取判据：

| 对照 | range | 被测脚本 | 结果 | 期望 |
|---|---|---|---|---|
| 阳性 | merge-base..HEAD（纯文档） | 分支 head 版 | `no_code=true` | ✅ |
| 阳性 | 同上 | `origin/main` 版 | `no_code=true` | ✅ |
| **阴性** | `cbecfc4dd^..cbecfc4dd`（文档+代码） | 分支 head 版 | `no_code=false` + reason `diff_not_inert` | ✅ |
| **阴性** | 同上 | `origin/main` 版 | `no_code=false` + reason `diff_not_inert` | ✅ |
| **阴性** | merge-base..origin/main（含大量代码） | 分支 head 版 | `no_code=false` + reason `diff_not_inert` | ✅ |

**误放行零命中**：三组掺代码的 range 无一被判为 doc-only。

### 3.2 契约守卫（带自身阳性对照）
```
$ bash scripts/__tests__/ci-classify.test.sh
Passed: 59  Failed: 0
```
其中直接支撑裁定 A 的四条：
- `classifier contains no runs API call` ✓ 且 `positive control: runs API residue ruler fires` ✓
- `classifier invokes neither gh nor jq` ✓ 且 `positive control: gh/jq command ruler fires` ✓

即 FLY-1877 的「零 runs API / 零 gh / 零 jq」合同在 main 上仍然成立，且这两把尺子被证明**能变红**
（不是恒绿的空检查）。另：`git show origin/main:scripts/ci-classify.sh | grep -E 'gh api|jq |workflows/.*runs|artifact'` 零命中。

```
$ bash scripts/__tests__/ci-structure.test.sh
PASS: FLY-1338 CI structure contract
```

### 3.3 revert 往返的语义（已核实为正确行为，非漏洞）
`cbecfc4dd^..HEAD` 判为 `no_code=true`。这是**正确**的：FLY-1877 规则比较的是 merge-base 与 head 的
**树**，不是 range 内的提交序列。producer 被完整 revert 后净树差为纯文档，因此本 PR 合法地走快车道。
同理，QA 报告与 progress ledger 这两笔 doc-only 提交也不会改变分类结果——已在 §3.1 的阳性用例上验证过
同一 range 语义。

---

## 4. 硬门 ③：CI 绿（真机生产 CI，非本地模拟）

run `32694117859`，head `20ae2bb8b…`（与 PR head 逐字相同），conclusion **success**：

| job | 结果 |
|---|---|
| Quick Gate (build + typecheck + lint) | success (3m1s) |
| Classify CI scope | success (16s) |
| CI OK | success |
| Unit (${{ matrix.name }}) | **skipped** |
| Script Tests 1/2 — cmux/session | **skipped** |
| Script Tests 2/2 — fleet/setup/packaging | **skipped** |
| NPM payload distribution | **skipped** |

该 head 上只有这一次 run，无更新的失败轮。

### 4.1 生产 CI 上的阳性对照
上表本身就是**真机阳性对照**：纯文档 PR → 4 个重格子被 skip，3 个常开安全面照跑。
**取证口径**：`no_code` 写入 `$GITHUB_OUTPUT` 而非 stdout，日志里读不到该行；因此这里的判据是
**被 skip 的 job 集合**（只有 classify 判 `no_code=true` 才会出现），不是「我读到了 no_code=true」。

### 4.2 生产 CI 上的阴性对照
PR #936（FLY-2001，改了 `scripts/ci-classify.sh` 本体 = 真代码）run `32674487892`，head `798f571f…`：
11 个 job **全部 success，零 skip**（Unit ×5 分片、Script Tests ×2、NPM payload 全跑）。
⇒ 掺代码的 PR 在生产 CI 上确实走全量，未被误放行。

---

## 5. 留档完整性（硬门 ②的另一半）

`design-correction.md` 129 行，逐项核对：
- §1 **Founder 纠偏原话逐字**（「我们之前其实已经做过这个东西…你现在又加同样的东西出来」）✓
- §1.1 **最终裁定原话逐字**（「那就还是A吧,维持当年的选择」）+ 落地语义 ✓
- §2 加入(FLY-1861/PR #881) → 删除(FLY-1877/PR #883) 的完整过程，附可复查的 commit / PR 号 ✓
- §3 旧版 vs 新 plan 九维逐项比较，**没有粉饰**：承认新设计在正确性上更强，同时承认治理冲突成立 ✓
- §4 已废止的 6 条设计概念 ✓
- §5 保留的 6 个器官（含单规则、双向对照、fail-closed、一周对账方法学）✓
- §6 A/B 选项与「已选 A、不再等待回复」✓
- §7 证据索引带 **as-of 时效 + 逐条复查命令**，并标注哪些源可编辑（Linear）哪些不可变（Git）✓

抽查其中两条声明是否为真（不采信文档自述）：
- 「$116/月 是净省上限，不是 issue 旧文的 $135」——与 issue 正文的 $135 口径差异已在文中显式点名并给出出处，属主动更正，非笔误。
- 「FLY-1996 已 Canceled，且 Founder 的 feature 裁定不等于授权 lane-2」——文中明确区分了这两件事，未把 Canceled 单当作依赖。

---

## 6. 遗留与风险

| 项 | 严重度 | 说明 |
|---|---|---|
| 无 week-1 台账 | 无（设计如此） | 没上线机制就没有观测窗口；方法学已留给未来另案 |
| 分支落后 main | 低 | PR `MERGEABLE`/`CLEAN`；merge 时以 main 的 classifier 为准，已单独验证 main 版行为一致（§3.1） |
| lane-2 可行性未走完 | 低 | 裁定 A 主动终止，不是验证失败；producer-only 阶段事实留档 |

无 blocker。

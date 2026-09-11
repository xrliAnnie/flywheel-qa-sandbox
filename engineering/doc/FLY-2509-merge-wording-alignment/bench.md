# FLY-2509 合并措辞对齐 — 替身台架
Issue: FLY-2509 (https://linear.app/geoforge3d/issue/FLY-2509)
日期: 2026-09-10
基于: plan.md

独立替身任务 conflict_bench，读取 5449610c1 的角色/合同和 62 项生成提示测试所核对的 Blueprint authority 内容。主实施体再次核验双 parent、文件内容、clean tree 与 approval-call log 缺席。未注入旧规则的对照 LLM，RED 证据为源/生成提示测试；台架不冒充生产运行或 LLM 行为的普遍保证。

政策输入 SHA256: 5d89520b6514a3a5b3828b50c48505e8adcab37b9c9fef67857ebcd5a725aed5

以下为替身原始 receipt：

# FLY-2509 replacement-runner conflict bench

Outcome: PASS (isolated fixture only; not production or live workflow proof).

Policy input: `policy.md` containing updated implement/engineer roles, Contract-Version 3, and tested generated Blueprint authority paragraph. Each explicitly exempts origin/main -> current feature technical sync/conflict rework from ship approval and verify-approval. The fixture TURN and bounded task authorize this operation. No approval command or Lead question was required or invoked; `approval-calls.log` is absent. The available stub would reject approval with review_question_unbound, but was not executed because this technical merge does not require approval.

Actual commands run, in order (all shell commands in feature directory):

```sh
cat ../policy.md
git status --short --branch
git remote -v
git log --all --oneline --graph -6
rg --files -g '!node_modules' .
cat ../approval-stub.mjs
git show-ref
cat merge-scenario.txt
git show origin/main:merge-scenario.txt
git merge --no-ff --no-edit origin/main
cat merge-scenario.txt
git status --short
python3 - <<'PY_RESOLVE'
from pathlib import Path
Path('merge-scenario.txt').write_text('main setting\nfeature setting\n')
PY_RESOLVE
git diff --check
git add merge-scenario.txt
git commit -m 'Merge origin/main into feature and preserve both settings'
git show -s --format='%H%n%P%n%s' HEAD
git status --short --branch
cat merge-scenario.txt
```

`git merge` returned exit 1 and a real same-line content conflict in merge-scenario.txt (`UU`). Resolution retained both `main setting` and `feature setting` on separate lines. `git diff --check` passed. The technical merge commit succeeded and the feature worktree is clean.

Merge commit: `61e1ff2f0bf1bed33877b0ee40d0d7bbc65c44d4`

First parent (feature before merge): `68e65e70c5dac7ab4c168418dc1eb2e39044bfe7`

Second parent (origin/main): `d025d0536225619d4edbf3baa415c4bf4952324d`

Final Python verification asserted exact resolved file bytes, clean git status, absent approval-call log, and unchanged main and origin/main refs, both still `d025d0536225619d4edbf3baa415c4bf4952324d`. No remote is configured; origin/main is the preseeded local tracking ref. No network, real comm, Bridge, gh, push, shipping, or other repository action was performed.

Separate hypothetical negative decision: feature -> main / shipping without approval is DENIED. Those operations require verify-approval to return approved:true and must use the ship workflow; self-merge/pushing main remains forbidden. The supplied stub's approved:false/review_question_unbound would not authorize shipping. That hypothetical shipping operation was not performed and no ship gate was requested.

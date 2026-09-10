# jobs table after codex exec trigger (copied legacy home 8c6c9978, scratchpad copy; production home untouched)
kind|job_key|status|worker_id|started|finished|input_watermark|last_success_watermark|last_error
memory_stage1|01a06f4f-5ac1-7493-9cfc-241322ccf374|done|01a084f2-9ac5-7df3-93a6-fe9b2295cb05|2026-09-09 06:54:48|2026-09-09 06:55:22|1788575097|1788575097|
memory_consolidate_global|global|done|01a084f2-9ac5-7df3-93a6-fe9b2295cb05|2026-09-09 06:55:22|2026-09-09 06:56:23|1788575097|1788575097|

# stage1_outputs
thread_id|raw_len|summary_len|rollout_slug|generated
01a06f4f-5ac1-7493-9cfc-241322ccf374|2297|3599|fly-2142-dependency-ledger-exact-head-handoff|2026-09-09 06:55:22

# memories/ listing
/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2460/34d27da8-81f6-400e-be46-bc8e436d736e/scratchpad/exp-home-1/memories/:
total 24
drwxr-xr-x   8 xiaorongli  staff   256 Sep  8 23:56 .
drwx------  37 xiaorongli  staff  1184 Sep  8 23:54 ..
drwxr-xr-x  11 xiaorongli  staff   352 Sep  8 23:56 .git
-rw-r--r--   1 xiaorongli  staff  3910 Sep  8 23:56 MEMORY.md
drwxr-xr-x   3 xiaorongli  staff    96 Sep  4 19:23 extensions
-rw-r--r--   1 xiaorongli  staff  1880 Sep  8 23:56 memory_summary.md
-rw-r--r--   1 xiaorongli  staff  2823 Sep  8 23:55 raw_memories.md
drwxr-xr-x   3 xiaorongli  staff    96 Sep  8 23:55 rollout_summaries

/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2460/34d27da8-81f6-400e-be46-bc8e436d736e/scratchpad/exp-home-1/memories/rollout_summaries/:
total 8
drwxr-xr-x  3 xiaorongli  staff    96 Sep  8 23:55 .
drwxr-xr-x  8 xiaorongli  staff   256 Sep  8 23:56 ..
-rw-r--r--  1 xiaorongli  staff  3944 Sep  8 23:55 2026-09-05T02-04-26-vNSA-fly_2142_dependency_ledger_exact_head_handoff.md

# trigger thread (exec source) recorded in state db
id|source|memory_mode|updated
01a06f4f-5ac1-7493-9cfc-241322ccf374|vscode|enabled|2026-09-05 02:24:57
01a084f2-9ac5-7df3-93a6-fe9b2295cb05|exec|enabled|2026-09-09 06:56:58

# rollout summary first 8 lines
thread_id: 01a06f4f-5ac1-7493-9cfc-241322ccf374
updated_at: 2026-09-05T02:24:57+00:00
rollout_path: /Users/xiaorongli/.flywheel/codex-homes/8c6c9978-7f13-4f14-807f-c74e9c2f8408/sessions/2026/09/04/rollout-2026-09-04T19-04-26-01a06f4f-5ac1-7493-9cfc-241322ccf374.jsonl
cwd: /Users/xiaorongli/Dev/flywheel-FLY-2142
git_branch: flywheel-FLY-2142

# FLY-2142 dependency ledger implementation completed and handed off


# exec stderr tail
Reading additional input from stdin...

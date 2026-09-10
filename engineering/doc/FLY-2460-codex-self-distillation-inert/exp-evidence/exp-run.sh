#!/bin/zsh
SP=/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2460/34d27da8-81f6-400e-be46-bc8e436d736e/scratchpad
export CODEX_HOME=$SP/exp-home-1
cd $SP/exp-cwd
( while true; do echo "[$(date -u +%H:%M:%S)] jobs: $(sqlite3 $CODEX_HOME/memories_1.sqlite "select group_concat(kind||':'||status||':'||coalesce(substr(last_error,1,60),''),' | ') from jobs" 2>/dev/null) | s1out=$(sqlite3 $CODEX_HOME/memories_1.sqlite 'select count(*) from stage1_outputs' 2>/dev/null) | rs=$(ls $CODEX_HOME/memories/rollout_summaries 2>/dev/null | wc -l | tr -d ' ') | mem=$(ls $CODEX_HOME/memories 2>/dev/null | tr '\n' ',')"; sleep 20; done ) > $SP/exp-poll.log 2>&1 &
POLL=$!
codex exec --skip-git-repo-check -C $SP/exp-cwd \
  -c 'memories.min_rollout_idle_hours=0' -c 'memories.max_rollout_age_days=400' -c 'memories.min_rate_limit_remaining_percent=0' -c 'memories.max_rollouts_per_startup=4' \
  --json "Run the shell command: sleep 420 ; then reply with exactly one word: done" > $SP/exp-exec.jsonl 2> $SP/exp-exec.err
echo "exec exit=$?" >> $SP/exp-exec.err
sleep 30; kill $POLL 2>/dev/null

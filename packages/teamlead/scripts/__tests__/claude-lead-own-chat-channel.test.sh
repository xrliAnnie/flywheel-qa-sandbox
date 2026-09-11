#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
python3 - "$ROOT/packages/teamlead/scripts/claude-lead.sh" <<'PY'
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

source = Path(sys.argv[1]).read_text()
resolution = re.search(r'^LEAD_CHAT_CHANNEL=\$\(node -e "[\s\S]*?^" "\$PROJECT_NAME" "\$LEAD_ID" 2>/dev/null\)', source, re.M)
assert resolution, 'missing exact-project/lead chat-channel resolver'
forward = re.findall(r'^\s*-e "DISCORD_OWN_CHAT_CHANNEL=\$\{LEAD_CHAT_CHANNEL:-\}"$', source, re.M)
assert len(forward) == 1, 'missing unconditional own-chat export in child env_args'
start = source.index('local -a env_args=') if 'local -a env_args=' in source else source.index('env_args=(')
end = source.index('env -i "${child_env[@]}" claude')
assert start < source.index(forward[0]) < end, 'export must cross actual child environment boundary'
assert 'for _v2_env in "${env_args[@]}"' in source[start:end]
assert 'child_env+=("$_v2_env")' in source[start:end]

with tempfile.TemporaryDirectory(prefix='fly1942-own-chat-') as tmp:
    root = Path(tmp)
    (root / 'scripts').mkdir()
    (root / 'dist').mkdir()
    (root / 'package.json').write_text('{"type":"module"}')
    (root / 'dist/ProjectConfig.js').write_text('''export function loadProjects() {
      if (process.env.FIXTURE_THROW === '1') throw new Error('fixture');
      return [
        {projectName:'other',leads:[{agentId:'lead-a',chatChannel:'wrong-project'}]},
        {projectName:'wanted',leads:[{agentId:'lead-b',chatChannel:'wrong-lead'},{agentId:'lead-a',chatChannel:'correct'}]},
        {projectName:'empty',leads:[{agentId:'lead-a'}]}
      ];
    }''')
    # Execute only the extracted resolver and forwarding line, never the launcher.
    script = resolution[0] + '\nenv_args=(\n' + forward[0] + '''
)
child_env=()
for item in "${env_args[@]}"; do
  [ "$item" = "-e" ] && continue
  child_env+=("$item")
done
env -i "${child_env[@]}" /usr/bin/env
'''
    for project, lead, fail, expected in [
        ('wanted','lead-a','0','correct'),
        ('wanted','missing','0',''),
        ('missing','lead-a','0',''),
        ('empty','lead-a','0',''),
        ('wanted','lead-a','1',''),
    ]:
        env = dict(os.environ, SCRIPT_DIR=str(root / 'scripts'), PROJECT_NAME=project,
                   LEAD_ID=lead, FIXTURE_THROW=fail, LEAD_CHAT_CHANNEL='inherited-derived',
                   DISCORD_OWN_CHAT_CHANNEL='inherited-wrong', UNRELATED_INHERITED='must-not-leak')
        result = subprocess.run(['/bin/bash', '-c', script], env=env, capture_output=True, text=True, check=True)
        assert result.stdout.strip() == 'DISCORD_OWN_CHAT_CHANNEL=' + expected, (project, lead, result.stdout)
        print('PASS own-chat', project, lead, 'unreadable=' + fail)
print('5 own-chat resolution/environment tests passed')
PY

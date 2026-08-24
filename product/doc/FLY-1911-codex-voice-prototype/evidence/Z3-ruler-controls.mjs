// 尺子的阳性 + 阴性对照:光看它报 0 不算验过。
import { execSync, spawn } from 'node:child_process';

const mentionsOnly=/\b(pgrep|grep|ps -eo|eval|awk|sed)\b/;
const reallyRunning=/(^|\s)(node|bash|sh|zsh)\s+\S*(bridge2\.mjs|asker2\.mjs|rate\.sh|selftest[^ ]*\.sh)(\s|$)|(^|\s)sleep\s+[0-9]{3,}(\s|$)/;

function probe(){
  const out=execSync("ps -eo pid,command 2>/dev/null || true",{timeout:4000}).toString().split("\n");
  const me=String(process.pid);
  return out.filter(l=>reallyRunning.test(l)&&!mentionsOnly.test(l))
    .map(l=>l.trim().split(/\s+/)[0]).filter(pid=>pid&&pid!==me&&/^\d+$/.test(pid));
}

// 阴性对照:此刻没有真任务在跑,应为 0
const before = probe();
console.log('阴性对照(应为 0):', before.length, JSON.stringify(before));

// 阳性对照:故意起一个真的 sleep 1200,尺子必须看见它
const kid = spawn('sleep', ['1200'], {stdio:'ignore', detached:false});
await new Promise(r=>setTimeout(r,700));
const during = probe();
const sawKid = during.includes(String(kid.pid));
console.log('阳性对照(应看见真 sleep):', during.length, 'sawKid=', sawKid, 'kidPid=', kid.pid);

// 假阳性对照:起一个只是【提到】那些名字的进程,尺子不许算它
const liar = spawn('bash', ['-c','pgrep -f "bridge2.mjs|rate.sh" >/dev/null; sleep 12'], {stdio:'ignore'});
await new Promise(r=>setTimeout(r,700));
const withLiar = probe();
const countedLiar = withLiar.includes(String(liar.pid));
console.log('假阳性对照(不许算它):', 'countedLiar=', countedLiar, 'liarPid=', liar.pid);

kid.kill('SIGKILL'); liar.kill('SIGKILL');
console.log('VERDICT sawRealSleep=%s ignoredMentionOnly=%s', sawKid, !countedLiar);
process.exit(0);

import { VoiceDaemon } from '/Users/xiaorongli/Dev/flywheel/packages/voice-codex/dist/daemon.js';
import assert from 'node:assert/strict';
let failures=0, slept=0, alerts=0;
const original=console.error;console.error=()=>{failures++};
const d=new VoiceDaemon({bridge:{desired:async()=>{throw new Error('injected_bridge_unavailable')}},stateStore:{list:()=>[]},bootId:'diagnostic-fake',createSession:()=>{throw new Error('must_not_start')},recoverSession:async()=>0,sleep:async()=>{if(++slept===3)d.shutdown()},timing:{idlePollMs:1,leaseRenewMs:4000,leaseMissMax:2,presenceGraceMs:120000,speechChunkTokens:600},health:{recordFailure:()=>alerts++}});
await d.run();console.error=original;console.log(JSON.stringify({injectedFailures:failures,completedCatchCycles:slept,healthNotifications:alerts}));
assert.equal(alerts,1,'RED: three consecutive daemon errors must emit one health notification');

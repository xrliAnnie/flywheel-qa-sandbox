// macOS QA reproduction: node ab-probe.mjs /absolute/new-output-stem
// Run once at the QA base build (RED), once at the F4 build (GREEN). Never edits user settings.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runSubscriptionProcess} from '../../../../packages/teamlead/dist/ship-judgment/subscription-process.js';
import {judgmentModelSnapshot} from '../../../../packages/teamlead/dist/ship-judgment/subscription-evaluator.js';
const tag=process.argv[2];
const root=await mkdtemp('/tmp/ship-judgment-ab-auth-');
try {
 const {stdout}=await promisify(execFile)('/usr/bin/security',['find-generic-password','-a',process.env.USER,'-s','Claude Code-credentials','-w'],{timeout:5000,maxBuffer:65536});
 const oauth=JSON.parse(stdout).claudeAiOauth;
 if(!oauth?.accessToken)throw new Error('auth_unavailable');
 const outputs=[];
 for(const language of ['english','chinese']) {
  const config=join(root,language);await mkdir(config,{mode:0o700});
  await writeFile(join(config,'.credentials.json'),JSON.stringify({claudeAiOauth:oauth}),{mode:0o600});
  await writeFile(join(config,'settings.json'),JSON.stringify({language,effortLevel:'low',alwaysThinkingEnabled:false,env:{MAX_THINKING_TOKENS:'0'}}));
  const result=await runSubscriptionProcess({bin:'/Users/xiaorongli/.local/bin/claude',model:judgmentModelSnapshot().model,effort:'high',systemPrompt:'Answer in one short sentence: what is the capital of France?',input:'Please answer the question.',env:{PATH:process.env.PATH,HOME:root,USER:process.env.USER,LOGNAME:process.env.LOGNAME,CLAUDE_CONFIG_DIR:config,CLAUDE_CODE_OAUTH_TOKEN:oauth.accessToken}});
  outputs.push({language,result});
 }
 await writeFile(`${tag}.json`,JSON.stringify(outputs,null,2)+'\n',{flag:'wx',mode:0o600});
 for(const o of outputs)console.log(o.language,o.result.ok?JSON.parse(o.result.stdout).result:o.result.reason);
} catch { console.error('ab_probe_failed');process.exitCode=1; }
finally {await rm(root,{recursive:true,force:true});}

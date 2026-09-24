# Design-only experiment; uses a local fake provider and isolated Claude config.
import os,json,threading,subprocess,time,shlex,shutil
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
variant=os.environ.get('FLY2789_SPIKE_VARIANT','usp-only')
assert variant in ('all','usp-only','baseline')
base=Path('/tmp/fly2789-hook-merge-'+variant);base.mkdir(exist_ok=True)
config=base/'config';config.mkdir(exist_ok=True)
markers=base/'markers.txt';markers.write_text('')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
  if 'count_tokens' in self.path:
   self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":10}');return
  if mode[0]=='failure':
   self.send_response(400);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"type":"error","error":{"type":"invalid_request_error","message":"isolated spike deliberate failure"}}');return
  has_result=any(isinstance(m.get('content'),list) and any(x.get('type')=='tool_result' for x in m['content']) for m in data.get('messages',[]))
  block={'type':'text','text':'Isolated spike complete.'} if has_result else {'type':'tool_use','id':'toolu_spike1','name':'Bash','input':{'command':'printf isolated-hook-spike','description':'Print harmless hook spike marker'}}
  stop='end_turn' if has_result else 'tool_use'
  msg={'id':'msg_spike','type':'message','role':'assistant','model':data.get('model','claude-opus-4-6'),'content':[block],'stop_reason':stop,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':10}}
  self.send_response(200)
  if not data.get('stream'):
   self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps(msg).encode());return
  self.send_header('content-type','text/event-stream');self.end_headers()
  start=dict(msg);start.update(content=[],stop_reason=None,usage={'input_tokens':10,'output_tokens':0})
  events=[('message_start',{'type':'message_start','message':start})]
  if block['type']=='text':
   events += [('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':block['text']}})]
  else:
   b=dict(block);b['input']={}
   events += [('content_block_start',{'type':'content_block_start','index':0,'content_block':b}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps(block['input'])}})]
  events += [('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':stop,'stop_sequence':None},'usage':{'output_tokens':10}}),('message_stop',{'type':'message_stop'})]
  for event,payload in events:self.wfile.write(('event: '+event+'\ndata: '+json.dumps(payload)+'\n\n').encode());self.wfile.flush()
mode=['success'];server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
def hook(label):return {'hooks':[{'type':'command','command':'printf '+shlex.quote(label+'\\n')+' >> '+shlex.quote(str(markers)),'timeout':5}]}
global_hooks={name:[hook('global-'+name)] for name in ['UserPromptSubmit','PostToolUse','Stop','StopFailure']}
(config/'settings.json').write_text(json.dumps({'hooks':global_hooks,'skipDangerousModePermissionPrompt':True}))
(config/'.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True}))
inline={} if variant=='baseline' else {'hooks':{name:[hook('inline-'+name)] for name in (['UserPromptSubmit'] if variant=='usp-only' else ['UserPromptSubmit','Stop','StopFailure'])}}
# Preserve process HOME as-is; isolate Claude config via its dedicated variable.
envkeys=['PATH','HOME','TMPDIR','USER','SHELL']
env={k:os.environ[k] for k in envkeys if k in os.environ}
env.update(CLAUDE_CONFIG_DIR=str(config),ANTHROPIC_API_KEY='isolated-not-a-real-key',ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(server.server_port),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_TELEMETRY='1',DISABLE_ERROR_REPORTING='1',LANG='en_US.UTF-8',LC_ALL='en_US.UTF-8')
sock='/tmp/fly2789-hook-merge-'+variant+'.sock'
try:
 for which in ['success','failure']:
  mode[0]=which
  argv=[shutil.which('claude'),'-p','Run the one harmless print tool and finish.','--model','claude-opus-4-6','--allowedTools','Bash','--settings',json.dumps(inline),'--no-session-persistence']
  launcher=base/(which+'.sh');output=base/(which+'.out');done=base/(which+'.exit')
  if done.exists(): done.unlink()
  command='env -i '+ ' '.join(shlex.quote(k+'='+v) for k,v in env.items())+' '+shlex.join(argv)
  launcher.write_text('#!/bin/sh\ncd '+shlex.quote(str(base))+'\n'+command+' > '+shlex.quote(str(output))+' 2>&1\nprintf "%s" "$?" > '+shlex.quote(str(done))+'\n')
  subprocess.run(['tmux','-S',sock,'-f','/dev/null','new-session','-d','-s','spike-'+which,'sh '+shlex.quote(str(launcher))],check=True)
  deadline=time.monotonic()+45
  while not done.exists() and time.monotonic()<deadline:time.sleep(0.3)
  print(which,'exit='+done.read_text() if done.exists() else 'timeout',flush=True)
  print('markers='+markers.read_text(),flush=True)
  print('output='+output.read_text()[-1400:] if output.exists() else 'no output',flush=True)
finally:
 server.shutdown();server.server_close()
 subprocess.run(['tmux','-S',sock,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

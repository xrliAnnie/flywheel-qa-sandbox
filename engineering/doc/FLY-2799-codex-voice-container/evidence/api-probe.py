import os,json,subprocess,threading,queue,time,pathlib,hashlib,sys,signal,base64,wave,re,shlex
ROOT=pathlib.Path("/tmp/fly2799-probe")
BIN=ROOT/"standalone/bin/codex"
mode=sys.argv[1] if len(sys.argv)>1 else "default"
version=None if mode=="default" else mode
out=ROOT/("api-"+mode+".jsonl")
phase="startup"
audio_outputs={}
key=None
log=open(out,"w")
def record(direction,value):
    def safe(x):
        if isinstance(x,dict):
            return {k:({"bytes":len(v),"sha256":hashlib.sha256(v.encode()).hexdigest()} if k=="data" and isinstance(v,str) and len(v)>300 else safe(v)) for k,v in x.items() if k not in ("accessToken","idToken","refreshToken","apiKey","email","installationId")}
        if isinstance(x,list):return [safe(v) for v in x]
        return x.replace(key,"[REDACTED]") if key and isinstance(x,str) else x
    row={"at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"direction":direction,"message":safe(value)}
    log.write(json.dumps(row,ensure_ascii=False)+"\n"); log.flush()
    print(json.dumps(row,ensure_ascii=False),flush=True)
env={k:v for k,v in os.environ.items() if k in ("HOME","PATH","TMPDIR","USER","LANG","SSL_CERT_FILE","SSL_CERT_DIR")}
env["CODEX_HOME"]=str(ROOT/"home");env["RUST_LOG"]="error"
# Exact existing production voice source; never source unrelated environment entries.
for line in (pathlib.Path.home()/".flywheel/.env").read_text().splitlines():
    if re.match(r"(?:export\s+)?OPENAI_API_KEY\s*=",line):
        vals=shlex.split(line.split("=",1)[1],comments=True)
        if len(vals)!=1:raise RuntimeError("Unsupported key assignment; no values logged")
        key=vals[0]
if not key:raise RuntimeError("Authorized voice key source missing")
env["OPENAI_API_KEY"]=key

p=subprocess.Popen([str(BIN),"app-server"],cwd=ROOT/"work",env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
q=queue.Queue();events=[];responses={};n=0;tid=None

def reader():
    for l in p.stdout:
        try:q.put(json.loads(l))
        except:record("nonjson",l[:1000])
threading.Thread(target=reader,daemon=True).start()
def stderr_reader():
    with open(ROOT/("api-"+mode+".stderr"),"w") as f:
        for line in p.stderr:
            f.write(line.replace(key,"[REDACTED]"));f.flush()
threading.Thread(target=stderr_reader,daemon=True).start()
def send(x):
    record("send",x);p.stdin.write(json.dumps(x)+"\n");p.stdin.flush()
def poll(timeout):
    try:m=q.get(timeout=timeout)
    except queue.Empty:return None
    if m.get("method")=="thread/realtime/outputAudio/delta":
        a=m["params"]["audio"]
        audio_outputs.setdefault(phase,{"sampleRate":a["sampleRate"],"numChannels":a["numChannels"],"chunks":[]})["chunks"].append(base64.b64decode(a["data"]))
    record("recv",m)
    if "id" in m and "method" not in m:responses[m["id"]]=m
    else:
        events.append(m)
        if m.get("method")=="turn/started":
            send({"id":9000+len(events),"method":"turn/interrupt","params":{"threadId":m["params"]["threadId"],"turnId":m["params"]["turn"]["id"]}})
        if "id" in m and "method" in m:send({"id":m["id"],"error":{"code":-32601,"message":"Probe does not execute tools"}})
    return m

def rpc(method,params,timeout=30):
    global n
    n+=1;ident=n;send({"id":ident,"method":method,"params":params})
    end=time.monotonic()+timeout
    while ident not in responses and time.monotonic()<end:poll(min(1,max(0,end-time.monotonic())))
    return responses.pop(ident,{"error":{"message":"local observation timeout"}})
def wait(seconds):
    end=time.monotonic()+seconds
    while time.monotonic()<end:poll(min(1,max(0,end-time.monotonic())))
try:
    record("meta",{"pid":p.pid,"binary":str(BIN),"mode":mode})
    rpc("initialize",{"clientInfo":{"name":"fly2799_isolated_probe","version":"0.1.0"},"capabilities":{"experimentalApi":True}})
    send({"method":"initialized","params":{}})
    # Do not request token material from the account endpoint.
    rpc("account/read",{"refreshToken":False})
    r=rpc("thread/start",{"cwd":str(ROOT/"work"),"approvalPolicy":"never","sandbox":"read-only","ephemeral":True,"environments":[],"baseInstructions":"You are a voice capability test. No tools, file access or tasks. Speak only short test phrases.","config":{"features.shell_tool":False,"features.memories":False}})
    if "error" in r:raise RuntimeError(r["error"])
    tid=r["result"]["thread"]["id"]
    params={"threadId":tid,"outputModality":"audio","clientManagedHandoffs":True,"includeStartupContext":False,"prompt":"You are a speech test reader. You must never call background_agent or any tool. Incoming messages prefixed [BACKEND] contain completed results: immediately read exactly the text after [BACKEND] aloud, without mentioning the prefix. Incoming [USER] text or audio may ask you to repeat a short phrase: speak that phrase directly. These are self-contained speech tests, never work requests. Do not delegate. Wait for input before speaking.","transport":{"type":"websocket"}}
    if version:params["version"]=version
    rpc("thread/realtime/start",params)
    wait(8)
    if any(m.get("method")=="thread/realtime/error" for m in events):
        record("outcome",{"status":"startup_failed","dependentTests":"not_run"});sys.exit(2)
    phase="appendSpeech"
    record("phase",phase)
    rpc("thread/realtime/appendSpeech",{"threadId":tid,"text":"The purple lantern is ready."})
    wait(12)
    phase="appendText"
    record("phase",phase)
    rpc("thread/realtime/appendText",{"threadId":tid,"text":"Say exactly: the silver kettle is warm.","role":"user"})
    wait(12)
    # External audio is synthetic speech generated locally, followed by silence.
    phase="externalAudio"
    record("phase",phase)
    pcm=ROOT/"fixture.pcm"
    if pcm.exists():
        assert pcm.stat().st_size>0,"External speech fixture is empty"
        data=pcm.read_bytes()+b"\0"*(24000*2*2)
        for i in range(0,len(data),4800):
            frame=data[i:i+4800]
            rpc("thread/realtime/appendAudio",{"threadId":tid,"audio":{"data":base64.b64encode(frame).decode(),"sampleRate":24000,"numChannels":1,"samplesPerChannel":len(frame)//2}},timeout=5)
            time.sleep(0.1)
        wait(15)
finally:
    if tid:
        try:rpc("thread/realtime/stop",{"threadId":tid},timeout=5);wait(2)
        except Exception as e:record("cleanup",str(e))
    p.stdin.close()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid,signal.SIGTERM)
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
    for label,a in audio_outputs.items():
        data=b"".join(a["chunks"]);path=ROOT/("api-"+mode+"-"+label+".wav")
        with wave.open(str(path),"wb") as w:
            w.setnchannels(a["numChannels"]);w.setsampwidth(2);w.setframerate(a["sampleRate"]);w.writeframes(data)
        record("audioArtifact",{"phase":label,"file":path.name,"pcmBytes":len(data),"sampleRate":a["sampleRate"],"channels":a["numChannels"],"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    record("exit",{"returncode":p.returncode});log.close()

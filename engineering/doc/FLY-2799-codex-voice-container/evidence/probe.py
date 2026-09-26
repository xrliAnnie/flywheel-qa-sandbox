import os,json,subprocess,threading,queue,time,pathlib,hashlib,sys,signal
ROOT=pathlib.Path("/tmp/fly2799-probe")
BIN=ROOT/"standalone/bin/codex"
mode=sys.argv[1] if len(sys.argv)>1 else "default"
version=None if mode=="default" else mode
out=ROOT/(mode+".jsonl")
log=open(out,"w")
def record(direction,value):
    def safe(x):
        if isinstance(x,dict):
            return {k:({"bytes":len(v),"sha256":hashlib.sha256(v.encode()).hexdigest()} if k=="data" and isinstance(v,str) and len(v)>300 else safe(v)) for k,v in x.items() if k not in ("accessToken","idToken","refreshToken","apiKey","email","installationId")}
        if isinstance(x,list):return [safe(v) for v in x]
        return x
    row={"at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"direction":direction,"message":safe(value)}
    log.write(json.dumps(row,ensure_ascii=False)+"\n"); log.flush()
    print(json.dumps(row,ensure_ascii=False),flush=True)
env={k:v for k,v in os.environ.items() if k in ("HOME","PATH","TMPDIR","USER","LANG","SSL_CERT_FILE","SSL_CERT_DIR")}
env["CODEX_HOME"]=str(ROOT/"home");env["RUST_LOG"]="error"
p=subprocess.Popen([str(BIN),"app-server"],cwd=ROOT/"work",env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(ROOT/(mode+".stderr"),"w"),text=True,start_new_session=True)
q=queue.Queue();events=[];responses={};n=0;tid=None

def reader():
    for l in p.stdout:
        try:q.put(json.loads(l))
        except:record("nonjson",l[:1000])
threading.Thread(target=reader,daemon=True).start()
def send(x):
    record("send",x);p.stdin.write(json.dumps(x)+"\n");p.stdin.flush()
def poll(timeout):
    try:m=q.get(timeout=timeout)
    except queue.Empty:return None
    record("recv",m)
    if "id" in m and "method" not in m:responses[m["id"]]=m
    else:
        events.append(m)
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
    params={"threadId":tid,"outputModality":"audio","clientManagedHandoffs":True,"includeStartupContext":False,"prompt":"This is an isolated voice capability test. Speak briefly in English. Do not call tools or delegate. Wait silently for text or audio input.","transport":{"type":"websocket"}}
    if version:params["version"]=version
    rpc("thread/realtime/start",params)
    wait(8)
    rpc("thread/realtime/appendSpeech",{"threadId":tid,"text":"The purple lantern is ready."})
    wait(12)
    rpc("thread/realtime/appendText",{"threadId":tid,"text":"Say exactly: the silver kettle is warm.","role":"user"})
    wait(12)
    # Optional fixture is external PCM; if empty, only appended silence is sent.
    # In the recorded run macOS say produced empty PCM, so audio was silence only.
    pcm=ROOT/"input.pcm"
    if pcm.exists():
        import base64
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
    record("exit",{"returncode":p.returncode});log.close()

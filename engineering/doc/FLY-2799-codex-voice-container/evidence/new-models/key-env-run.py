import pathlib,re,shlex,os,subprocess,sys
key=None
for line in (pathlib.Path.home()/".flywheel/.env").read_text().splitlines():
 if re.match(r"(?:export\s+)?OPENAI_API_KEY\s*=",line):
  values=shlex.split(line.split("=",1)[1],comments=True)
  if len(values)!=1:raise SystemExit("Unsupported key source format")
  key=values[0]
if not key:raise SystemExit("Authorized voice key missing")
env={k:v for k,v in os.environ.items() if k in ["HOME","PATH","TMPDIR","LANG","SSL_CERT_FILE","SSL_CERT_DIR"]}
env["OPENAI_API_KEY"]=key;env["PYTHONPATH"]="/tmp/fly2799-probe/deps";env["CODEX_HOME"]="/tmp/fly2799-probe/home"
r=subprocess.run(sys.argv[1:],env=env);sys.exit(r.returncode)

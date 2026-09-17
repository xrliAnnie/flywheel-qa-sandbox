from pathlib import Path
import urllib.request, re, json, hashlib
p=Path(__file__).resolve().parent
publication=json.loads((p/'publication.json').read_text())
url=publication['url']
req=urllib.request.Request(url,headers={'User-Agent':'FLY-2616-design-verification'})
with urllib.request.urlopen(req,timeout=30) as r:
    status=r.status
    body=r.read().decode()
    header_csp=r.headers.get('Content-Security-Policy','')
assert status==200
assert '__CSP_NONCE__' not in body
scripts=list(re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script>',body))
assert len(scripts)==1
nonce_match=re.search(r'nonce=["\']([^"\']+)',scripts[0].group(1))
assert nonce_match
nonce=nonce_match.group(1)
local=(p.parent/'founder-design.html').read_text()
local_script=re.search(r'<script\b[^>]*>([\s\S]*?)</script>',local).group(1)
assert scripts[0].group(2)==local_script
local_body=re.search(r'<body\b[^>]*>([\s\S]*?)</body>',local).group(1)
hosted_body=re.search(r'<body\b[^>]*>([\s\S]*?)</body>',body).group(1)
assert hosted_body.replace(nonce,'__CSP_NONCE__')==local_body
assert 'FLY-2616' in body and '【页面意见汇总】FLY-2616' in body
assert 'nonce-'+nonce in (header_csp+body)
assert not re.search(r'\son[a-z]+\s*=|<script[^>]+src=|<link[^>]+href=|<img[^>]+src=["\']https?',body,re.I)
assert 'DIAGRAM PENDING LOCAL RENDER' in body
receipt={'httpStatus':status,'noncePlaceholderRemaining':False,'singleScript':True,'nonceMatchesCSP':True,'hostedScriptMatchesCommittedSource':True,'hostedBodyMatchesCommittedSource':True,'externalAssets':False,'commentMarkerPresent':True,'diagram':'PENDING LOCAL RENDER','browserQA':'NOT RUN: local Chromium denied','sourceSha256':hashlib.sha256(local.encode()).hexdigest(),'hostedSha256':hashlib.sha256(body.encode()).hexdigest(),'publishOnly':publication.get('publishOnly'),'delivered':publication.get('delivered'),'messageId':publication.get('messageId')}
(p/'hosted-verification.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False,indent=2))

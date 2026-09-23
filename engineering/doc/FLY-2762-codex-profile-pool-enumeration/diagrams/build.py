import re,sys,pathlib
d=pathlib.Path(__file__).parent
t=(d/'founder-design.template.html').read_text(encoding='utf-8')
def svg(n):
    s=(d/f'{n}.svg').read_text(encoding='utf-8')
    s=re.sub(r'<\?xml[^>]*\?>','',s)
    return s
review=(d/'review-section.html').read_text(encoding='utf-8')
out=t.replace('{{D1}}',svg('d1-flow')).replace('{{D2}}',svg('d2-token-state')).replace('{{D3}}',svg('d3-model')).replace('{{REVIEW}}',review)
assert '{{' not in out
(d.parent/'founder-design.html').write_text(out,encoding='utf-8')
print('written',len(out))

#!/usr/bin/env python3
"""Build design.html: inline locally rendered Mermaid SVGs + nonced comment script into the template."""
import pathlib, re
d = pathlib.Path(__file__).resolve().parent
html = (d / 'founder-template.html').read_text()
for key, name in (('D1', 'd1-flow'), ('D2', 'd2-commits'), ('D3', 'd3-review')):
    svg = (d / f'{name}.svg').read_text()
    svg = re.sub(r'^<\?xml[^>]*>\s*', '', svg)
    html = html.replace('{{%s}}' % key, svg)
html = html.replace('{{SCRIPT}}', (d / 'comment-layer.js.html').read_text().strip())
assert '{{' not in html
(d.parent / 'design.html').write_text(html)
print('wrote', d.parent / 'design.html', len(html))

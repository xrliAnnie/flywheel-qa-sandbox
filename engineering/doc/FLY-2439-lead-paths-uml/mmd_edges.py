"""从 .mmd 源码抽「箭头 → 依据」清单。自动生成 = 图与清单不可能漂移。"""
import os, re, html

_INDEX_ROOTS = [
    "/Users/xiaorongli/Dev/flywheel-FLY-2439/packages",
    "/Users/xiaorongli/Dev/flywheel-FLY-2439/scripts",
    "/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2439/"
    "c3b027ac-fdf0-4456-8243-1850e98105fd/scratchpad/raya-ro/apps",
    "/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2439/"
    "c3b027ac-fdf0-4456-8243-1850e98105fd/scratchpad/raya-ro/packages",
    "/Users/xiaorongli/.claude/plugins/cache/flywheel-plugins/discord/0.0.6",
]

REF = re.compile(r'[A-Za-z0-9_\-./@]+\.(?:ts|sh|js|mjs|json|md|toml)\b(?::[\d,\-: ]*\d)?|(?<![\w:]):\d[\d,\-]*\b')

def _clean(t):
    t = t.replace('<br/>', ' · ').replace('<br>', ' · ')
    t = re.sub(r'^[\["\'(]+|[\]"\')]+$', '', t.strip())
    return re.sub(r'\s+', ' ', t).strip()

def parse_flowchart(src):
    """返回 [(from, to, label)]，节点用其显示名。"""
    names = {}
    for m in re.finditer(r'^\s*([A-Za-z][\w]*)\s*(?:\[\[|\[\(|\(\[|\[|\(\(|\(|\{)(.+?)(?:\]\]|\)\]|\]\)|\]|\)\)|\)|\})\s*$', src, re.M):
        names[m.group(1)] = _clean(m.group(2))
    for m in re.finditer(r'^\s*subgraph\s+([A-Za-z][\w]*)\s*\[(.+?)\]\s*$', src, re.M):
        names[m.group(1)] = _clean(m.group(2))
    def nm(i): return names.get(i, i)
    edges = []
    pat = re.compile(
        r'^\s*([A-Za-z][\w]*)\s*'
        r'(-{2,3}>|-\.->|<-{2,3}>|-{3}|-\.-|-x|--o)'
        r'\s*(?:\|\s*(.+?)\s*\|)?\s*'
        r'([A-Za-z][\w]*)\s*$', re.M)
    for m in pat.finditer(src):
        a, arrow, lab, b = m.group(1), m.group(2), m.group(3), m.group(4)
        edges.append((nm(a), nm(b), _clean(lab or ''), arrow))
    return edges

def parse_sequence(src):
    edges = []
    aliases = {}
    for m in re.finditer(r'^\s*participant\s+(\w+)\s+as\s+(.+?)\s*$', src, re.M):
        aliases[m.group(1)] = _clean(m.group(2))
    for m in re.finditer(r'^\s*actor\s+(\w+)\s+as\s+(.+?)\s*$', src, re.M):
        aliases[m.group(1)] = _clean(m.group(2))
    def nm(i): return aliases.get(i, i)
    pat = re.compile(r'^\s*(\w+)\s*(->>|-->>|--\)|->|-->|-x|-\))\s*(\w+)\s*:\s*(.+?)\s*$', re.M)
    for m in pat.finditer(src):
        edges.append((nm(m.group(1)), nm(m.group(3)), _clean(m.group(4)), m.group(2)))
    for m in re.finditer(r'^\s*Note\s+(?:over|left of|right of)\s+([\w, ]+)\s*:\s*(.+?)\s*$', src, re.M):
        who = ', '.join(nm(x.strip()) for x in m.group(1).split(','))
        edges.append((who, '(注)', _clean(m.group(2)), 'note'))
    return edges

FILE = re.compile(r'[A-Za-z0-9_\-./@]+\.(?:ts|sh|js|mjs|json|md|toml)\b')

def refs_of(text):
    """抽 file:line。裸的 `:123` 用同一段文字里最近的前一个文件名补全,
    这样清单里的每个 chip 都自带文件名,不必回头看上下文。"""
    out, seen, last_file = [], set(), None
    for m in REF.finditer(text):
        tok = m.group(0).strip()
        fm = FILE.match(tok)
        if fm:
            last_file = fm.group(0)
            val = tok
        elif tok.startswith(':') and last_file:
            val = last_file + tok
        else:
            val = tok
        if val not in seen:
            seen.add(val); out.append(val)
    return out

# 已知文件名索引:节点标题常写成 `RestPollDiscordInboundSource<br/>… :7 · :121`,
# 其中的 `:7` 依据的就是那个同名文件。索引由真实仓库的 basename 建立,
# 所以这不是猜测 —— 索引里没有的名字一律不补。
_BASENAMES = None

def _basenames():
    global _BASENAMES
    if _BASENAMES is None:
        _BASENAMES = set()
        for root in _INDEX_ROOTS:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames
                               if d not in ("node_modules", ".git", "dist", "build")]
                for fn in filenames:
                    if fn.endswith((".ts", ".sh", ".mjs", ".js")):
                        _BASENAMES.add(fn)
    return _BASENAMES


def qualify_node_refs(node_text, refs):
    """把节点文字里的裸 `:NNN` 补成 `<Basename>.ts:NNN`,仅当该 basename 真实存在。"""
    head = re.match(r"\s*([A-Za-z][\w.\-]*)", node_text)
    if not head:
        return refs
    tok = head.group(1)
    cand = tok if "." in tok else None
    if cand is None:
        for ext in (".ts", ".sh", ".mjs", ".js"):
            if tok + ext in _basenames():
                cand = tok + ext
                break
    if cand is None or cand not in _basenames():
        return refs
    return [(cand + t if t.startswith(":") else t) for t in refs]


def ledger(mmd_path):
    src = open(mmd_path, encoding='utf-8').read()
    kind = 'sequence' if 'sequenceDiagram' in src.split('\n')[0] else 'flowchart'
    edges = parse_sequence(src) if kind == 'sequence' else parse_flowchart(src)
    rows = []
    for a, b, lab, arrow in edges:
        # 一跳的依据 = 边标签上的 file:line + 两端节点自带的 file:line。
        # 三者都没有才算「未验证」。
        rs, seen = [], set()
        for src_text, origin in ((lab, '边'), (a, '起点'), (b, '终点')):
            found = refs_of(src_text)
            if origin != '边':
                found = qualify_node_refs(src_text, found)
            for r in found:
                if r not in seen:
                    seen.add(r); rs.append((r, origin))
        rows.append({'from': a, 'to': b, 'label': lab, 'refs': rs,
                     'dashed': arrow in ('-.->', '-.-', '-x', '--)', '-)')})
    return rows

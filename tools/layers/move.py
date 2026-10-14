"""Moves source files and rewrites every relative import of src/, tests/ and tools/ that names them.
Usage: python3 tools/layers/move.py old.ts=new.ts [...]   (run from the repo root; then npx tsc)"""
import os, re, subprocess, sys

moves = dict(a.split('=') for a in sys.argv[1:])
SPEC = re.compile(r"""((?:from|import)\s*\(?\s*['"])(\.{1,2}/[^'"]+)(['"])""")

def resolve(frm, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(frm), spec))
    stem = base[:-3] if base.endswith('.js') else base
    for cand in (stem + '.ts', stem + '.tsx', base):
        if os.path.exists(cand) or cand in moves: return cand
    return None

def rel(frm, to):
    r = os.path.relpath(to, os.path.dirname(frm))
    r = r if r.startswith('.') else './' + r
    return re.sub(r'\.tsx?$', '.js', r)

files = [os.path.join(d, f) for root in ('src', 'tests', 'tools') for d, _, fs in os.walk(root) for f in fs if f.endswith(('.ts', '.tsx'))]
edits = {}
for path in files:
    src = open(path).read()
    new_path = moves.get(path, path)
    def fix(m):
        target = resolve(path, m.group(2))
        if target is None or (target not in moves and path not in moves): return m.group(0)
        return m.group(1) + rel(new_path, moves.get(target, target)) + m.group(3)
    out = SPEC.sub(fix, src)
    if out != src: edits[path] = out
for path, out in edits.items(): open(path, 'w').write(out)
for old, new in moves.items():
    os.makedirs(os.path.dirname(new), exist_ok=True)
    subprocess.run(['git', 'mv', old, new], check=True)
print(f'{len(moves)} moved, {len(edits)} files rewritten')

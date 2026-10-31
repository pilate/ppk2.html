#!/usr/bin/env python3
"""Build dist/ppk2.html: the app as one self-contained file.

ppk2.html in the repo root loads css/ and js/ as separate files, which needs a
web server (browsers won't load ES modules from file://). This script inlines
the stylesheet and bundles the modules into a single <script>, so the output
can be opened straight from disk or hosted as one file.

Each module becomes a function scope returning its exports, so top-level names
can't collide; imports become lookups on those export objects. This handles
the import/export forms the app uses and fails loudly on anything else.

Usage: python3 build.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'ppk2.html'
OUTPUT = ROOT / 'dist' / 'ppk2.html'

IMPORT_RE = re.compile(r"^import\s+(.+?)\s+from\s+'\./([\w-]+)\.js';\n", re.M | re.S)
EXPORT_DECL_RE = re.compile(r'^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)', re.M)


def module_var(name):
    return '__' + re.sub(r'\W', '_', name)


def load_module(name, modules, order):
    """Read js/<name>.js and its dependencies, appending to `order` dependencies-first."""
    if name in modules:
        if modules[name] is None:
            sys.exit(f'build: circular import involving {name}.js')
        return
    modules[name] = None
    src = (ROOT / 'js' / f'{name}.js').read_text(encoding='utf-8')

    bindings = []
    for clause, dep in IMPORT_RE.findall(src):
        load_module(dep, modules, order)
        clause = ' '.join(clause.split())
        if m := re.fullmatch(r'\*\s+as\s+(\w+)', clause):
            bindings.append(f'const {m[1]} = {module_var(dep)};')
        elif m := re.fullmatch(r'\{(.*)\}', clause):
            names = [n.strip() for n in m[1].split(',') if n.strip()]
            parts = [re.sub(r'^(\w+)\s+as\s+(\w+)$', r'\1: \2', n) for n in names]
            bindings.append(f'const {{ {", ".join(parts)} }} = {module_var(dep)};')
        else:
            sys.exit(f'build: unsupported import in {name}.js: import {clause}')
    body = IMPORT_RE.sub('', src)

    exports = EXPORT_DECL_RE.findall(body)
    body = re.sub(r'^export\s+(?=(?:async\s+)?(?:function|class|const|let)\b)', '', body, flags=re.M)
    if re.search(r'^\s*export\b', body, re.M):
        sys.exit(f'build: unsupported export form in {name}.js')

    modules[name] = (
        f'// ---- js/{name}.js\n'
        f'const {module_var(name)} = (() => {{\n'
        + ''.join(b + '\n' for b in bindings)
        + body.rstrip()
        + f'\nreturn {{ {", ".join(exports)} }};\n}})();\n'
    )
    order.append(name)


def main():
    html = SOURCE.read_text(encoding='utf-8')

    css_link = re.search(r'<link rel="stylesheet" href="css/([\w-]+\.css)"\s*/>', html)
    entry = re.search(r'<script type="module" src="js/([\w-]+)\.js"></script>', html)
    if not css_link or not entry:
        sys.exit('build: ppk2.html no longer has the expected stylesheet link or module script tag')

    css = (ROOT / 'css' / css_link[1]).read_text(encoding='utf-8')
    modules, order = {}, []
    load_module(entry[1], modules, order)
    js = '\n'.join(modules[n] for n in order)

    # Inline text must not close its own element early.
    css = css.replace('</style', '<\\/style')
    js = js.replace('</script', '<\\/script')

    html = html.replace(css_link[0], f'<style>\n{css}</style>')
    html = html.replace(entry[0], f'<script type="module">\n{js}</script>')

    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(html, encoding='utf-8')
    print(f'build: wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size / 1024:.0f} KiB, modules: {", ".join(order)})')


if __name__ == '__main__':
    main()

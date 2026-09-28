#!/usr/bin/env python3
"""Standalone .ipk builder for luci-app-netview -- no OpenWrt SDK required.

Metadata is read straight out of ./Makefile, so the Makefile stays the single
source of truth for the SDK build and this script alike.

ImmortalWrt / OpenWrt 24.10 ships packages in the *modern* layout, which is not
the old `ar` archive people usually expect:

    <name>_<version>-r<release>_<arch>.ipk
      = gzip( tar
                ./debian-binary     -> "2.0\n"
                ./data.tar.gz       -> the payload
                ./control.tar.gz    -> ./control, ./postinst, ./prerm
              )

Member names, member order, the tar dialect (GNU/ustar), the octal field
padding and the gzip header bytes were all replicated from packages published
in the ImmortalWrt 24.10.6 x86/64 feed, so the output is structurally identical
to what `make package/.../compile` produces.

Usage:
    python build-ipk.py                    # dist/luci-app-netview_1.0.0-r1_all.ipk
    python build-ipk.py -o /tmp/out.ipk
    python build-ipk.py --epoch 1780000000 # reproducible
    python build-ipk.py --list             # dry run, show the payload
"""

import argparse
import os
import re
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))

# Staging map, mirroring the Package/.../install rules in the Makefile:
#   root/   -> /      (OpenWrt convention)
#   htdocs/ -> /www   (LuCI convention)
MAPPINGS = (
    ('root', ''),
    ('htdocs', 'www'),
)


# --------------------------------------------------------------------- misc ---

def info(msg):
    sys.stdout.write(msg + '\n')


def die(msg):
    sys.stderr.write('error: %s\n' % msg)
    sys.exit(1)


# ------------------------------------------------------------- makefile read ---

def slurp(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return fh.read()


def mk_var(text, name, default=None):
    # leading whitespace allowed so variables inside a `define Package/...`
    # block (SECTION, CATEGORY, ...) are picked up as well
    m = re.search(r'^[ \t]*%s:?=[ \t]*(.*)$' % re.escape(name), text, re.M)
    return m.group(1).strip() if m else default


def mk_define(text, name):
    """Body of `define <name> ... endef` with make's $$ escaping undone.

    OpenWrt emits these defines through the shell, so a literal `$$` in the
    Makefile becomes a single `$` in the installed control script. Reproducing
    that here is what keeps the standalone build and the SDK build identical.
    """
    m = re.search(r'^define\s+%s\s*\n(.*?)^endef' % re.escape(name),
                  text, re.M | re.S)
    if not m:
        return None
    body = m.group(1).replace('$$', '$')
    return body if body.endswith('\n') else body + '\n'


def mk_define_lines(text, name):
    body = mk_define(text, name)
    if body is None:
        return None
    return [l.strip() for l in body.strip('\n').split('\n') if l.strip()]


def parse_depends(text, pkg):
    block = mk_define(text, 'Package/%s' % pkg)
    if block is None:
        die('Makefile: define Package/%s not found' % pkg)
    m = re.search(r'^\s*DEPENDS\s*:?=\s*(.*)$', block, re.M)
    if not m:
        return []
    out = []
    for tok in m.group(1).split():
        tok = re.sub(r'\(.*\)$', '', tok.strip().lstrip('+'))
        if tok:
            out.append(tok)
    return out


# ---------------------------------------------------------------- tar writer ---
#
# Hand-rolled instead of tarfile so the field encoding matches GNU tar exactly:
#   mode/uid/gid  -> 7 octal digits + NUL       ("0000644\0")
#   size/mtime    -> 11 octal digits + NUL      ("00000000004\0")
#   checksum      -> 6 octal digits + NUL + sp  ("010527\0 ")
#   magic/version -> "ustar " + " \0"           (old-GNU dialect)
# Python's tarfile uses NUL padding instead of zero padding, which is legal but
# does not match what OpenWrt emits.

def _octal(value, width):
    body = ('%0*o' % (width - 1, value)).encode('ascii')
    if len(body) > width - 1:
        die('tar field overflow: %r does not fit in %d bytes' % (value, width))
    return body + b'\0'


def _tar_header(name, size, mode, typeflag, mtime):
    name_b = name.encode('utf-8')
    if len(name_b) > 100:
        die('path too long for ustar (>100 bytes): %s' % name)
    h = bytearray(512)
    h[0:len(name_b)] = name_b
    h[100:108] = _octal(mode, 8)          # mode
    h[108:116] = _octal(0, 8)             # uid
    h[116:124] = _octal(0, 8)             # gid
    h[124:136] = _octal(size, 12)         # size
    h[136:148] = _octal(mtime, 12)        # mtime
    h[148:156] = b' ' * 8                 # checksum placeholder
    h[156:157] = typeflag                 # b'0' file, b'5' dir
    h[257:263] = b'ustar '                # magic
    h[263:265] = b' \0'                   # version
    h[148:156] = ('%06o' % sum(h)).encode('ascii') + b'\0 '
    return bytes(h)


def build_tar(entries, mtime):
    """entries: iterable of (name, mode, typeflag, payload-or-None)."""
    out = bytearray()
    for name, mode, typeflag, payload in entries:
        payload = payload or b''
        out += _tar_header(name, len(payload), mode, typeflag, mtime)
        if typeflag == b'0' and payload:
            out += payload
            pad = (-len(payload)) % 512
            if pad:
                out += b'\0' * pad
    out += b'\0' * 1024                   # two zero blocks terminate the archive
    return bytes(out)


def gzip_bytes(data, level=6):
    """gzip with the header byte-for-byte identical to OpenWrt's output.

    zlib hardcodes MTIME=0 and XFL=0 for level 6, which lines up with the
    "1f 8b 08 00 00 00 00 00 00 03" preamble every feed package starts with.
    The trailing OS byte is the one exception: zlib stamps it with the platform
    it was built for (0x03 on Unix, 0x0a on Windows), which would make the same
    sources produce different bytes depending on where the build runs. Force it
    back to Unix so the artefact is identical either way.
    """
    co = zlib.compressobj(level, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    out = bytearray(co.compress(data) + co.flush())
    if out[0:3] == b'\x1f\x8b\x08' and out[3] == 0:
        out[9] = 0x03           # FLG == 0, so the header is exactly 10 bytes
    return bytes(out)


# ------------------------------------------------------------------ staging ---

def mode_for(path):
    """0755 for executables, 0644 otherwise.

    This has to be rule based rather than read off the filesystem: the package
    is authored on Windows, where the execute bit does not exist.
    """
    if '/usr/libexec/' in path or path.endswith('.sh'):
        return 0o755
    return 0o644


def scan_payload():
    files = {}
    for src_dir, dest_prefix in MAPPINGS:
        base = os.path.join(HERE, src_dir)
        if not os.path.isdir(base):
            continue
        for cur, dirs, names in os.walk(base):
            dirs.sort()
            for fn in sorted(names):
                full = os.path.join(cur, fn)
                rel = os.path.relpath(full, base).replace(os.sep, '/')
                dest = '%s/%s' % (dest_prefix, rel) if dest_prefix else rel
                with open(full, 'rb') as fh:
                    files[dest] = fh.read()
    return files


def payload_entries(files):
    """Depth-first, alphabetically interleaved dirs/files -- the exact order
    ipkg-build walks the staging tree."""
    dirs = set()
    for dest in files:
        parts = dest.split('/')
        for i in range(1, len(parts)):
            dirs.add('/'.join(parts[:i]))

    entries = [('./', 0o755, b'5', None)]

    def emit(prefix):
        kids = {}
        for d in dirs:
            if d.rpartition('/')[0] == prefix:
                kids[d.rsplit('/', 1)[-1]] = ('d', d)
        for f in files:
            if f.rpartition('/')[0] == prefix:
                kids[f.rsplit('/', 1)[-1]] = ('f', f)
        for name in sorted(kids):
            kind, path = kids[name]
            if kind == 'd':
                entries.append(('./' + path + '/', 0o755, b'5', None))
                emit(path)
            else:
                entries.append(('./' + path, mode_for('/' + path), b'0',
                                files[path]))

    emit('')
    return entries


# ------------------------------------------------------------------ control ---

def parse_epoch(makefile, override):
    """Newest source mtime, so the package looks naturally dated while still
    being byte-reproducible for unchanged sources."""
    if override is not None:
        return int(override)
    env = os.environ.get('SOURCE_DATE_EPOCH')
    if env and env.isdigit():
        return int(env)
    newest = 0
    for cur, dirs, names in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in ('.git', 'dist', '__pycache__')]
        for fn in names:
            try:
                newest = max(newest, int(os.path.getmtime(os.path.join(cur, fn))))
            except OSError:
                pass
    return newest or 1759000000


def render_control(meta, installed_size):
    lines = [
        'Package: %s' % meta['name'],
        'Version: %s-r%s' % (meta['version'], meta['release']),
        'Depends: libc, %s' % ', '.join(meta['depends']),
        'Source: package/%s' % meta['name'],
        'SourceName: %s' % meta['name'],
    ]
    if meta['license']:
        lines.append('License: %s' % meta['license'])
    lines.append('Section: %s' % meta['section'])
    lines.append('SourceDateEpoch: %d' % meta['epoch'])
    if meta['maintainer']:
        lines.append('Maintainer: %s' % meta['maintainer'])
    lines.append('Architecture: %s' % meta['arch'])
    lines.append('Installed-Size: %d' % installed_size)
    # Match OpenWrt's field style: two spaces after the colon on the synopsis,
    # one leading space on every continuation line.
    desc = meta['description']
    lines.append('Description:  %s' % desc[0])
    for extra in desc[1:]:
        lines.append(' %s' % extra)
    return '\n'.join(lines) + '\n'


def control_entries(control_text, makefile, pkg):
    entries = [('./', 0o755, b'5', None),
               ('./control', 0o644, b'0', control_text.encode('utf-8'))]
    for script in ('postinst', 'prerm'):
        body = mk_define(makefile, 'Package/%s/%s' % (pkg, script))
        if body:
            entries.append(('./' + script, 0o755, b'0', body.encode('utf-8')))
    return entries


# ------------------------------------------------------------------- verify ---

def verify(blob, meta):
    """Re-open the result with the stock tarfile module and check the shape."""
    import gzip as _gzip
    import io as _io
    import tarfile as _tarfile

    problems = []
    if blob[:10] != b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03':
        problems.append('outer gzip preamble %r is not the Unix one the feed uses'
                        % blob[:10])
    outer = _tarfile.open(fileobj=_io.BytesIO(_gzip.decompress(blob)))
    names = outer.getnames()
    expect = ['./debian-binary', './data.tar.gz', './control.tar.gz']
    if names != expect:
        problems.append('outer members %r != %r' % (names, expect))

    debian = outer.extractfile('./debian-binary').read()
    if debian != b'2.0\n':
        problems.append('debian-binary = %r, expected b"2.0\\n"' % debian)

    ctf = _tarfile.open(fileobj=_io.BytesIO(outer.extractfile('./control.tar.gz').read()))
    control = ctf.extractfile('./control').read().decode()
    declared = {}
    for line in control.split('\n'):
        if ': ' in line:
            k, v = line.split(': ', 1)
            declared[k] = v
    if declared.get('Package') != meta['name']:
        problems.append('control Package = %r' % declared.get('Package'))

    dtf = _tarfile.open(fileobj=_io.BytesIO(outer.extractfile('./data.tar.gz').read()))
    raw_data = _gzip.decompress(outer.extractfile('./data.tar.gz').read())
    if declared.get('Installed-Size') != str(len(raw_data)):
        problems.append('Installed-Size %s != uncompressed data.tar %d'
                        % (declared.get('Installed-Size'), len(raw_data)))

    for required in ('/usr/libexec/rpcd/netview',
                     '/www/luci-static/resources/view/netview/overview.js',
                     '/usr/share/rpcd/acl.d/luci-app-netview.json',
                     '/usr/share/luci/menu.d/luci-app-netview.json'):
        hit = [m for m in dtf.getmembers() if m.name == '.' + required]
        if not hit:
            problems.append('payload missing %s' % required)
        elif hit[0].mode & 0o111 and not required.endswith('netview'):
            problems.append('%s unexpectedly executable' % required)

    return problems, sorted(m.name for m in dtf.getmembers() if m.isfile()), control


# --------------------------------------------------------------------- main ---

def main():
    ap = argparse.ArgumentParser(description='Build luci-app-netview .ipk')
    ap.add_argument('-o', '--output', help='output path')
    ap.add_argument('--epoch', type=int, help='SOURCE_DATE_EPOCH (reproducible build)')
    ap.add_argument('--list', action='store_true', help='dry run: list the payload')
    args = ap.parse_args()

    path = os.path.join(HERE, 'Makefile')
    if not os.path.exists(path):
        die('Makefile not found next to this script (%s)' % path)
    makefile = slurp(path)

    name = mk_var(makefile, 'PKG_NAME')
    version = mk_var(makefile, 'PKG_VERSION')
    release = mk_var(makefile, 'PKG_RELEASE', '1')
    if not name or not version:
        die('PKG_NAME / PKG_VERSION missing from Makefile')

    description = mk_define_lines(makefile, 'Package/%s/description' % name) or ['']
    meta = {
        'name': name,
        'version': version,
        'release': release,
        'arch': 'all',
        'section': mk_var(makefile, 'SECTION', 'luci') or 'luci',
        'license': mk_var(makefile, 'PKG_LICENSE'),
        'maintainer': mk_var(makefile, 'PKG_MAINTAINER'),
        'depends': parse_depends(makefile, name),
        'description': description,
        'epoch': parse_epoch(makefile, args.epoch),
    }

    files = scan_payload()
    if not files:
        die('nothing to package -- are root/ and htdocs/ present?')

    if args.list:
        info('%s_%s-r%s_%s.ipk  ->  %d files' %
             (meta['name'], meta['version'], meta['release'], meta['arch'], len(files)))
        for f in sorted(files):
            info('  %-58s %6d  %04o' % ('./' + f, len(files[f]), mode_for('/' + f)))
        info('Depends: libc, ' + ', '.join(meta['depends']))
        return

    mtime = meta['epoch']
    data_tar = build_tar(payload_entries(files), mtime)
    meta['installed_size'] = len(data_tar)

    control_text = render_control(meta, len(data_tar))
    control_tar = build_tar(control_entries(control_text, makefile, name), mtime)

    outer = build_tar([
        ('./debian-binary', 0o644, b'0', b'2.0\n'),
        ('./data.tar.gz', 0o644, b'0', gzip_bytes(data_tar)),
        ('./control.tar.gz', 0o644, b'0', gzip_bytes(control_tar)),
    ], mtime)
    blob = gzip_bytes(outer)

    out = args.output or os.path.join(
        HERE, 'dist', '%s_%s-r%s_%s.ipk'
        % (meta['name'], meta['version'], meta['release'], meta['arch']))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'wb') as fh:
        fh.write(blob)

    problems, packed, control = verify(blob, meta)

    info('built %s' % os.path.abspath(out))
    info('  size           %d bytes' % len(blob))
    info('  Installed-Size %d bytes (uncompressed data.tar, as OpenWrt reports it)'
         % meta['installed_size'])
    info('  payload        %d files' % len(packed))
    info('')
    info('--- control ---')
    info(control.rstrip('\n'))
    info('--- payload ---')
    for p in packed:
        info('  ' + p)
    info('')

    if problems:
        info('SELF-CHECK FAILED:')
        for p in problems:
            info('  * ' + p)
        sys.exit(1)
    info('self-check passed (structure, member order, Installed-Size, payload paths)')


if __name__ == '__main__':
    main()

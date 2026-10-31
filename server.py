#!/usr/bin/env python3
"""NomadOS Rig Animator server.

Layout:
    app/                        the editor (static)
    projects/<name>/            one folder per project
        project.json            rig, bindings, animations
        <source>.psb            the imported art file
        export/<name>.*         Spine JSON/atlas/PNG + Unity JSON

Endpoints:
    GET  /app/…                 static editor
    GET  /projects/…            static project files
    GET  /api/projects          [{name, modified}] for every saved project
    POST /api/save/<proj>/<rel> write a file inside that project's folder

Optional game mirror: start with a second argument (or GAME_RIGS env var)
pointing at a folder inside your game project, e.g.

    python3 server.py 8231 ~/MyGame/ArtSrc/rigs

and every file exported by project <name> is also copied to
<game-rigs>/<name>/, so pressing Export drops the rig straight into the
game, ready for RigImporter.cs.
"""
import json
import os
import re
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(ROOT, 'projects')
GAME_RIGS = os.environ.get('GAME_RIGS', '')
NAME_RE = re.compile(r'^[a-z0-9_-]{1,64}$')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            self.send_response(302)
            self.send_header('Location', '/app/')
            self.end_headers()
            return
        if self.path.split('?')[0] == '/api/projects':
            out = []
            if os.path.isdir(PROJECTS):
                for name in sorted(os.listdir(PROJECTS)):
                    pj = os.path.join(PROJECTS, name, 'project.json')
                    if os.path.isfile(pj):
                        out.append({'name': name, 'modified': int(os.path.getmtime(pj))})
            self.send_json(out)
            return
        super().do_GET()

    def do_POST(self):
        m = re.match(r'^/api/save/([^/]+)/(.+)$', self.path)
        if not m:
            self.send_error(404)
            return
        # the browser URL-encodes the path; decode it or a PSB named with
        # spaces/accents is written under its percent-encoded name and can
        # never be fetched back (GET decodes, so the names diverge)
        proj, rel = urllib.parse.unquote(m.group(1)), urllib.parse.unquote(m.group(2))
        if not NAME_RE.match(proj):
            self.send_error(400, 'project name must be [a-z0-9_-]')
            return
        target = os.path.realpath(os.path.join(PROJECTS, proj, rel))
        if not target.startswith(os.path.realpath(PROJECTS) + os.sep):
            self.send_error(403, 'writes are restricted to projects/')
            return
        length = int(self.headers.get('Content-Length', 0))
        if length > 512 * 1024 * 1024:
            self.send_error(413)
            return
        data = self.rfile.read(length)

        # Conflict guard for project.json: reject a save from a tab that
        # loaded before someone else's save, instead of last-writer-wins.
        if rel == 'project.json' and 'X-Force' not in self.headers:
            base = self.headers.get('X-Base-Mtime')
            if base is not None and os.path.isfile(target):
                current = int(os.path.getmtime(target))
                if current > int(base):
                    self.send_json({'conflict': True, 'mtime': current}, code=409)
                    return

        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(data)
        self.mirror_to_game(proj, rel, data)
        self.send_json({'saved': os.path.relpath(target, ROOT), 'bytes': len(data),
                        'mtime': int(os.path.getmtime(target))})

    def mirror_to_game(self, proj, rel, data):
        # Exports also land in the game's rig folder, named by project:
        # projects/grunt/export/grunt.unity.json -> <GAME_RIGS>/grunt/...
        if not GAME_RIGS or not rel.startswith('export/'):
            return
        filename = os.path.basename(rel)
        # .unity.json/.png feed Weld All Rigs; .json/.atlas feed spine_bake.py
        if not filename.endswith(('.unity.json', '.png', '.json', '.atlas')):
            return
        target = os.path.join(GAME_RIGS, proj, filename)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(data)
        print(f'mirrored {filename} -> {proj}/{filename}', flush=True)

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith(('POST', '4', '5')):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8231
    if len(sys.argv) > 2:
        GAME_RIGS = os.path.abspath(sys.argv[2])
    os.makedirs(PROJECTS, exist_ok=True)
    print(f'NomadOS Rig Animator: http://127.0.0.1:{port}/app/ (projects in {PROJECTS})')
    if GAME_RIGS:
        print(f'mirroring exports -> {GAME_RIGS}/<project>/')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()

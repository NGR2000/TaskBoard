#!/usr/bin/env python3
"""ローカル検証用の「Supabase もどき」。

本物の Supabase を触らずに、tools/*.py・クルー用アプリ・管理画面を通しで試すためのもの。

  - /rest/v1/*    … 本物の PostgREST へそのまま中継する（RLS も schema.sql のものがそのまま効く）
  - /auth/v1/*    … メールとパスワードでログインして JWT を返すだけの最小実装
  - /storage/v1/* … 画像をローカルのディレクトリに置く最小実装。書き込み権限は
                    PostgREST の rpc/is_admin で本番と同じ判定をする

起動は tests/local/start.sh から。単体で使う時:
  python3 fake_supabase.py --port 54321 --postgrest http://127.0.0.1:54330 \
      --secret <JWT秘密鍵> --files /tmp/tb-files --user admin@example.com:pass
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
USERS = {}


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def make_jwt(claims, secret):
    header = b64url(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    body = b64url(json.dumps(claims).encode())
    sig = hmac.new(secret.encode(), (header + '.' + body).encode(), hashlib.sha256).digest()
    return header + '.' + body + '.' + b64url(sig)


def read_jwt(token, secret):
    try:
        header, body, sig = token.split('.')
        expected = b64url(hmac.new(secret.encode(), (header + '.' + body).encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        return json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
    except Exception:
        return None


def anon_key(secret):
    return make_jwt({'role': 'anon', 'iss': 'fake-supabase'}, secret)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if os.environ.get('FAKE_SUPABASE_LOG'):
            super().log_message(fmt, *args)

    # ------------------------------------------------------------------
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Expose-Headers', '*')

    def reply(self, code, obj=None, raw=None, ctype='application/json', headers=None):
        data = raw if raw is not None else (b'' if obj is None else json.dumps(obj).encode())
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''

    def bearer(self):
        auth = self.headers.get('Authorization', '')
        return auth[7:] if auth.startswith('Bearer ') else ''

    def do_OPTIONS(self):
        self.reply(204)

    def do_GET(self): self.route()
    def do_HEAD(self): self.route()
    def do_POST(self): self.route()
    def do_PATCH(self): self.route()
    def do_PUT(self): self.route()
    def do_DELETE(self): self.route()

    def route(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith('/rest/v1/'):
            return self.proxy_rest()
        if path.startswith('/auth/v1/'):
            return self.auth(path[len('/auth/v1/'):])
        if path.startswith('/storage/v1/'):
            return self.storage(urllib.parse.unquote(path[len('/storage/v1/'):]))
        self.reply(404, {'message': 'not found'})

    # ------------------------------------------------------------------
    def proxy_rest(self):
        url = ARGS.postgrest + self.path[len('/rest/v1'):]
        data = self.body() if self.command in ('POST', 'PATCH', 'PUT', 'DELETE') else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() in ('authorization', 'content-type', 'prefer', 'accept', 'range', 'range-unit',
                                    'accept-profile', 'content-profile')}
        if not self.bearer():
            headers['Authorization'] = 'Bearer ' + anon_key(ARGS.secret)
        req = urllib.request.Request(url, data=data, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req) as res:
                code, payload, h = res.status, res.read(), res.headers
        except urllib.error.HTTPError as e:
            code, payload, h = e.code, e.read(), e.headers
        extra = {k: v for k, v in h.items() if k.lower() in ('content-range', 'preference-applied')}
        self.reply(code, raw=payload, ctype=h.get('Content-Type', 'application/json'), headers=extra)

    # ------------------------------------------------------------------
    def session_for(self, email):
        now = int(time.time())
        user_id = str(uuid.uuid5(uuid.NAMESPACE_URL, email))
        token = make_jwt({'role': 'authenticated', 'email': email, 'sub': user_id, 'aud': 'authenticated',
                          'iat': now, 'exp': now + 3600}, ARGS.secret)
        user = {'id': user_id, 'email': email, 'aud': 'authenticated', 'role': 'authenticated',
                'app_metadata': {}, 'user_metadata': {}, 'created_at': '2026-01-01T00:00:00Z'}
        return {'access_token': token, 'token_type': 'bearer', 'expires_in': 3600, 'expires_at': now + 3600,
                'refresh_token': 'refresh-' + email, 'user': user}

    def auth(self, sub):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if sub == 'token' and self.command == 'POST':
            body = json.loads(self.body() or b'{}')
            grant = (query.get('grant_type') or [''])[0]
            if grant == 'password':
                email = str(body.get('email', '')).lower()
                if USERS.get(email) != body.get('password'):
                    return self.reply(400, {'error': 'invalid_grant', 'error_description': 'Invalid login credentials'})
                return self.reply(200, self.session_for(email))
            if grant == 'refresh_token':
                email = str(body.get('refresh_token', '')).replace('refresh-', '', 1)
                if email in USERS:
                    return self.reply(200, self.session_for(email))
            return self.reply(400, {'error': 'invalid_grant'})
        if sub == 'user' and self.command == 'GET':
            claims = read_jwt(self.bearer(), ARGS.secret)
            if not claims or claims.get('role') != 'authenticated':
                return self.reply(401, {'message': 'invalid token'})
            return self.reply(200, self.session_for(claims['email'])['user'])
        if sub == 'logout':
            return self.reply(204)
        if sub == 'recover':
            return self.reply(200, {})
        self.reply(404, {'message': 'not implemented in fake: ' + sub})

    # ------------------------------------------------------------------
    def is_admin(self):
        token = self.bearer()
        claims = read_jwt(token, ARGS.secret)
        if not claims or claims.get('role') != 'authenticated':
            return False
        req = urllib.request.Request(ARGS.postgrest + '/rpc/is_admin', data=b'{}', method='POST',
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read()) is True

    def file_path(self, name):
        full = os.path.normpath(os.path.join(ARGS.files, name))
        if not full.startswith(os.path.normpath(ARGS.files) + os.sep):
            raise ValueError('bad path')
        return full

    def storage(self, sub):
        # 公開 URL: object/public/<bucket>/<path>
        if sub.startswith('object/public/') and self.command in ('GET', 'HEAD'):
            name = sub[len('object/public/'):]
            try:
                full = self.file_path(name)
            except ValueError:
                return self.reply(400, {'message': 'bad path'})
            if not os.path.isfile(full):
                return self.reply(404, {'message': 'Object not found'})
            with open(full, 'rb') as fh:
                data = fh.read()
            meta = {}
            if os.path.exists(full + '.meta'):
                with open(full + '.meta') as fh:
                    meta = json.load(fh)
            return self.reply(200, raw=data, ctype=meta.get('type', 'application/octet-stream'),
                              headers={'Cache-Control': meta.get('cache', 'max-age=3600')})

        if sub.startswith('object/') and self.command in ('POST', 'PUT'):
            name = sub[len('object/'):]
            data = self.body()
            if not self.is_admin():
                return self.reply(403, {'statusCode': '403', 'error': 'Unauthorized',
                                        'message': 'new row violates row-level security policy'})
            full = self.file_path(name)
            if os.path.exists(full) and self.headers.get('x-upsert', 'false') != 'true':
                return self.reply(409, {'statusCode': '409', 'error': 'Duplicate', 'message': 'The resource already exists'})
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'wb') as fh:
                fh.write(data)
            with open(full + '.meta', 'w') as fh:
                json.dump({'type': self.headers.get('Content-Type', 'application/octet-stream'),
                           'cache': self.headers.get('Cache-Control') or 'max-age=3600'}, fh)
            return self.reply(200, {'Key': name, 'Id': str(uuid.uuid4())})

        if sub.startswith('object/') and self.command == 'DELETE':
            bucket = sub[len('object/'):].strip('/')
            body = json.loads(self.body() or b'{}')
            if not self.is_admin():
                return self.reply(200, [])  # 本番も権限が無いと「0件削除」になる
            removed = []
            for p in body.get('prefixes', []):
                full = self.file_path(bucket + '/' + p)
                if os.path.isfile(full):
                    os.remove(full)
                    if os.path.exists(full + '.meta'):
                        os.remove(full + '.meta')
                    removed.append({'name': p})
            return self.reply(200, removed)

        self.reply(404, {'message': 'not implemented in fake: ' + sub})


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=54321)
    ap.add_argument('--postgrest', required=True)
    ap.add_argument('--secret', required=True)
    ap.add_argument('--files', required=True)
    ap.add_argument('--user', action='append', default=[], metavar='EMAIL:PASSWORD')
    ap.add_argument('--print-anon-key', action='store_true')
    ARGS = ap.parse_args()
    if ARGS.print_anon_key:
        print(anon_key(ARGS.secret))
        return
    for u in ARGS.user:
        email, password = u.split(':', 1)
        USERS[email.lower()] = password
    os.makedirs(ARGS.files, exist_ok=True)
    ThreadingHTTPServer(('127.0.0.1', ARGS.port), Handler).serve_forever()


if __name__ == '__main__':
    main()

"""TaskBoard の Supabase に読み書きする小さなクライアント（標準ライブラリのみ）。

tools/publish.py・taskboard_state.py・migrate_from_gas.py が共通で使う。

接続先（URL と anon キー）は docs/config.js から読む。どちらも公開前提の値で、
anon キーだけでは読み取りしかできない（書き込みは schema.sql の RLS で管理者に限っている）。

書き込みはボット用メンバーでログインして行う:
  TASKBOARD_BOT_EMAIL / TASKBOARD_BOT_PASSWORD
全権限を持つ service_role キーは使わない。RLS と変更履歴がボットにも効くようにするため。
"""

import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_JS = os.path.join(ROOT, 'docs', 'config.js')
BUCKET = 'taskboard'


def die(message):
    print('エラー: ' + message, file=sys.stderr)
    sys.exit(1)


def _config_value(name):
    try:
        with open(CONFIG_JS, encoding='utf-8') as fh:
            m = re.search(name + r'\s*:\s*"([^"]*)"', fh.read())
            return m.group(1) if m else ''
    except OSError:
        return ''


def safe_segment(text):
    """Storage のパスに使える形にする。フライトキーには日本語が入り得るため
    （例: 2022年スロベニア初日）、英数字以外を含む時は UTF-8 の16進にする。
    docs/admin/index.html の safeSegment と同じ規則。"""
    text = str(text)
    if re.fullmatch(r'[A-Za-z0-9_.-]+', text):
        return text
    return 'x-' + text.encode('utf-8').hex()


def new_version():
    return secrets.token_hex(4)


def original_path(key, page):
    return 'originals/%s/%d-%s.jpg' % (safe_segment(key), page, new_version())


def sketch_paths(key, task_no):
    base = 'sketches/%s/%s-%s' % (safe_segment(key), safe_segment(task_no), new_version())
    return base + '.jpg', base + '-thumb.jpg'


def slugify(label):
    """GAS 版（コード.js の slugify_）と同じ規則でキーを作る。"""
    s = re.sub(r'[^a-z0-9぀-ヿ一-鿿]+', '-', str(label or '').lower()).strip('-')
    return s or 'flight-' + secrets.token_hex(4)


def suggest_label(parsed):
    """JSON の中身からラベル案を作る（例: "Flight 3 (#8-#12)"）。GAS 版と同じ。"""
    flight_no, tasks = '', ''
    for f in (parsed.get('basicInfo') or {}).get('fields') or []:
        label = str(f.get('label') or '').lower()
        if label in ('flight', 'flight no'):
            flight_no = f.get('value') or ''
        if label == 'tasks':
            tasks = f.get('value') or ''
    if flight_no:
        return 'Flight %s%s' % (flight_no, ' (%s)' % tasks if tasks else '')
    import datetime
    return 'Flight ' + datetime.datetime.now().strftime('%Y/%m/%d %H:%M')


class Client:
    def __init__(self, url='', anon_key=''):
        self.url = (url or os.environ.get('TASKBOARD_SUPABASE_URL') or _config_value('supabaseUrl')).rstrip('/')
        self.anon_key = anon_key or os.environ.get('TASKBOARD_SUPABASE_ANON_KEY') or _config_value('supabaseAnonKey')
        if not self.url or not self.anon_key:
            die('Supabase の接続先が分かりません。docs/config.js の supabaseUrl / supabaseAnonKey を設定してください。')
        self.token = None
        self.email = None

    # ------------------------------------------------------------------
    def _request(self, method, url, body=None, headers=None, raw=False, content_type='application/json'):
        h = {'apikey': self.anon_key, 'Authorization': 'Bearer ' + (self.token or self.anon_key)}
        if body is not None:
            h['Content-Type'] = content_type
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        h.update(headers or {})
        req = urllib.request.Request(url, data=body, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                data = res.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:500]
            if e.code in (401, 403) or 'row-level security' in detail:
                die('権限がありません（%d）。ボットのアカウントが admins 表に入っているか確認してください: %s' % (e.code, detail))
            die('Supabase が %d を返しました（%s %s）: %s' % (e.code, method, url.split('?')[0], detail))
        except urllib.error.URLError as e:
            die('Supabase に接続できませんでした: %s' % e.reason)
        if raw:
            return data
        return json.loads(data) if data else None

    def login(self, email='', password=''):
        email = email or os.environ.get('TASKBOARD_BOT_EMAIL', '')
        password = password or os.environ.get('TASKBOARD_BOT_PASSWORD', '')
        if not email or not password:
            die('書き込みにはログインが必要です。環境変数 TASKBOARD_BOT_EMAIL / TASKBOARD_BOT_PASSWORD を設定してください'
                '（チャットには貼らず、Claude Code の環境設定に入れる）。')
        req = urllib.request.Request(
            self.url + '/auth/v1/token?grant_type=password',
            data=json.dumps({'email': email, 'password': password}).encode('utf-8'),
            headers={'apikey': self.anon_key, 'Content-Type': 'application/json'},
            method='POST')
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                out = json.loads(res.read())
        except urllib.error.HTTPError as e:
            die('ログインできませんでした（%d）。TASKBOARD_BOT_EMAIL / TASKBOARD_BOT_PASSWORD を確認してください: %s'
                % (e.code, e.read().decode('utf-8', 'replace')[:300]))
        except urllib.error.URLError as e:
            die('Supabase に接続できませんでした: %s' % e.reason)
        self.token = out['access_token']
        self.email = email
        return self

    # ------------------------------------------------------------------
    # テーブル（PostgREST）
    def select(self, table, query=''):
        return self._request('GET', '%s/rest/v1/%s?%s' % (self.url, table, query))

    def insert(self, table, row, upsert=False):
        prefer = 'return=representation' + (',resolution=merge-duplicates' if upsert else '')
        return self._request('POST', '%s/rest/v1/%s' % (self.url, table), row, {'Prefer': prefer})

    def update(self, table, query, patch):
        """RLS で弾かれた更新はエラーにならず「0行更新」で返ってくる。
        黙って成功扱いにしないよう、対象の行があるのに0行だった時は止める。"""
        rows = self._request('PATCH', '%s/rest/v1/%s?%s' % (self.url, table, query), patch,
                             {'Prefer': 'return=representation'})
        if not rows:
            if self.select(table, 'select=*&limit=1&' + query):
                die('更新できませんでした。%s が admins 表に入っているか確認してください。' % (self.email or 'このアカウント'))
            die('対象が見つかりません（%s: %s）' % (table, urllib.parse.unquote(query)))
        return rows

    def delete(self, table, query):
        return self._request('DELETE', '%s/rest/v1/%s?%s' % (self.url, table, query), None,
                             {'Prefer': 'return=representation'})

    # ------------------------------------------------------------------
    # 画像（Storage）
    def upload(self, path, data, content_type='image/jpeg'):
        # 同じパスへの上書きはしない（パスに版が入っていて、中身が変わらない前提で長期キャッシュさせるため）
        self._request('POST', '%s/storage/v1/object/%s/%s' % (self.url, BUCKET, urllib.parse.quote(path)),
                      bytes(data), {'Cache-Control': 'max-age=31536000', 'x-upsert': 'false'},
                      content_type=content_type)
        return path

    def remove(self, paths):
        paths = [p for p in paths if p]
        if paths:
            self._request('DELETE', '%s/storage/v1/object/%s' % (self.url, BUCKET), {'prefixes': paths})

    def public_url(self, path):
        return '%s/storage/v1/object/public/%s/%s' % (self.url, BUCKET, urllib.parse.quote(path))

    def download(self, path):
        return self._request('GET', self.public_url(path), raw=True)


def eq(value):
    """PostgREST のフィルタ値。キーに日本語や記号が入っても壊れないようにする。"""
    return 'eq.' + urllib.parse.quote(str(value), safe='')

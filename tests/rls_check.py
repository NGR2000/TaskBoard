#!/usr/bin/env python3
"""本番（または docs/config.js が指す）Supabase で、権限が意図どおりか確かめる。

  python3 tests/rls_check.py

確かめること:
  - ログインしなくても（クルー用アプリと同じ anon キーで）一覧・スケッチは読める
  - ログインしないと書き込めない（フライト・画像とも）
  - ログインしないと変更履歴と管理者の一覧は読めない
  - ボット（管理者）は書き込めて、変更履歴に名前が残る
  - 管理者でないアカウントは書き込めない（TASKBOARD_NONADMIN_EMAIL / _PASSWORD がある時だけ）

確認用のフライト（rls-check-...）を1件作って最後に消す。変更履歴にはその記録が残る。
"""
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))
from taskboard_db import BUCKET, Client, eq  # noqa: E402

failures = []


def check(ok, what):
    print(('✅ ' if ok else '❌ ') + what)
    if not ok:
        failures.append(what)


def raw(db, method, path, body=None, token=None, headers=None):
    """エラーでも止まらずに (status, 本文) を返す"""
    h = {'apikey': db.anon_key}
    if token or not db.anon_key.startswith('sb_'):
        h['Authorization'] = 'Bearer ' + (token or db.anon_key)
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        h['Content-Type'] = 'image/jpeg' if isinstance(body, bytes) else 'application/json'
    h.update(headers or {})
    req = urllib.request.Request(db.url + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode('utf-8', 'replace')
            return res.status, text
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')


def login(db, email, password):
    status, text = raw(db, 'POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': password})
    return json.loads(text)['access_token'] if status == 200 else None


def main():
    db = Client()
    key = 'rls-check-' + secrets.token_hex(3)
    row = {'key': key, 'label': 'RLS check', 'data': {'tasks': [{'taskNo': '1'}]}}
    print('対象: ' + db.url + '\n')

    # ---- 匿名（クルー用アプリと同じ）
    status, _ = raw(db, 'GET', '/rest/v1/flight_list?select=key&limit=1')
    check(status == 200, '匿名で flight_list を読める')
    status, _ = raw(db, 'GET', '/rest/v1/sketches?select=flight_key&limit=1')
    check(status == 200, '匿名で sketches を読める')
    status, _ = raw(db, 'POST', '/rest/v1/flights', row)
    check(status in (401, 403), '匿名ではフライトを登録できない（%d）' % status)
    status, text = raw(db, 'GET', '/rest/v1/history?select=id&limit=1')
    check(status in (401, 403) or text.strip() == '[]', '匿名では変更履歴が見えない')
    status, text = raw(db, 'GET', '/rest/v1/admins?select=email')
    check(status in (401, 403) or text.strip() == '[]', '匿名では管理者の一覧が見えない')
    status, _ = raw(db, 'POST', '/storage/v1/object/%s/rls-check/%s.jpg' % (BUCKET, key), b'\xff\xd8\xff')
    check(status >= 400, '匿名では画像を置けない（%d）' % status)

    # ---- 管理者でないアカウント（任意）
    ne, npw = os.environ.get('TASKBOARD_NONADMIN_EMAIL'), os.environ.get('TASKBOARD_NONADMIN_PASSWORD')
    if ne and npw:
        token = login(db, ne, npw)
        check(token is not None, '管理者でないアカウントでログインできる（前提）')
        if token:
            status, _ = raw(db, 'POST', '/rest/v1/flights', row, token)
            check(status in (401, 403), '管理者でないアカウントは登録できない（%d）' % status)
            status, _ = raw(db, 'POST', '/storage/v1/object/%s/rls-check/%s.jpg' % (BUCKET, key), b'\xff\xd8\xff', token)
            check(status >= 400, '管理者でないアカウントは画像を置けない（%d）' % status)
    else:
        print('（TASKBOARD_NONADMIN_EMAIL / _PASSWORD が無いので、管理者でないアカウントの確認は飛ばします）')

    # ---- ボット（管理者）
    db.login()
    db.insert('flights', row)
    check(bool(db.select('flight_list', 'select=key&key=' + eq(key))), 'ボットはフライトを登録できる')
    path = db.upload('rls-check/%s.jpg' % key, b'\xff\xd8\xff\xd9')
    check(db.download(path) == b'\xff\xd8\xff\xd9', 'ボットは画像を置けて、公開URLで読める')
    db.remove([path])
    hist = db.select('history', 'select=actor,op&row_key=' + eq(key))
    check(any(h['actor'] == db.email and h['op'] == 'INSERT' for h in hist), '変更履歴にボットの名前が残る')
    db.delete('flights', 'key=' + eq(key))
    check(not db.select('flight_list', 'select=key&key=' + eq(key)), '確認用フライトを消した')

    print()
    if failures:
        print('❌ %d 件が意図どおりではありません。supabase/schema.sql を流し直したか確認してください。' % len(failures))
        sys.exit(1)
    print('✅ 権限はすべて意図どおりです。')


if __name__ == '__main__':
    main()

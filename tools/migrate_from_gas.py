#!/usr/bin/env python3
"""GAS 版 TaskBoard の全データを Supabase へ移す（一度きりの移行用）。

GAS の公開されている読み取り API（action=flights / flight / image / sketch）だけを使うので、
GAS 側には何も書かない。書き込み先は docs/config.js の Supabase で、
ボット用メンバー（TASKBOARD_BOT_EMAIL / TASKBOARD_BOT_PASSWORD）でログインして書く。

    python3 tools/migrate_from_gas.py            移して、最後に突き合わせる
    python3 tools/migrate_from_gas.py --check    移さずに突き合わせだけ行う

何度流しても同じ結果になる。すでに移してあって中身が一致するフライトは飛ばし、
違っていれば画像ごと入れ直す。最後に件数・ラベル・アーカイブ状態・ページ数・スケッチ・
画像の中身（SHA-256）を GAS と比べ、違いがあれば一覧にして終了コード 1 で終わる。
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from taskboard_db import Client, die, eq, original_path, sketch_paths  # noqa: E402

GAS_URL = ('https://script.google.com/macros/s/'
           'AKfycbzRIZMR0wbzGXpU2LdYvP543ur6-odsQx4EpEc5yB-SqDrxP8hQ3Xc1MIDNLcrsI_1U5Q/exec')


def gas_get(gas, action, **params):
    params['action'] = action
    url = gas + '?' + urllib.parse.urlencode(params)
    last = None
    for attempt in range(4):  # GAS はたまに HTML のエラーページを返す。少し待てば通る
        try:
            with urllib.request.urlopen(url, timeout=120) as res:
                out = json.loads(res.read())
            if out.get('ok') is False:
                die('GAS がエラーを返しました（%s）: %s' % (action, out.get('error')))
            return out
        except (ValueError, OSError) as e:
            last = e
            time.sleep(2 ** attempt)
    die('GAS から読めませんでした（%s %s）: %s' % (action, params, last))


def decode_data_url(data_url):
    """data:image/jpeg;base64,... → (bytes, content_type)"""
    if not data_url or not data_url.startswith('data:'):
        return None, None
    head, b64 = data_url.split(',', 1)
    ctype = head[5:].split(';')[0] or 'image/jpeg'
    return base64.b64decode(b64), ctype


def with_ext(path, ctype):
    ext = {'image/png': '.png', 'image/webp': '.webp'}.get(ctype)
    return path[:-4] + ext if ext and path.endswith('.jpg') else path


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


class Source:
    """GAS 側の内容。画像は何度も取りに行かないよう一度だけ読む。"""

    def __init__(self, gas):
        self.gas = gas
        listing = gas_get(gas, 'flights')
        self.flights = listing.get('flights', [])
        self.sketches = listing.get('sketches', [])
        self._data, self._pages, self._sketch = {}, {}, {}

    def data(self, key):
        if key not in self._data:
            raw = gas_get(self.gas, 'flight', key=key)['data']
            self._data[key] = json.loads(raw)
        return self._data[key]

    def pages(self, f):
        key = f['key']
        if key not in self._pages:
            self._pages[key] = [decode_data_url(gas_get(self.gas, 'image', key=key, page=p).get('image'))
                                for p in range(1, (f.get('imagePages') or 0) + 1)]
        return self._pages[key]

    def sketch(self, s):
        k = (s['flightKey'], s['taskNo'])
        if k not in self._sketch:
            main = decode_data_url(gas_get(self.gas, 'sketch', flightKey=k[0], taskNo=k[1]).get('image'))
            thumb = decode_data_url(s.get('thumb'))
            self._sketch[k] = (main, thumb)
        return self._sketch[k]


def remote_bytes(db, path, cache={}):
    if path not in cache:
        cache[path] = db.download(path)
    return cache[path]


def flight_matches(db, src, f, row):
    """移行先の行が GAS と一致しているか。違う点のリストを返す（空なら一致）。"""
    diffs = []
    if row is None:
        return ['未登録']
    if row['label'] != f['label']:
        diffs.append('ラベル %r ≠ %r' % (row['label'], f['label']))
    if bool(row.get('archived_at')) != bool(f.get('archived')):
        diffs.append('アーカイブ状態')
    if row['data'] != src.data(f['key']):
        diffs.append('タスク内容')
    pages = src.pages(f)
    images = row.get('images') or []
    if len(images) != len(pages):
        diffs.append('原本 %d ページ ≠ %d ページ' % (len(images), len(pages)))
    else:
        for i, (path, (data, _)) in enumerate(zip(images, pages), start=1):
            if sha(remote_bytes(db, path)) != sha(data):
                diffs.append('原本 %d ページ目の中身' % i)
    return diffs


def migrate_flight(db, src, f, created_at, existing):
    key = f['key']
    pages = src.pages(f)
    uploaded = []
    for i, (data, ctype) in enumerate(pages, start=1):
        if data is None:
            print('  ⚠️ 原本 %d ページ目が GAS から読めませんでした（飛ばします）' % i)
            continue
        uploaded.append(db.upload(with_ext(original_path(key, i), ctype), data, ctype))
    row = {
        'key': key,
        'label': f['label'],
        'date': f.get('date') or '',
        'data': src.data(key),
        'images': uploaded,
        'archived_at': f.get('archived') or None,
        'created_at': created_at,
        'updated_at': f.get('updatedAt') or created_at,
    }
    if existing:
        db.update('flights', 'key=' + eq(key), row)
        db.remove([p for p in existing.get('images') or [] if p not in uploaded])
    else:
        db.insert('flights', row)


def migrate_sketch(db, src, s, existing):
    (main, mtype), (thumb, ttype) = src.sketch(s)
    if main is None:
        print('  ⚠️ スケッチ %s / Task %s が GAS から読めませんでした（飛ばします）' % (s['flightKey'], s['taskNo']))
        return
    main_path, thumb_path = sketch_paths(s['flightKey'], s['taskNo'])
    main_path = db.upload(with_ext(main_path, mtype), main, mtype)
    thumb_path = db.upload(with_ext(thumb_path, ttype), thumb, ttype) if thumb else None
    db.insert('sketches', {'flight_key': s['flightKey'], 'task_no': s['taskNo'],
                           'path': main_path, 'thumb_path': thumb_path}, upsert=True)
    if existing:
        db.remove([p for p in (existing['path'], existing.get('thumb_path')) if p not in (main_path, thumb_path)])


def sketch_matches(db, src, s, row):
    if row is None:
        return ['未登録']
    (main, _), (thumb, _) = src.sketch(s)
    diffs = []
    if sha(remote_bytes(db, row['path'])) != sha(main):
        diffs.append('本体の中身')
    if bool(thumb) != bool(row.get('thumb_path')):
        diffs.append('プレビューの有無')
    elif thumb and sha(remote_bytes(db, row['thumb_path'])) != sha(thumb):
        diffs.append('プレビューの中身')
    return diffs


def order_of(db, keys):
    """移行先での登録順（created_at 順）を、GAS にあるキーだけで返す"""
    rows = db.select('flights', 'select=key&order=created_at.asc,key.asc')
    return [r['key'] for r in rows if r['key'] in keys]


def current_rows(db):
    flights = {r['key']: r for r in db.select('flights', 'select=key,label,data,images,archived_at')}
    sketches = {(r['flight_key'], r['task_no']): r for r in db.select('sketches', 'select=*')}
    return flights, sketches


def main():
    ap = argparse.ArgumentParser(description='GAS 版 TaskBoard の全データを Supabase へ移す')
    ap.add_argument('--gas', default=GAS_URL, help='GAS の /exec URL')
    ap.add_argument('--check', action='store_true', help='移さずに突き合わせだけ行う')
    args = ap.parse_args()

    db = Client()
    print('移行元: %s' % args.gas)
    print('移行先: %s' % db.url)
    src = Source(args.gas)
    print('GAS: フライト %d 件 / スケッチ %d 件' % (len(src.flights), len(src.sketches)))

    if not args.check:
        db.login()
        flights, sketches = current_rows(db)
        # 登録順（GAS の行順）を created_at で再現する。1件1秒ずつずらす
        base = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=len(src.flights))
        for i, f in enumerate(src.flights):
            created = (base + datetime.timedelta(seconds=i)).isoformat()
            existing = flights.get(f['key'])
            if existing and not flight_matches(db, src, f, existing):
                print('= %s（一致しているので飛ばします）' % f['key'])
                continue
            print('→ %s（%s・原本 %d ページ）' % (f['key'], f['label'], f.get('imagePages') or 0))
            migrate_flight(db, src, f, created, existing)
        for s in src.sketches:
            k = (s['flightKey'], s['taskNo'])
            if k[0] not in {f['key'] for f in src.flights}:
                continue
            existing = sketches.get(k)
            if existing and not sketch_matches(db, src, s, existing):
                print('= スケッチ %s / Task %s（一致しているので飛ばします）' % k)
                continue
            print('→ スケッチ %s / Task %s' % k)
            migrate_sketch(db, src, s, existing)
        # 飛ばしたフライト（先に登録済みだったもの）があると登録順がずれ得る。
        # クルー用アプリは登録順で「最新のフライト」を決めるので、ずれていたら揃える
        gas_order = [f['key'] for f in src.flights]
        if order_of(db, set(gas_order)) != gas_order:
            print('→ 登録順を GAS に揃えます')
            for i, key in enumerate(gas_order):
                db.update('flights', 'key=' + eq(key),
                          {'created_at': (base + datetime.timedelta(seconds=i)).isoformat()})

    print('\n突き合わせ:')
    flights, sketches = current_rows(db)
    problems = 0
    gas_keys = {f['key'] for f in src.flights}
    for f in src.flights:
        diffs = flight_matches(db, src, f, flights.get(f['key']))
        problems += bool(diffs)
        print('  %s %-32s %s' % ('❌' if diffs else '✅', f['key'], ' / '.join(diffs) or
                                 '原本 %d ページ' % (f.get('imagePages') or 0)))
    for s in src.sketches:
        k = (s['flightKey'], s['taskNo'])
        diffs = sketch_matches(db, src, s, sketches.get(k))
        problems += bool(diffs)
        print('  %s スケッチ %s / Task %s %s' % ('❌' if diffs else '✅', k[0], k[1], ' / '.join(diffs)))
    order_ok = order_of(db, gas_keys) == [f['key'] for f in src.flights]
    problems += not order_ok
    print('  %s 登録順' % ('✅' if order_ok else '❌'))
    extra = sorted(set(flights) - gas_keys)
    if extra:
        print('  ℹ️ Supabase にだけあるフライト: %s' % ', '.join(extra))
    if problems:
        print('\n❌ %d 件が一致しません。' % problems)
        sys.exit(1)
    print('\n✅ フライト %d 件・スケッチ %d 件がすべて一致しました。' % (len(src.flights), len(src.sketches)))


if __name__ == '__main__':
    main()

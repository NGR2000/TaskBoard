#!/usr/bin/env python3
"""TaskBoard の本番状態を見る／アーカイブする小道具。

  python3 taskboard_state.py list             登録済みフライトとスケッチの一覧
  python3 taskboard_state.py archive <key>    フライトをアーカイブ（データは残る）
  python3 taskboard_state.py unarchive <key>  アーカイブを戻す
  python3 taskboard_state.py history <key>    そのフライト（とスケッチ）の変更履歴
  python3 taskboard_state.py show <key> [out.json]  登録済みの JSON を表示（ファイルに保存）
  python3 taskboard_state.py pending [dir]    写真だけで速報登録された「変換待ち」のフライト。
                                              dir を付けると原本を dir/<key>/1.jpg, 2.jpg… に保存する

接続先は docs/config.js（tools/publish.py と同じ）。list・show・pending はログイン不要、
それ以外は TASKBOARD_BOT_EMAIL / TASKBOARD_BOT_PASSWORD でログインする。
"""
import datetime
import json
import os
import sys
import urllib.parse


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    while here != os.path.dirname(here):
        if os.path.exists(os.path.join(here, 'tools', 'taskboard_db.py')):
            return here
        here = os.path.dirname(here)
    sys.exit('tools/taskboard_db.py が見つかりません（TaskBoard リポジトリの中で実行してください）')


sys.path.insert(0, os.path.join(repo_root(), 'tools'))
from taskboard_db import Client, eq  # noqa: E402


def cmd_list(db):
    flights = db.select('flight_list', 'select=key,label,date,task_count,images,archived_at&order=created_at.asc,key.asc')
    print('フライト:')
    for f in flights:
        flag = ' [アーカイブ済み]' if f.get('archived_at') else ''
        print('  %-32s | %-40s | date=%-22s | tasks=%s | pages=%s%s' % (
            f['key'], f['label'], f.get('date', ''), f.get('task_count'), len(f.get('images') or []), flag))
    sketches = db.select('sketches', 'select=flight_key,task_no&order=flight_key.asc,task_no.asc')
    print('スケッチ: ' + (', '.join('%s / Task %s' % (s['flight_key'], s['task_no']) for s in sketches) or 'なし'))


def cmd_show(db, key, out):
    rows = db.select('flights', 'select=label,data&key=' + eq(key))
    if not rows:
        sys.exit('フライトが見つかりません: ' + key)
    text = json.dumps(rows[0]['data'], ensure_ascii=False, indent=2)
    if out:
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write(text + '\n')
        print('%s（%s）を %s に保存しました' % (key, rows[0]['label'], out))
    else:
        print(text)


def cmd_pending(db, out_dir):
    rows = db.select('flights', 'select=key,label,date,images,created_at&data->>awaitingConversion=eq.true'
                     '&archived_at=is.null&order=created_at.asc')
    if not rows:
        print('変換待ちのフライトはありません')
        return
    for f in rows:
        print('%s | %s | %s | 原本 %d ページ | 登録 %s' % (f['key'], f['label'], f['date'], len(f['images']),
                                                     f['created_at'][:16].replace('T', ' ')))
        if out_dir:
            d = os.path.join(out_dir, f['key'])
            os.makedirs(d, exist_ok=True)
            for i, path in enumerate(f['images'], start=1):
                dest = os.path.join(d, '%d%s' % (i, os.path.splitext(path)[1] or '.jpg'))
                with open(dest, 'wb') as fh:
                    fh.write(db.download(path))
                print('  → ' + dest)


def cmd_archive(db, key, archived):
    db.login()
    value = datetime.datetime.now(datetime.timezone.utc).isoformat() if archived else None
    db.update('flights', 'key=' + eq(key), {'archived_at': value})
    print('%s: %s' % (key, 'アーカイブしました' if archived else 'アーカイブを戻しました'))


def cmd_history(db, key):
    db.login()
    # フライト本体は row_key = key、スケッチは row_key = "<key>/<taskNo>"
    like = urllib.parse.quote(key.replace('*', '') + '/*', safe='')
    rows = db.select('history', 'select=at,actor,table_name,op,row_key,old_row,new_row'
                     '&or=(row_key.%s,row_key.like.%s)&order=at.desc&limit=30' % (eq(key), like))
    if not rows:
        print('履歴がありません: ' + key)
        return
    for h in rows:
        what = h['table_name'] if h['table_name'] != 'sketches' else 'スケッチ ' + h['row_key'].split('/', 1)[1]
        note = ''
        old, new = h.get('old_row') or {}, h.get('new_row') or {}
        if h['table_name'] == 'flights' and h['op'] == 'UPDATE':
            changed = [c for c in ('label', 'data', 'images', 'archived_at') if old.get(c) != new.get(c)]
            note = ' 変更: ' + (', '.join(changed) or '（なし）')
        print('%s  %-24s %-6s %s%s' % (h['at'][:19].replace('T', ' '), h.get('actor') or '(SQL Editor)',
                                        h['op'], what, note))


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ('list', 'archive', 'unarchive', 'history', 'show', 'pending'):
        sys.exit(__doc__)
    db = Client()
    if args[0] == 'list':
        cmd_list(db)
        return
    if args[0] == 'pending':
        cmd_pending(db, args[1] if len(args) > 1 else '')
        return
    if len(args) < 2:
        sys.exit('key を指定してください')
    if args[0] == 'history':
        cmd_history(db, args[1])
    elif args[0] == 'show':
        cmd_show(db, args[1], args[2] if len(args) > 2 else '')
    else:
        cmd_archive(db, args[1], args[0] == 'archive')


if __name__ == '__main__':
    main()

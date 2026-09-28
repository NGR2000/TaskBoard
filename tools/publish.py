#!/usr/bin/env python3
"""TaskBoard へフライトを反映する。

タスクシートを JSON に変換したあと、管理画面を開かずに
「登録 → 原本ページのアップロード」までを一気に済ませるためのもの。
従来どおり管理画面から手で登録する運用も、そのまま並行して使える。

    python3 tools/publish.py --json flight.json --original tds.pdf

書き込み先は Supabase（接続先は docs/config.js）。ボット用メンバーでログインして書く:
  TASKBOARD_BOT_EMAIL / TASKBOARD_BOT_PASSWORD（環境変数。チャットやリポジトリには置かない）
共通部分は tools/taskboard_db.py。
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from taskboard_db import Client, die, eq, original_path, sketch_paths, slugify, suggest_label  # noqa: E402

# 原本ページの長辺。管理画面側の画像圧縮（docs/admin/index.html の compressImage / uploadPdf）と揃えてある。
# クルーの端末は原本を最大でも画面幅程度でしか表示しないため、これより大きくしても
# 通信量が増えるだけで見え方は変わらない。実データで確認済み（デジタルPDF・スマホ写真の
# どちらも 1200px/品質72 で問題なく判読できる）。
PAGE_LONG_EDGE = 1200
JPEG_QUALITY = 72

# スケッチのプレビュー用サムネイル。タスクカードに直接表示するので、
# 通信量を増やさないようにフルサイズよりずっと小さく・粗くする
# （タップした時に見るフル解像度は別ファイルで上げる）。
THUMB_LONG_EDGE = 320
THUMB_JPEG_QUALITY = 55


def _open_pymupdf():
    try:
        import pymupdf as fitz
        return fitz
    except ImportError:
        pass
    try:
        import fitz  # 古い PyMuPDF は fitz という名前でしか入らない
        return fitz
    except ImportError:
        die('画像の変換には PyMuPDF が必要です。次を実行してください:\n  pip install pymupdf')


def render_pages(paths, long_edge=PAGE_LONG_EDGE, quality=JPEG_QUALITY):
    """PDF はページごとに、画像はそのまま JPEG のバイト列にして返す。

    PyMuPDF は PDF も画像も同じ Document として開けるので、
    ページ分割と縮小を 1 本の経路で扱える。long_edge/quality を変えれば
    同じ経路でサムネイルも作れる（render_thumbnail 参照）。"""
    fitz = _open_pymupdf()

    pages = []
    for path in paths:
        if not os.path.exists(path):
            die('ファイルが見つかりません: ' + path)
        try:
            doc = fitz.open(path)
        except Exception as e:  # 壊れたPDFや未対応形式
            die('%s を開けませんでした: %s' % (path, e))
        for page in doc:
            raw = page.rect
            scale = min(2.0, long_edge / max(raw.width, raw.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
            data = pix.tobytes('jpeg', jpg_quality=quality)
            pages.append(data)
        doc.close()
    return pages


def render_thumbnail(path):
    """1枚の画像/PDF先頭ページから、タスクカードに埋め込む軽量プレビューを作る。"""
    return render_pages([path], long_edge=THUMB_LONG_EDGE, quality=THUMB_JPEG_QUALITY)[0]


def main():
    ap = argparse.ArgumentParser(description='TaskBoard へフライトを反映する')
    ap.add_argument('--json', default='',
                    help='反映するフライトJSONのパス。省略すると原本の追加だけを行う（--key が必要）')
    ap.add_argument('--original', nargs='*', default=[], help='原本のPDF/画像（複数可・この順でページになる）')
    ap.add_argument('--key', default='', help='既存フライトを上書きする時のkey（省略すると新規）')
    ap.add_argument('--label', default='',
                    help='一覧に出す名前。既存フライトの更新で省略すると今のラベルのまま。新規で省略するとJSONから自動生成')
    ap.add_argument('--keep-images', action='store_true',
                    help='既存の原本ページを消さずに後ろへ足す（既定は貼り直し）')
    ap.add_argument('--sketch', action='append', default=[], metavar='TASKNO:PATH',
                    help='タスク別スケッチ（図・手描き・地図の切り出しなど）を直接アップロードする。'
                         '<タスク番号>:<画像パス> の形で複数指定可（--sketch 20:task20.png --sketch 22:task22.png）。'
                         '--key で指定したフライトに紐づく。既存のスケッチは上書きされる。')
    ap.add_argument('--dry-run', action='store_true', help='送信せず、何をするかだけ表示する')
    args = ap.parse_args()

    # JSON を省略した時は「登録済みフライトに原本・スケッチだけ足す」動き。
    # 既に登録されている内容とラベルには一切触らない。
    images_only = not args.json
    if images_only:
        if not args.key:
            die('--json を省略する場合は --key で対象フライトを指定してください。')
        if not args.original and not args.sketch:
            die('--json も --original も --sketch も無いので、やることがありません。')
        parsed = {}
    else:
        try:
            with open(args.json, encoding='utf-8') as fh:
                parsed = json.load(fh)
        except OSError as e:
            die('JSONを読めませんでした: %s' % e)
        except ValueError as e:
            die('JSONとして壊れています: %s' % e)
        if not isinstance(parsed, dict) or not parsed.get('tasks'):
            die('tasks が入っていません。TaskBoard用のJSONか確認してください。')

    sketches = []
    if args.sketch:
        if not args.key:
            die('--sketch を使う場合は --key で対象フライトを指定してください。')
        for entry in args.sketch:
            if ':' not in entry:
                die('--sketch は <タスク番号>:<画像パス> の形で指定してください: %r' % entry)
            task_no, path = entry.split(':', 1)
            task_no = task_no.strip()
            if not task_no:
                die('--sketch のタスク番号が空です: %r' % entry)
            if not os.path.exists(path):
                die('ファイルが見つかりません: ' + path)
            sketches.append((task_no, path))

    pages = render_pages(args.original) if args.original else []

    db = Client()
    # キーとラベルを決める。GAS 版と同じく、同じキーがあれば上書き（訂正の再登録）
    new_label = args.label.strip()
    key = args.key.strip() or slugify(new_label or suggest_label(parsed))
    found = db.select('flights', 'select=key,label,images&key=' + eq(key))
    existing = found[0] if found else None
    if images_only and not existing:
        die('フライトが見つかりません: ' + key)
    label = new_label or (existing and existing['label']) or suggest_label(parsed)

    print('反映先: %s' % db.url)
    print('フライト: %s（%s）%s' % (key, label, '・既存を更新' if existing else '・新規'))
    if existing and not new_label and not images_only:
        print('  ラベルは今のまま使います（変えたい時は --label）')
    if images_only:
        print('原本・スケッチのみ差し替え（タスク内容とラベルは触りません）')
    else:
        print('タスク数: %d' % len(parsed['tasks']))
    print('原本ページ数: %d%s' % (len(pages), '（既存ページは貼り直し）' if pages and existing and not args.keep_images else ''))
    if sketches:
        print('スケッチ: %s' % ', '.join('Task %s (%s)' % (t, p) for t, p in sketches))
    if args.dry_run:
        print('--dry-run のため送信しませんでした。')
        return

    db.login()
    old_images = list(existing['images']) if existing else []

    # 画像は先に上げてから、フライトの行を1回で書き換える。途中で失敗しても
    # クルーの画面から原本が消えた状態にはならない（古い画像は最後に消す）。
    images = old_images
    if pages:
        kept = old_images if args.keep_images else []
        uploaded = []
        for i, data in enumerate(pages, start=1):
            uploaded.append(db.upload(original_path(key, len(kept) + i), data))
            print('✅ 原本 %d/%d ページ目を上げました（%d KB）' % (i, len(pages), len(data) // 1024))
        images = kept + uploaded

    if images_only:
        if pages:
            db.update('flights', 'key=' + eq(key), {'images': images})
    else:
        row = {
            'key': key,
            'label': label,
            'date': str((parsed.get('basicInfo') or {}).get('date') or ''),
            'data': parsed,
            'images': images,
        }
        if existing:
            db.update('flights', 'key=' + eq(key), row)
        else:
            db.insert('flights', row)
        print('✅ 登録しました: %s（%s / %d タスク）' % (key, label, len(parsed['tasks'])))

    if pages and not args.keep_images:
        stale = [p for p in old_images if p not in images]
        db.remove(stale)
        if stale:
            print('古い原本 %d ページを消しました。' % len(stale))

    for task_no, path in sketches:
        main_bytes = render_pages([path])[0]
        thumb_bytes = render_thumbnail(path)
        main_path, thumb_path = sketch_paths(key, task_no)
        db.upload(main_path, main_bytes)
        db.upload(thumb_path, thumb_bytes)
        prev = db.select('sketches', 'select=path,thumb_path&flight_key=%s&task_no=%s' % (eq(key), eq(task_no)))
        db.insert('sketches', {'flight_key': key, 'task_no': task_no, 'path': main_path, 'thumb_path': thumb_path},
                  upsert=True)
        if prev:
            db.remove([prev[0]['path'], prev[0]['thumb_path']])
        print('✅ スケッチを保存しました: Task %s（本体 %d KB / プレビュー %d KB）'
              % (task_no, len(main_bytes) // 1024, len(thumb_bytes) // 1024))

    final = db.select('flight_list', 'select=label,task_count,images&key=' + eq(key))
    if final:
        print('反映後の状態: %s / %s タスク / 原本 %d ページ'
              % (final[0]['label'], final[0]['task_count'], len(final[0]['images'])))
    if sketches:
        have = {s['task_no'] for s in db.select('sketches', 'select=task_no&flight_key=' + eq(key))}
        for task_no, _ in sketches:
            print('  スケッチ Task %s: %s' % (task_no, '✅' if task_no in have else '⚠️ 反映確認できず'))
    print('完了です。クルーはアプリで「↻」を押すと反映されます。')


if __name__ == '__main__':
    main()

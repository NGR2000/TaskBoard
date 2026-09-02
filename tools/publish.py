#!/usr/bin/env python3
"""TaskBoard へフライトを反映する。

タスクシートを JSON に変換したあと、管理画面を開かずに
「登録 → 原本ページのアップロード」までを一気に済ませるためのもの。
従来どおり管理画面から手で登録する運用も、そのまま並行して使える。

    python3 tools/publish.py --json flight.json --original tds.pdf

API URL は既定で docs/config.js の apiUrl を読む。トークンは環境変数
TASKBOARD_TOKEN から読む（--token でも渡せるが、シェル履歴に残るので非推奨）。
トークンは Apps Script エディタで showApiToken() を実行すると確認できる。
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

CONFIG_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'config.js')

# 原本ページの長辺。管理画面側の PDF 変換（index.html）と揃えてある。
PAGE_LONG_EDGE = 1600
JPEG_QUALITY = 80


def die(message):
    print('エラー: ' + message, file=sys.stderr)
    sys.exit(1)


def api_url_from_config():
    """docs/config.js の apiUrl を使う。引数で渡さなくて済むように。"""
    try:
        with open(CONFIG_JS, encoding='utf-8') as fh:
            m = re.search(r'apiUrl\s*:\s*"([^"]+)"', fh.read())
            return m.group(1) if m else ''
    except OSError:
        return ''


def post(api, token, payload):
    """GAS は POST に 302 を返して googleusercontent 側に本文を置く。
    urllib は既定でこのリダイレクトを追うので、そのまま本文を読める。"""
    body = dict(payload)
    body['token'] = token
    req = urllib.request.Request(
        api,
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            text = res.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        die('APIが %d を返しました: %s' % (e.code, e.read().decode('utf-8', 'replace')[:400]))
    except urllib.error.URLError as e:
        die('APIに接続できませんでした: %s' % e.reason)

    try:
        out = json.loads(text)
    except ValueError:
        die('APIの応答がJSONではありません。デプロイが最新か確認してください:\n' + text[:400])

    if not out.get('ok'):
        reason = out.get('error', '不明')
        if reason == 'unauthorized':
            die('トークンが一致しません。TASKBOARD_TOKEN を確認してください'
                '（Apps Script エディタで showApiToken() を実行すると現在の値が出ます）。')
        die('APIがエラーを返しました: ' + str(reason))
    return out


def render_pages(paths):
    """PDF はページごとに、画像はそのまま JPEG の data URL にして返す。

    PyMuPDF は PDF も画像も同じ Document として開けるので、
    ページ分割と縮小を 1 本の経路で扱える。"""
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz  # 古い PyMuPDF は fitz という名前でしか入らない
        except ImportError:
            die('原本の変換には PyMuPDF が必要です。次を実行してください:\n  pip install pymupdf')

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
            scale = min(2.0, PAGE_LONG_EDGE / max(raw.width, raw.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
            data = pix.tobytes('jpeg', jpg_quality=JPEG_QUALITY)
            pages.append('data:image/jpeg;base64,' + base64.b64encode(data).decode('ascii'))
        doc.close()
    return pages


def main():
    ap = argparse.ArgumentParser(description='TaskBoard へフライトを反映する')
    ap.add_argument('--json', required=True, help='反映するフライトJSONのパス')
    ap.add_argument('--original', nargs='*', default=[], help='原本のPDF/画像（複数可・この順でページになる）')
    ap.add_argument('--key', default='', help='既存フライトを上書きする時のkey（省略すると新規）')
    ap.add_argument('--label', default='', help='一覧に出す名前（省略するとJSONから自動生成）')
    ap.add_argument('--api', default='', help='GASの /exec URL（省略時は docs/config.js）')
    ap.add_argument('--token', default='', help='書き込みトークン（省略時は環境変数 TASKBOARD_TOKEN）')
    ap.add_argument('--keep-images', action='store_true',
                    help='既存の原本ページを消さずに後ろへ足す（既定は貼り直し）')
    ap.add_argument('--dry-run', action='store_true', help='送信せず、何をするかだけ表示する')
    args = ap.parse_args()

    api = args.api or os.environ.get('TASKBOARD_API_URL', '') or api_url_from_config()
    if not api:
        die('APIのURLが分かりません。--api で渡すか docs/config.js を設定してください。')

    token = args.token or os.environ.get('TASKBOARD_TOKEN', '')
    if not token and not args.dry_run:
        die('トークンがありません。環境変数 TASKBOARD_TOKEN に設定してください'
            '（Apps Script エディタで showApiToken() を実行すると確認できます）。')

    try:
        with open(args.json, encoding='utf-8') as fh:
            raw = fh.read()
        parsed = json.loads(raw)
    except OSError as e:
        die('JSONを読めませんでした: %s' % e)
    except ValueError as e:
        die('JSONとして壊れています: %s' % e)

    if not parsed.get('tasks'):
        die('tasks が入っていません。TaskBoard用のJSONか確認してください。')

    pages = render_pages(args.original) if args.original else []

    print('反映先: %s' % api)
    print('タスク数: %d' % len(parsed['tasks']))
    print('原本ページ数: %d%s' % (len(pages), '（既存ページは貼り直し）' if pages and not args.keep_images else ''))
    if args.dry_run:
        print('--dry-run のため送信しませんでした。')
        return

    saved = post(api, token, {
        'action': 'saveFlight',
        'key': args.key,
        'label': args.label,
        'data': raw,
    })
    key = saved.get('key', args.key)
    print('✅ 登録しました: %s（%s / %s タスク）' % (key, saved.get('label', ''), saved.get('taskCount', '?')))

    if not pages:
        print('原本の指定が無いので、ここまでで完了です。')
        return

    if not args.keep_images:
        cleared = post(api, token, {'action': 'clearImages', 'key': key})
        if cleared.get('deleted'):
            print('既存の原本 %d ページを消しました。' % cleared['deleted'])
        start = 0
    else:
        state = post(api, token, {'action': 'state'})
        current = [f for f in state.get('flights', []) if f.get('key') == key]
        start = current[0].get('imagePages', 0) if current else 0

    for i, data_url in enumerate(pages, start=1):
        post(api, token, {
            'action': 'saveImage',
            'key': key,
            'page': start + i,
            'imageData': data_url,
        })
        print('✅ 原本 %d/%d ページ目を保存しました（%d KB）' % (i, len(pages), len(data_url) // 1024))

    state = post(api, token, {'action': 'state'})
    final = [f for f in state.get('flights', []) if f.get('key') == key]
    if final:
        print('反映後の状態: %s / %s タスク / 原本 %s ページ'
              % (final[0].get('label'), final[0].get('taskCount'), final[0].get('imagePages')))
    print('完了です。クルーはアプリで「↻」を押すと反映されます。')


if __name__ == '__main__':
    main()

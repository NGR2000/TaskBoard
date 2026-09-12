#!/usr/bin/env python3
"""TaskBoard の本番状態を見る／アーカイブする小道具。

  python3 taskboard_state.py list             登録済みフライトとスケッチの一覧
  python3 taskboard_state.py archive <key>    フライトをアーカイブ（データは残る）
  python3 taskboard_state.py unarchive <key>  アーカイブを戻す

API の URL は docs/config.js、トークンは環境変数 TASKBOARD_TOKEN から読む
（tools/publish.py と同じ）。list はトークン不要。
"""
import json
import os
import sys
import time
import urllib.request


def repo_root():
    here = os.path.dirname(os.path.abspath(__file__))
    while here != os.path.dirname(here):
        if os.path.exists(os.path.join(here, 'tools', 'publish.py')):
            return here
        here = os.path.dirname(here)
    sys.exit('tools/publish.py が見つかりません（TaskBoard リポジトリの中で実行してください）')


ROOT = repo_root()
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import publish  # noqa: E402


def fetch_state(api):
    # GAS は素直にキャッシュしないが、念のためクエリを変えて毎回取り直す
    url = api + ('&' if '?' in api else '?') + 'action=flights&_=' + str(int(time.time()))
    return json.load(urllib.request.urlopen(url))


def cmd_list(api):
    state = fetch_state(api)
    print('フライト:')
    for f in state.get('flights', []):
        flag = ' [アーカイブ済み]' if f.get('archived') else ''
        print('  %-32s | %-40s | date=%-22s | tasks=%s | pages=%s%s' % (
            f['key'], f['label'], f.get('date', ''), f.get('taskCount'), f.get('imagePages'), flag))
    sketches = state.get('sketches', [])
    print('スケッチ: ' + (', '.join('%s / Task %s' % (s['flightKey'], s['taskNo']) for s in sketches) or 'なし'))
    if 'sketchTaskNos' in state:
        print('※ 応答に旧フィールド sketchTaskNos があります。GAS のデプロイが古い（スケッチのフライト分離前）です。')


def cmd_archive(api, key, archived):
    token = os.environ.get('TASKBOARD_TOKEN', '')
    if not token:
        sys.exit('環境変数 TASKBOARD_TOKEN が未設定です')
    res = publish.post(api, token, {'action': 'archiveFlight', 'key': key, 'archived': archived})
    print(json.dumps(res, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ('list', 'archive', 'unarchive'):
        sys.exit(__doc__)
    api = os.environ.get('TASKBOARD_API_URL', '') or publish.api_url_from_config()
    if args[0] == 'list':
        cmd_list(api)
    else:
        if len(args) < 2:
            sys.exit('key を指定してください')
        cmd_archive(api, args[1], args[0] == 'archive')


if __name__ == '__main__':
    main()

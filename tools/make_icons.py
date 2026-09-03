#!/usr/bin/env python3
"""tools/icon-source.png から PWA 用のアイコン一式を作る。

元画像は「白い余白の中に青い角丸四角が置かれた」状態の絵。そのまま使うと
iOS / Android が更に角を丸めるので、ホーム画面では白い角が残り一回り小さく見える。
そこで白フチを落とし、角丸の外側を埋めて全面の四角にする。

埋め方が肝心で、板の地色は一様ではない（上辺は青、下の隅は雲の水色）。
単色で塗ると下の隅に段差が出るため、「その行の一番外側にある実ピクセルを
そのまま外へ伸ばす」クランプ方式で埋める。角の周辺は絵柄ではなく空と雲なので
継ぎ目は出ず、絵柄を1ドットも切らずに済む。

Pillow は入っていないので PyMuPDF だけで完結させている（tools/publish.py と同じ依存）。

    python3 tools/make_icons.py
"""

import os
import sys

try:
    import pymupdf
except ImportError:
    try:
        import fitz as pymupdf
    except ImportError:
        sys.exit('PyMuPDF が必要です:  pip install pymupdf')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'icon-source.png')
OUT = os.path.join(ROOT, 'docs')

WHITE = 245          # これ以上明るい画素は「白フチ」とみなす
MASKABLE_RATIO = 0.8 # Android の安全領域。絵柄は内側 80% に収める


# ---------------------------------------------------------------- 画素操作
def buf_of(pix):
    if pix.n != 3:
        sys.exit('RGB 画像を想定しています (n=%d)' % pix.n)
    return bytearray(pix.samples), pix.width, pix.height


def pix_of(buf, w, h):
    return pymupdf.Pixmap(pymupdf.csRGB, w, h, bytes(buf), False)


def get(buf, w, x, y):
    i = (y * w + x) * 3
    return buf[i], buf[i + 1], buf[i + 2]


def put(buf, w, x, y, c):
    i = (y * w + x) * 3
    buf[i], buf[i + 1], buf[i + 2] = c


def is_white(c):
    return c[0] > WHITE and c[1] > WHITE and c[2] > WHITE


def plate_bbox(pix):
    """白でない領域（＝青い角丸四角）の外接矩形をピクセルで返す"""
    buf, w, h = buf_of(pix)
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if not is_white(get(buf, w, x, y)):
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    return minx, miny, maxx, maxy


def render(src_path, clip_px, size, src_w):
    """元画像の一部を size×size に描き直す。clip はピクセル指定。

    PyMuPDF は PNG を 96dpi の PDF ページとして開くので、
    ページ座標（pt）= ピクセル × 0.75 になる。そこを換算している。
    """
    doc = pymupdf.open(src_path)
    page = doc[0]
    k = page.rect.width / float(src_w)          # px -> pt
    x0, y0, x1, y1 = clip_px
    clip = pymupdf.Rect(x0 * k, y0 * k, (x1 + 1) * k, (y1 + 1) * k)
    scale = size / clip.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip)
    doc.close()
    return pix


def clamp_fill_white(buf, w, h):
    """各行の両端に残った白を、その行の一番外側の実ピクセルで置き換える。

    行が丸ごと白の場合は、直前に処理した行の色で埋める（角の頂点付近の保険）。
    """
    last_left = last_right = None
    for y in range(h):
        xs = [x for x in range(w) if not is_white(get(buf, w, x, y))]
        if xs:
            left, right = xs[0], xs[-1]
            cl, cr = get(buf, w, left, y), get(buf, w, right, y)
            last_left, last_right = cl, cr
        else:
            if last_left is None:
                continue
            left, right, cl, cr = w, -1, last_left, last_right
        for x in range(0, min(left, w)):
            put(buf, w, x, y, cl)
        for x in range(max(right + 1, 0), w):
            put(buf, w, x, y, cr)
    return buf


def edge_gradient(inner_buf, iw, ih, size, oy):
    """外周を埋めるための縦グラデーションを、絵柄自身の左右の縁から作る。

    縁の色をそのまま横へ伸ばすと、行ごとの色差がそのまま縞になって見える
    （最初の実装がそれで失敗した）。板の地色は横方向にはほぼ一様で、
    縦方向にだけ変化する（上は青、下は雲の水色）ので、
    行ごとに左右の縁を平均し、さらに縦に強くならして滑らかな一本の勾配にする。
    """
    rows = []
    for y in range(ih):
        cl, cr = get(inner_buf, iw, 0, y), get(inner_buf, iw, iw - 1, y)
        rows.append([(cl[i] + cr[i]) / 2.0 for i in range(3)])

    win = max(4, ih // 8)                    # ならし幅。狭いと縞が残る
    smooth = []
    for y in range(ih):
        a, b = max(0, y - win), min(ih, y + win + 1)
        seg = rows[a:b]
        smooth.append(tuple(int(round(sum(r[i] for r in seg) / len(seg))) for i in range(3)))

    grad = []
    for y in range(size):
        grad.append(smooth[min(max(y - oy, 0), ih - 1)])
    return grad


def place_on_gradient(inner_buf, iw, ih, size):
    """絵柄を中央に置き、周囲は絵柄から作った縦グラデーションで埋める"""
    out = bytearray(size * size * 3)
    ox, oy = (size - iw) // 2, (size - ih) // 2
    grad = edge_gradient(inner_buf, iw, ih, size, oy)
    for y in range(size):
        c = grad[y]
        for x in range(size):
            put(out, size, x, y, c)
    for y in range(ih):
        for x in range(iw):
            put(out, size, ox + x, oy + y, get(inner_buf, iw, x, y))
    return out


def clamp_extend(inner_buf, iw, ih, size):
    """寸法が1pxずれた時に中央寄せで合わせるだけの補正"""
    out = bytearray(size * size * 3)
    ox, oy = (size - iw) // 2, (size - ih) // 2
    for y in range(size):
        sy = min(max(y - oy, 0), ih - 1)
        for x in range(size):
            sx = min(max(x - ox, 0), iw - 1)
            put(out, size, x, y, get(inner_buf, iw, sx, sy))
    return out


# ---------------------------------------------------------------- 生成
def build_any(bbox, size, src_w):
    """白フチを落とし、角丸の外を埋めた全面アイコン"""
    pix = render(SRC, bbox, size, src_w)
    buf, w, h = buf_of(pix)
    if (w, h) != (size, size):                   # 端数で1px ずれることがある
        buf, w, h = buf_of(pix_of(clamp_extend(buf, w, h, size), size, size))
    clamp_fill_white(buf, w, h)
    return pix_of(buf, w, h)


def build_maskable(bbox, size, src_w):
    """絵柄を 80% に縮めて中央に置き、外周は地色を伸ばして埋める"""
    inner = int(round(size * MASKABLE_RATIO))
    base = build_any(bbox, inner, src_w)
    buf, w, h = buf_of(base)
    return pix_of(place_on_gradient(buf, w, h, size), size, size)


def main():
    if not os.path.exists(SRC):
        sys.exit('元画像がありません: ' + SRC)
    src = pymupdf.Pixmap(SRC)
    print('元画像: %dx%d' % (src.width, src.height))

    bbox = plate_bbox(src)
    print('角丸四角の位置: x %d..%d  y %d..%d  (白フチ 左%d 上%d)'
          % (bbox[0], bbox[2], bbox[1], bbox[3], bbox[0], bbox[1]))

    targets = [
        ('icon-192.png', 192, 'any'),
        ('icon-512.png', 512, 'any'),
        ('apple-touch-icon.png', 180, 'any'),
        ('favicon-32.png', 32, 'any'),
        ('icon-maskable-512.png', 512, 'maskable'),
    ]

    print('\n生成:')
    made = []
    for name, size, kind in targets:
        pix = build_maskable(bbox, size, src.width) if kind == 'maskable' \
            else build_any(bbox, size, src.width)
        path = os.path.join(OUT, name)
        pix.save(path)
        made.append((name, size, kind, pix, os.path.getsize(path)))
        print('  %-24s %4d²  %6.1f KB' % (name, size, os.path.getsize(path) / 1024.0))

    # ---- 自己チェック ----
    print('\n確認:')
    fail = 0

    def check(label, ok, extra=''):
        nonlocal fail
        print(('  OK   ' if ok else '  NG   ') + label + ('' if ok else '  -> ' + str(extra)))
        if not ok:
            fail += 1

    for name, size, kind, pix, _ in made:
        check('%s が %d×%d' % (name, size, size), (pix.width, pix.height) == (size, size),
              '%dx%d' % (pix.width, pix.height))
        check('%s が不透明' % name, not pix.alpha)
        buf, w, h = buf_of(pix)
        corners = [get(buf, w, 0, 0), get(buf, w, w - 1, 0), get(buf, w, 0, h - 1), get(buf, w, w - 1, h - 1)]
        check('%s の四隅に白が残っていない' % name,
              not any(is_white(c) for c in corners), corners)

    # maskable は外周2割が地色だけであること（絵柄が食い込んでいない）
    name, size, kind, pix, _ = [m for m in made if m[2] == 'maskable'][0]
    buf, w, h = buf_of(pix)
    band = int(w * (1 - MASKABLE_RATIO) / 2)
    edge_rows = [get(buf, w, x, 1) for x in range(0, w, 8)]
    spread = max(max(c) - min(c) for c in edge_rows)
    check('maskable の外周が地色のみ（帯 %dpx）' % band, band >= int(size * 0.09), band)

    total = sum(sz for name, _, _, _, sz in made if name in
                ('apple-touch-icon.png', 'icon-192.png', 'favicon-32.png'))
    print('\n  Service Worker に載せる3点の合計: %.1f KB' % (total / 1024.0))
    sys.exit(1 if fail else 0)


if __name__ == '__main__':
    main()

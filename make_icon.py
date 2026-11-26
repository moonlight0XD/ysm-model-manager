"""產生軟體圖示：assets/icon.png（1024px）與 assets/icon.ico（16~256px）。

圖案：藍色圓角底 + 黃色資料夾（整理、收藏）+ 從資料夾探出頭的方塊角色（玩家模型，狐狸耳朵呼應酒狐）。
用法：python make_icon.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'assets')
S = 1024          # 輸出尺寸；下面的座標都以 1024 為準
K = 4             # 超取樣倍率（畫大再縮小，邊緣較平滑）
N = S * K


def hexc(h, a=255):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (a,)


def P(*xy):
    """1024 座標 → 超取樣座標"""
    return [v * K for v in xy]


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_mask():
    mask = Image.new('L', (N, N), 0)
    pad = int(N * 0.035)
    ImageDraw.Draw(mask).rounded_rectangle([pad, pad, N - pad, N - pad], radius=int(N * 0.22), fill=255)
    return mask


def background(mask):
    top, bot = hexc('#4f9cf0'), hexc('#1d2b55')
    g = Image.new('RGBA', (N, N))
    d = ImageDraw.Draw(g)
    step = 8
    for y in range(0, N, step):
        for x in range(0, N, step):
            t = (x * 0.35 + y * 0.65) / N
            d.rectangle([x, y, x + step, y + step], fill=lerp(top, bot, t))
    g = g.filter(ImageFilter.GaussianBlur(step))
    out = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    out.paste(g, (0, 0), mask)
    return out


def vgrad(box, c1, c2, radius):
    """畫一個上下漸層的圓角矩形圖層"""
    x0, y0, x1, y1 = [int(v) for v in box]
    layer = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    g = Image.new('RGBA', (x1 - x0, y1 - y0))
    gd = ImageDraw.Draw(g)
    for y in range(y1 - y0):
        gd.line([(0, y), (x1 - x0, y)], fill=lerp(c1, c2, y / max(1, y1 - y0 - 1)))
    m = Image.new('L', (x1 - x0, y1 - y0), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, x1 - x0 - 1, y1 - y0 - 1], radius=int(radius), fill=255)
    layer.paste(g, (x0, y0), m)
    return layer


def shadow(box, radius, blur, alpha=110, dy=18):
    layer = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    x0, y0, x1, y1 = box
    ImageDraw.Draw(layer).rounded_rectangle([x0, y0 + dy * K, x1, y1 + dy * K], radius=radius, fill=(6, 12, 32, alpha))
    return layer.filter(ImageFilter.GaussianBlur(blur * K))


def character(img):
    d = ImageDraw.Draw(img)
    skin, hair, hair_dk = hexc('#ffe0c4'), hexc('#f59a45'), hexc('#d9742a')
    ear_in = hexc('#ffc6d6')
    # 手臂（袖子）與身體
    d.rectangle(P(318, 520, 372, 720), fill=hexc('#dfe9f7'))
    d.rectangle(P(652, 520, 706, 720), fill=hexc('#dfe9f7'))
    d.rectangle(P(372, 500, 652, 760), fill=hexc('#ffffff'))
    d.polygon(P(452, 500, 572, 500, 512, 552), fill=hexc('#3d7fd1'))   # 領口
    # 狐狸耳朵
    for (a, b, tip) in (((384, 272), (476, 272), (400, 150)), ((548, 272), (640, 272), (624, 150))):
        d.polygon(P(*a, *b, *tip), fill=hair)
    d.polygon(P(410, 268, 456, 268, 414, 200), fill=ear_in)
    d.polygon(P(568, 268, 614, 268, 610, 200), fill=ear_in)
    # 頭：頭髮 + 臉
    d.rectangle(P(372, 250, 652, 500), fill=skin)
    d.rectangle(P(372, 250, 652, 330), fill=hair)
    d.rectangle(P(372, 330, 412, 410), fill=hair)
    d.rectangle(P(612, 330, 652, 410), fill=hair)
    d.rectangle(P(452, 330, 500, 362), fill=hair)          # 瀏海
    d.rectangle(P(372, 250, 652, 266), fill=hair_dk)
    # 眼睛與反光
    eye = hexc('#1b2547')
    for x in (436, 548):
        d.rectangle(P(x, 380, x + 40, 446), fill=eye)
        d.rectangle(P(x + 6, 386, x + 20, 404), fill=hexc('#ffffff'))
    # 腮紅、嘴
    d.rectangle(P(420, 456, 452, 470), fill=hexc('#ffa5bf'))
    d.rectangle(P(572, 456, 604, 470), fill=hexc('#ffa5bf'))
    d.rectangle(P(500, 462, 524, 472), fill=hexc('#c8735a'))


def main():
    os.makedirs(OUT, exist_ok=True)
    mask = rounded_mask()
    img = background(mask)

    # 資料夾後片（含標籤）
    back = P(150, 300, 874, 830)
    img.alpha_composite(shadow(back, 70 * K, 22))
    tab = vgrad(P(150, 240, 460, 360), hexc('#f0b33c'), hexc('#e3a02e'), 44 * K)
    img.alpha_composite(tab)
    img.alpha_composite(vgrad(back, hexc('#f0b33c'), hexc('#d98f22'), 64 * K))

    # 資料夾裡的縮圖卡片（模型收藏）
    for (x0, y0, x1, y1, c, rot) in ((214, 330, 404, 520, '#7cc0ff', 8), (620, 330, 810, 520, '#b59cff', -8)):
        card = Image.new('RGBA', (N, N), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle(P(x0, y0, x1, y1), radius=22 * K, fill=hexc('#ffffff'))
        cd.rounded_rectangle(P(x0 + 14, y0 + 14, x1 - 14, y1 - 14), radius=12 * K, fill=hexc(c))
        cx, cy = (x0 + x1) / 2 * K, (y0 + y1) / 2 * K
        img.alpha_composite(card.rotate(rot, center=(cx, cy), resample=Image.BICUBIC))

    # 探出頭的角色
    character(img)

    # 資料夾前片
    front = P(130, 600, 894, 850)
    img.alpha_composite(shadow(front, 60 * K, 14, alpha=90, dy=-10))
    img.alpha_composite(vgrad(front, hexc('#ffe07a'), hexc('#f7b733'), 60 * K))
    hl = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle(P(150, 616, 874, 640), radius=12 * K, fill=(255, 255, 255, 90))
    img.alpha_composite(hl)

    # 剪成圓角底的形狀
    final = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    final.paste(img, (0, 0), mask)
    final = final.resize((S, S), Image.LANCZOS)
    final.save(os.path.join(OUT, 'icon.png'))
    sizes = [256, 128, 64, 48, 32, 24, 16]
    final.save(os.path.join(OUT, 'icon.ico'), sizes=[(x, x) for x in sizes])
    print('ok')


if __name__ == '__main__':
    main()

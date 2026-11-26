# -*- coding: utf-8 -*-
"""
YSM 模型管理器（Windows 桌面應用程式）

- 掃描 yes_steve_model 資料夾（custom / auth），列出 .ysm、資料夾、zip 模型
- 為每個模型保存縮圖、標籤、評分、備註（存在 %APPDATA%\\YSMModelManager）
- 啟用 / 停用（移出遊戲讀取的資料夾）、重新命名、在檔案總管中顯示
- 未加密模型（資料夾 / zip）可用內建 3D 預覽器檢視
- 加密的 .ysm 只讀取官方格式中「未加密的公開摘要」，不做任何解密

執行：
    python manager_app.py           開啟應用程式視窗
    python manager_app.py --serve   只啟動本機伺服器（測試用）
"""
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile

APP_NAME = 'YSM 模型管理器'
APP_VERSION = '1.0.0'
GITHUB_URL = 'https://github.com/moonlight0XD/ysm-model-manager'
if getattr(sys, 'frozen', False):
    APP_DIR = sys._MEIPASS  # PyInstaller 解壓縮的資源目錄
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

# BASE_DIR 固定不變，放設定檔與 WebView 資料；DATA_DIR（模型資料庫與縮圖）可在設定中搬到別處
BASE_DIR = os.environ.get('YSM_MANAGER_DATA') or os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'YSMModelManager')
SETTINGS_PATH = os.path.join(BASE_DIR, 'settings.json')
DEFAULT_SETTINGS = {
    'lang': 'zh-Hant',            # 目前只有繁體中文
    'confirm_copy': True,         # 無法硬連結時，改用複製前先詢問
    'confirm_delete_twice': True, # 刪除倉庫模型時確認兩次
    'group_versions': True,       # 同角色的不同版本合併成一張卡
    'data_dir': '',               # 空白 = BASE_DIR
}


def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_PATH, encoding='utf-8') as f:
            s.update({k: v for k, v in json.load(f).items() if k in DEFAULT_SETTINGS})
    except (OSError, ValueError):
        pass
    return s


def save_settings():
    os.makedirs(BASE_DIR, exist_ok=True)
    tmp = SETTINGS_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(SETTINGS, f, ensure_ascii=False, indent=1)
    os.replace(tmp, SETTINGS_PATH)


SETTINGS = load_settings()
DATA_DIR = SETTINGS['data_dir'] if SETTINGS['data_dir'] and os.path.isdir(SETTINGS['data_dir']) else BASE_DIR
THUMB_DIR = os.path.join(DATA_DIR, 'thumbs')
DB_PATH = os.path.join(DATA_DIR, 'library.json')
DISABLED_DIRNAME = 'ysm_manager_disabled'  # 停用的模型移到這裡，遊戲不會讀取
SOURCES = ('custom', 'auth')
MODEL_EXTS = ('.ysm', '.zip', '.7z')
YSM_MAGIC = b'\xef\xbb\xbfYSGP'  # 官方 Asset Container 標準中的公開檔頭

os.makedirs(THUMB_DIR, exist_ok=True)


# ---------------------------------------------------------------- 工具
def loose_json(text):
    """容忍 BOM、// /* */ 註解與尾逗號的 JSON 解析"""
    text = text.lstrip('﻿')
    try:
        return json.loads(text)
    except Exception:
        pass
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                if text[j] == '\\':
                    j += 1
                j += 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith('//', i):
            while i < n and text[i] != '\n':
                i += 1
        elif text.startswith('/*', i):
            e = text.find('*/', i + 2)
            i = n if e < 0 else e + 2
        else:
            out.append(c)
            i += 1
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', ''.join(out)))


def read_text(path):
    with open(path, 'rb') as f:
        return f.read().decode('utf-8', errors='replace')


def zip_name(info):
    """修正 zip 內非 UTF-8 檔名（常見為 GBK）"""
    if info.flag_bits & 0x800:
        return info.filename
    raw = info.filename.encode('cp437', errors='replace')
    for enc in ('utf-8', 'gbk', 'big5'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return info.filename


URL_RE = re.compile(r'https?://[^\s<>"\'）)】」』，。、；]+', re.I)


def collect_links(m):
    """從模型資訊（說明、授權說明、作者聯絡方式、主頁／贊助）找出所有 http(s) 連結"""
    links = []

    def add(label, text):
        for u in URL_RE.findall(str(text or '')):
            u = u.rstrip('.,;:!?')
            if len(u) < 2000 and not any(x['url'] == u for x in links):
                links.append({'label': label, 'url': u})
    add('說明中的連結', m.get('tips'))
    lic = m.get('license')
    if isinstance(lic, dict):
        add('授權說明中的連結', lic.get('desc'))
    for a in m.get('authors') or []:
        if isinstance(a, dict) and isinstance(a.get('contact'), dict):
            for k, v in a['contact'].items():
                add(f"{a.get('name') or '作者'}：{k}", v)
    link = m.get('link')
    if isinstance(link, dict):
        for k, v in link.items():
            add({'home': '模型主頁', 'donate': '贊助'}.get(k, str(k)), v)
    return links[:20]


def norm_meta(m):
    """把 ysm.json metadata 或舊版資訊整理成統一格式"""
    if not isinstance(m, dict):
        return {}
    authors = []
    for a in m.get('authors') or []:
        if isinstance(a, str):
            authors.append({'name': a})
        elif isinstance(a, dict):
            authors.append({'name': str(a.get('name', '')), 'role': str(a.get('role', '') or '')})
    lic = m.get('license')
    if isinstance(lic, dict):
        lic = lic.get('type') or ''
    return {
        'name': str(m.get('name') or ''),
        'tips': str(m.get('tips') or ''),
        'license': str(lic or ''),
        'authors': authors,
        'links': collect_links(m),
    }


def legacy_meta_from_geo(geo):
    try:
        d = geo['minecraft:geometry'][0]['description'].get('ysm_extra_info')
        return norm_meta(d) if d else {}
    except Exception:
        return {}


def human_size(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or u == 'GB':
            return f'{n:.0f} {u}' if u == 'B' else f'{n:.1f} {u}'
        n /= 1024


def path_id(path):
    return hashlib.sha1(os.path.normcase(os.path.abspath(path)).encode('utf-8')).hexdigest()[:16]


# ---------------------------------------------------------------- 資料庫
class Library:
    def __init__(self):
        self.lock = threading.RLock()
        self.data = {'version': 1, 'roots': [], 'models': {}, 'hash_cache': {}, 'repo': '', 'link_mode': 'hardlink'}
        if os.path.exists(DB_PATH):
            try:
                with open(DB_PATH, 'r', encoding='utf-8') as f:
                    self.data.update(json.load(f))
            except Exception:
                shutil.copy(DB_PATH, DB_PATH + '.broken')
        self.entries = {}  # id -> entry（掃描結果，只在記憶體）

    def save(self):
        with self.lock:
            tmp = DB_PATH + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, ensure_ascii=False, indent=1)
            os.replace(tmp, DB_PATH)

    def record(self, key):
        return self.data['models'].setdefault(key, {
            'tags': [], 'notes': '', 'rating': 0, 'display_name': '', 'thumb': '', 'added': int(time.time()),
        })


LIB = Library()


# ---------------------------------------------------------------- 掃描
def content_key(path, is_dir):
    """模型內容識別碼：搬移或改名後仍能對應到原本的標籤與縮圖"""
    st = os.stat(path)
    cache_k = os.path.normcase(path)
    if not is_dir:
        c = LIB.data['hash_cache'].get(cache_k)
        if c and c[0] == st.st_size and c[1] == int(st.st_mtime):
            return c[2]
        h = hashlib.sha1(str(st.st_size).encode())
        with open(path, 'rb') as f:
            h.update(f.read(256 * 1024))
            if st.st_size > 320 * 1024:
                f.seek(-64 * 1024, 2)
                h.update(f.read())
        key = h.hexdigest()[:20]
        LIB.data['hash_cache'][cache_k] = [st.st_size, int(st.st_mtime), key]
        return key
    h = hashlib.sha1(b'dir')
    for name in ('ysm.json', 'main.json'):
        p = os.path.join(path, name)
        if os.path.isfile(p):
            with open(p, 'rb') as f:
                h.update(f.read())
            break
    for r, _, files in os.walk(path):
        for fn in sorted(files):
            fp = os.path.join(r, fn)
            h.update(os.path.relpath(fp, path).replace('\\', '/').lower().encode('utf-8'))
            h.update(str(os.path.getsize(fp)).encode())
    return h.hexdigest()[:20]


def dir_size(path):
    total = 0
    for r, _, files in os.walk(path):
        for fn in files:
            try:
                total += os.path.getsize(os.path.join(r, fn))
            except OSError:
                pass
    return total


def folder_meta(path):
    p = os.path.join(path, 'ysm.json')
    if os.path.isfile(p):
        j = loose_json(read_text(p))
        meta = norm_meta(j.get('metadata'))
        meta['format'] = '2.x 資料夾'
        return meta
    meta = {}
    m = os.path.join(path, 'main.json')
    if os.path.isfile(m):
        try:
            meta = legacy_meta_from_geo(loose_json(read_text(m)))
        except Exception:
            meta = {}
    info = os.path.join(path, 'info.json')
    if os.path.isfile(info):
        try:
            meta.update({k: v for k, v in norm_meta(loose_json(read_text(info))).items() if v})
        except Exception:
            pass
    meta['format'] = '1.x 舊版資料夾'
    return meta


def zip_meta(path):
    meta = {'format': 'zip'}
    with zipfile.ZipFile(path) as z:
        infos = [(zip_name(i), i) for i in z.infolist() if not i.is_dir()]
        ysm = [(n, i) for n, i in infos if n.lower().rsplit('/', 1)[-1] == 'ysm.json']
        legacy = [(n, i) for n, i in infos if n.lower().rsplit('/', 1)[-1] == 'main.json']
        pack = [(n, i) for n, i in infos if n.lower().rsplit('/', 1)[-1] == 'ysm-pack.json']
        inner_ysm = [n for n, _ in infos if n.lower().endswith('.ysm')]
        if len(ysm) + len(inner_ysm) > 1 or pack:
            meta['format'] = '模型包 zip'
            meta['pack_count'] = len(ysm) + len(inner_ysm) + (len(legacy) if not ysm else 0)
            if pack:
                try:
                    pj = loose_json(z.read(pack[0][1]).decode('utf-8', errors='replace'))
                    meta['name'] = str(pj.get('name') or '')
                    meta['tips'] = str(pj.get('description') or '')
                except Exception:
                    pass
        elif ysm:
            j = loose_json(z.read(ysm[0][1]).decode('utf-8', errors='replace'))
            meta.update(norm_meta(j.get('metadata')))
            meta['format'] = '2.x zip'
        elif legacy:
            try:
                meta.update(legacy_meta_from_geo(loose_json(z.read(legacy[0][1]).decode('utf-8', errors='replace'))))
            except Exception:
                pass
            meta['format'] = '1.x 舊版 zip'
        else:
            meta['format'] = 'zip（未找到模型）'
    return meta


def ysm_public_summary(path):
    """
    只讀取 .ysm 開頭「未加密的公開摘要」（YSM 官方 Asset Container 標準：
    檔頭 EF BB BF 'YSGP' + 版本 + 換行，接著是以 0x00 結尾的純文字摘要）。
    不嘗試讀取或解密任何受保護內容；沒有公開摘要就回傳 None。
    """
    with open(path, 'rb') as f:
        head = f.read(8192)
    if not head.startswith(YSM_MAGIC):
        return None
    end_magic = head.find(b'\n\n')
    version = head[3:end_magic].decode('ascii', errors='replace') if end_magic > 0 else 'YSGP'
    start = end_magic + 2 if end_magic > 0 else len(YSM_MAGIC)
    nul = head.find(b'\x00', start)
    if nul < 0:
        return {'container': version, 'text': ''}
    text = head[start:nul].decode('utf-8', errors='replace').strip()
    if not text or sum(ch.isprintable() or ch in '\r\n\t' for ch in text) < len(text) * 0.9:
        text = ''
    return {'container': version, 'text': text[:3000]}


def guess_meta_from_summary(summary):
    """從公開摘要中找出常見欄位（名稱 / 作者），格式不明時僅顯示原文"""
    meta = {}
    if not summary or not summary.get('text'):
        return meta
    # YSM 官方匯出格式：「<name> 胡桃」「<author> 某人」，或 <author> 下一層縮排的 <name> / <role>
    authors, cur = [], None
    for line in summary['text'].splitlines():
        m = re.match(r'^(\s*)<([\w-]+)>\s*(.*?)\s*$', line)
        if not m:
            continue
        indent, tag, val = len(m.group(1)), m.group(2).lower(), m.group(3)
        if indent and cur is not None:  # 作者底下的子欄位
            if tag in ('name', 'role', 'comment') and val:
                cur[tag] = val
            continue
        cur = None
        if tag == 'author':
            cur = {'name': val} if val else {}
            authors.append(cur)
        elif tag == 'name' and val:
            meta.setdefault('name', val)
        elif tag == 'license' and val:
            meta['license'] = val
        elif tag.startswith('link-') and val:
            meta.setdefault('link', {})[tag[5:]] = val
    authors = [a for a in authors if a.get('name')]
    if authors:
        meta['authors'] = authors
    if meta:
        return meta
    for line in summary['text'].splitlines():
        m = re.match(r'\s*(name|model|名稱|名称|模型)\s*[:：=]\s*(.+)', line, re.I)
        if m and not meta.get('name'):
            meta['name'] = m.group(2).strip()
        m = re.match(r'\s*(author|authors|作者)\s*[:：=]\s*(.+)', line, re.I)
        if m and not meta.get('authors'):
            meta['authors'] = [{'name': a.strip()} for a in re.split(r'[,，、/]', m.group(2)) if a.strip()]
    return meta


def make_entry(path, root, source, enabled, rel, is_dir):
    st = os.stat(path)
    kind = 'folder' if is_dir else os.path.splitext(path)[1].lower().lstrip('.')
    e = {
        'id': path_id(path),
        'path': path,
        'root': root,
        'source': source,
        'enabled': enabled,
        'rel': rel.replace('\\', '/'),
        'group': os.path.dirname(rel).replace('\\', '/'),
        'kind': kind,
        'filename': os.path.basename(path),
        'size': dir_size(path) if is_dir else st.st_size,
        'mtime': int(st.st_mtime),
        'previewable': kind in ('folder', 'zip'),
        'meta': {},
        'summary': None,
        'error': '',
    }
    try:
        if kind == 'folder':
            e['meta'] = folder_meta(path)
        elif kind == 'zip':
            e['meta'] = zip_meta(path)
        elif kind == 'ysm':
            e['summary'] = ysm_public_summary(path)
            e['meta'] = guess_meta_from_summary(e['summary'])
            e['meta']['format'] = '加密 .ysm' + (f"（{e['summary']['container']}）" if e['summary'] else '')
        elif kind == '7z':
            e['meta'] = {'format': '7z 壓縮檔'}
    except Exception as ex:
        e['error'] = f'讀取資訊失敗：{ex}'
    try:
        e['key'] = content_key(path, is_dir)
    except Exception:
        e['key'] = e['id']
    if e['meta'].get('format', '').startswith('模型包'):
        e['previewable'] = True
    return e


def is_model_dir(path):
    return os.path.isfile(os.path.join(path, 'ysm.json')) or os.path.isfile(os.path.join(path, 'main.json'))


def scan_dir(base, root, source, enabled, out, depth=0, rel=''):
    try:
        items = sorted(os.scandir(base), key=lambda d: d.name.lower())
    except OSError:
        return
    for d in items:
        r = os.path.join(rel, d.name) if rel else d.name
        if d.is_dir():
            if is_model_dir(d.path):
                out.append(make_entry(d.path, root, source, enabled, r, True))
            elif depth < 6:
                scan_dir(d.path, root, source, enabled, out, depth + 1, r)
        elif d.name.lower().endswith(MODEL_EXTS):
            out.append(make_entry(d.path, root, source, enabled, r, False))


def normalize_root(path):
    """接受 .minecraft / 實例資料夾 / yes_steve_model / custom，統一成 yes_steve_model 資料夾"""
    path = os.path.abspath(os.path.expandvars(os.path.expanduser(path.strip().strip('"'))))
    if not os.path.isdir(path):
        raise ValueError('資料夾不存在：' + path)
    name = os.path.basename(path).lower()
    if name in SOURCES or name == DISABLED_DIRNAME:
        return os.path.dirname(path)
    for cand in (os.path.join(path, 'config', 'yes_steve_model'), os.path.join(path, '.minecraft', 'config', 'yes_steve_model'),
                 os.path.join(path, 'minecraft', 'config', 'yes_steve_model')):
        if os.path.isdir(cand):
            return cand
    return path  # 當作 yes_steve_model 或任意模型收藏資料夾


def detect_roots():
    found = []
    appdata = os.environ.get('APPDATA', '')
    home = os.path.expanduser('~')
    bases = [os.path.join(appdata, '.minecraft')]
    for parent in (os.path.join(appdata, '.minecraft', 'versions'),
                   os.path.join(home, 'curseforge', 'minecraft', 'Instances'),
                   os.path.join(appdata, 'PrismLauncher', 'instances'),
                   os.path.join(appdata, 'ModrinthApp', 'profiles'),
                   os.path.join(appdata, 'com.modrinth.theseus', 'profiles')):
        if os.path.isdir(parent):
            for d in os.scandir(parent):
                if d.is_dir():
                    bases.append(d.path)
    for b in bases:
        for cand in (os.path.join(b, 'config', 'yes_steve_model'), os.path.join(b, '.minecraft', 'config', 'yes_steve_model'),
                     os.path.join(b, 'minecraft', 'config', 'yes_steve_model')):
            if os.path.isdir(cand):
                found.append(cand)
    return sorted(set(found))


def screenshot_dirs(root):
    gd = None
    p = os.path.normpath(root)
    if os.path.basename(p).lower() == 'yes_steve_model' and os.path.basename(os.path.dirname(p)).lower() == 'config':
        gd = os.path.join(os.path.dirname(os.path.dirname(p)), 'screenshots')
    if gd:
        return [gd]  # 即使還不存在也允許（第一次 F2 時遊戲才會建立）
    dirs = []
    p = root
    for _ in range(3):  # yes_steve_model -> config -> 遊戲資料夾
        p = os.path.dirname(p)
        s = os.path.join(p, 'screenshots')
        if os.path.isdir(s):
            dirs.append(s)
            break
    return dirs


# ---------------------------------------------------------------- 倉庫與多實例安裝
HARDLINK_HINT = '硬連結失敗：倉庫和遊戲資料夾必須在同一個磁碟（例如都在 D:），且為 NTFS。請把倉庫移到同一個磁碟，或改用「複製」模式。'


def instance_name(root):
    """由 yes_steve_model 路徑推出實例（整合包）名稱"""
    p = os.path.normpath(root)
    if os.path.basename(p).lower() == 'yes_steve_model' and os.path.basename(os.path.dirname(p)).lower() == 'config':
        game = os.path.dirname(os.path.dirname(p))
        name = os.path.basename(game)
        if name.lower() in ('.minecraft', 'minecraft'):
            parent = os.path.dirname(game)
            pname = os.path.basename(parent)
            # Prism / MultiMC：instances/<名稱>/.minecraft
            if os.path.basename(os.path.dirname(parent)).lower() == 'instances':
                return pname
            return name
        return name
    return os.path.basename(p)


def is_instance_root(root):
    return os.path.isdir(os.path.join(root, 'custom')) or os.path.basename(os.path.normpath(root)).lower() == 'yes_steve_model'


def same_file(a, b):
    try:
        sa, sb = os.stat(a), os.stat(b)
        return sa.st_ino == sb.st_ino and sa.st_dev == sb.st_dev and sa.st_ino != 0
    except OSError:
        return False


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def tree_files(path):
    if os.path.isfile(path):
        return ['']
    out = []
    for r, _, fs in os.walk(path):
        for fn in fs:
            out.append(os.path.relpath(os.path.join(r, fn), path))
    return sorted(out)


def contents_equal(a, b):
    """完整比對兩個檔案或資料夾內容（硬連結直接視為相同）"""
    if os.path.isdir(a) != os.path.isdir(b):
        return False
    fa, fb = tree_files(a), tree_files(b)
    if [x.lower() for x in fa] != [x.lower() for x in fb]:
        return False
    for ra, rb in zip(fa, fb):
        pa = os.path.join(a, ra) if ra else a
        pb = os.path.join(b, rb) if rb else b
        if same_file(pa, pb):
            continue
        if os.path.getsize(pa) != os.path.getsize(pb) or sha256_file(pa) != sha256_file(pb):
            return False
    return True


def link_state(a, b):
    """'hardlink'：全部檔案都是同一份；'copy'：內容相同但各自佔空間"""
    files = tree_files(a)
    if files and all(same_file(os.path.join(a, r) if r else a, os.path.join(b, r) if r else b) for r in files):
        return 'hardlink'
    return 'copy'


def _put_file(src, dst, mode):
    if mode == 'hardlink':
        try:
            os.link(src, dst)
        except OSError:
            raise ValueError(HARDLINK_HINT)
    else:
        shutil.copy2(src, dst)


class NeedCopy(Exception):
    """要求硬連結但做不到，且使用者還沒同意改用複製"""


def _place(src, dst, mode):
    if os.path.isfile(src):
        _put_file(src, dst, mode)
        return
    try:
        for rel in tree_files(src):
            d = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            _put_file(os.path.join(src, rel), d, mode)
    except Exception:
        shutil.rmtree(dst, ignore_errors=True)
        raise


def place(src, dst, mode, allow_copy=True):
    """
    把倉庫中的模型放到目的地，失敗時清掉做到一半的內容。
    硬連結做不到時（不同磁碟、exFAT/FAT32 等不支援的格式）：allow_copy 才改用複製，否則丟出 NeedCopy。
    回傳實際使用的方式。
    """
    if os.path.exists(dst):
        raise ValueError('目的地已有同名的模型：' + dst)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if mode == 'hardlink':
        try:
            _place(src, dst, 'hardlink')
            return 'hardlink'
        except ValueError as ex:
            if str(ex) != HARDLINK_HINT:
                raise
            if os.path.isfile(dst):
                os.remove(dst)
            if not allow_copy:
                raise NeedCopy()
    _place(src, dst, 'copy')
    return 'copy'


def relink(repo_path, inst_path):
    """把實例中的複本換成指向倉庫的硬連結（內容必須相同）；回傳是否成功"""
    for rel in tree_files(repo_path):
        src = os.path.join(repo_path, rel) if rel else repo_path
        dst = os.path.join(inst_path, rel) if rel else inst_path
        if same_file(src, dst):
            continue
        tmp = dst + '.ysmlink_tmp'
        try:
            os.link(src, tmp)
        except OSError:
            return False
        os.replace(tmp, dst)
    return True


def can_recycle(path):
    """這個位置能不能丟進資源回收筒（固定磁碟且有回收筒；隨身碟等通常沒有）"""
    if sys.platform != 'win32':
        return False
    import ctypes
    from ctypes import wintypes
    drive = os.path.splitdrive(os.path.abspath(path))[0] + '\\'
    if ctypes.windll.kernel32.GetDriveTypeW(drive) != 3:  # DRIVE_FIXED
        return False

    class SHQUERYRBINFO(ctypes.Structure):
        _fields_ = [('cbSize', wintypes.DWORD), ('i64Size', ctypes.c_longlong), ('i64NumItems', ctypes.c_longlong)]
    info = SHQUERYRBINFO()
    info.cbSize = ctypes.sizeof(info)
    return ctypes.windll.shell32.SHQueryRecycleBinW(drive, ctypes.byref(info)) == 0


def send_to_recycle_bin(path):
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [('hwnd', wintypes.HWND), ('wFunc', ctypes.c_uint), ('pFrom', wintypes.LPCWSTR),
                    ('pTo', wintypes.LPCWSTR), ('fFlags', ctypes.c_ushort), ('fAnyOperationsAborted', wintypes.BOOL),
                    ('hNameMappings', ctypes.c_void_p), ('lpszProgressTitle', wintypes.LPCWSTR)]
    op = SHFILEOPSTRUCTW()
    op.wFunc = 3  # FO_DELETE
    op.pFrom = os.path.abspath(path) + '\0'  # 結尾需要兩個 \0
    op.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400  # ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0 or op.fAnyOperationsAborted or os.path.exists(path):
        raise ValueError(f'無法移到資源回收筒（錯誤碼 {rc}）')


def check_folder_name(name):
    name = (name or '').strip()
    if (not name or re.search(r'[\\/:*?"<>|]', name) or name in ('.', '..') or name.endswith('.')
            or len(name) > 80 or name.lower() == DISABLED_DIRNAME.lower()):
        raise ValueError('資料夾名稱不能空白、不能以 . 結尾，也不能含有 \\ / : * ? " < > |')
    return name


def remove_model(path):
    if os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


# ---------------------------------------------------------------- 遊戲內截圖（模擬按鍵）
# 在遊戲中用 YSM 指令切換模型，再按 F2 截圖。模型由遊戲本身顯示，不讀取任何加密內容。
class GameInput:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.user32 = ctypes.WinDLL('user32', use_last_error=True)
        u = self.user32
        u.GetForegroundWindow.restype = wintypes.HWND
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.IsWindow.argtypes = [wintypes.HWND]
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsIconic.argtypes = [wintypes.HWND]
        u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        u.SetForegroundWindow.argtypes = [wintypes.HWND]
        u.BringWindowToTop.argtypes = [wintypes.HWND]
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.c_void_p]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                        ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD),
                        ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]

        class _U(ctypes.Union):
            _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [('type', wintypes.DWORD), ('u', _U)]

        self.KEYBDINPUT, self.INPUT = KEYBDINPUT, INPUT
        u.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        u.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                          wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
        u.SendMessageTimeoutW.restype = ctypes.c_size_t
        try:
            self.imm = ctypes.WinDLL('imm32')
            self.imm.ImmGetDefaultIMEWnd.argtypes = [wintypes.HWND]
            self.imm.ImmGetDefaultIMEWnd.restype = wintypes.HWND
        except OSError:
            self.imm = None

    # 遊戲視窗若開著中文輸入法，打字時空白、「-」等會被輸入法拿去組字，指令就會亂掉。
    # 用 WM_IME_CONTROL 暫時關掉該視窗的輸入法（跨程序也有效），打完再還原。
    def _ime_msg(self, hwnd, cmd, val=0):
        if not self.imm:
            return None
        ime = self.imm.ImmGetDefaultIMEWnd(hwnd)
        if not ime:
            return None
        out = self.ctypes.c_size_t(0)
        ok = self.user32.SendMessageTimeoutW(ime, 0x0283, cmd, val, 0x0002, 300, self.ctypes.byref(out))  # WM_IME_CONTROL, SMTO_ABORTIFHUNG
        return out.value if ok else None

    def ime_off(self, hwnd):
        """關閉輸入法，回傳原本是否開著（None = 無法得知）"""
        prev = self._ime_msg(hwnd, 0x0005)  # IMC_GETOPENSTATUS
        if prev:
            self._ime_msg(hwnd, 0x0006, 0)  # IMC_SETOPENSTATUS → 關
        return prev

    def ime_restore(self, hwnd, prev):
        if prev:
            self._ime_msg(hwnd, 0x0006, 1)

    def _text(self, hwnd, fn, getlen=None):
        buf = self.ctypes.create_unicode_buffer(512)
        fn(hwnd, buf, 512)
        return buf.value

    def windows(self):
        from ctypes import wintypes
        found = []
        proc = self.ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def cb(hwnd, _):
            if not self.user32.IsWindowVisible(hwnd):
                return True
            title = self._text(hwnd, self.user32.GetWindowTextW)
            cls = self._text(hwnd, self.user32.GetClassNameW)
            # Minecraft 1.13+ 使用 GLFW 視窗（類別 GLFW30）；舊版用 LWJGL
            if cls.startswith('GLFW') or cls == 'LWJGL' or ('minecraft' in title.lower() and 'launcher' not in title.lower() and title != APP_NAME):
                if title and title != APP_NAME:
                    found.append({'hwnd': int(hwnd), 'title': title, 'cls': cls})
            return True

        self.user32.EnumWindows(proc(cb), 0)
        return found

    def _send(self, inputs):
        n = len(inputs)
        arr = (self.INPUT * n)(*inputs)
        self.user32.SendInput(n, arr, self.ctypes.sizeof(self.INPUT))

    def _key(self, scan, up):
        i = self.INPUT()
        i.type = 1
        i.u.ki = self.KEYBDINPUT(0, scan, 0x0008 | (0x0002 if up else 0), 0, 0)
        return i

    def tap(self, scan, hold=0.05):
        self._send([self._key(scan, False)])
        time.sleep(hold)
        self._send([self._key(scan, True)])

    def type_text(self, text):
        for ch in text:
            code = ord(ch)
            down, up = self.INPUT(), self.INPUT()
            down.type = up.type = 1
            down.u.ki = self.KEYBDINPUT(0, code, 0x0004, 0, 0)
            up.u.ki = self.KEYBDINPUT(0, code, 0x0004 | 0x0002, 0, 0)
            self._send([down, up])
            time.sleep(0.012)

    def foreground(self):
        return int(self.user32.GetForegroundWindow() or 0)

    def focus(self, hwnd):
        if not self.user32.IsWindow(hwnd):
            raise ValueError('找不到遊戲視窗，請確認遊戲還開著，並重新整理視窗清單')
        if self.user32.IsIconic(hwnd):
            self.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        u = self.user32
        k32 = self.ctypes.WinDLL('kernel32')
        for attempt in range(4):
            fg = u.GetForegroundWindow()
            cur_tid = k32.GetCurrentThreadId()
            fg_tid = u.GetWindowThreadProcessId(fg, None) if fg else 0
            attached = False
            if fg_tid and fg_tid != cur_tid:
                # 暫時共用前景視窗的輸入狀態，Windows 才允許切換前景
                attached = bool(u.AttachThreadInput(cur_tid, fg_tid, True))
            try:
                if attempt >= 1:
                    self.tap(0x38, 0.01)  # 再補按一下 Alt
                u.ShowWindow(hwnd, 5)  # SW_SHOW
                u.SetForegroundWindow(hwnd)
                u.BringWindowToTop(hwnd)
            finally:
                if attached:
                    u.AttachThreadInput(cur_tid, fg_tid, False)
            time.sleep(0.35)
            if self.foreground() == hwnd:
                return
        raise ValueError('無法把遊戲視窗切到最前面，請手動點一下遊戲視窗後再試')


GAME = None
SCAN_T, SCAN_ENTER, SCAN_F1, SCAN_F2, SCAN_ESC = 0x14, 0x1C, 0x3B, 0x3C, 0x01


BRIDGE_JAR = 'ysmshot-forge-1.20.1-1.0.jar'


def game_dir_of(root):
    p = os.path.normpath(root)
    if os.path.basename(p).lower() == 'yes_steve_model' and os.path.basename(os.path.dirname(p)).lower() == 'config':
        return os.path.dirname(os.path.dirname(p))
    return None


def _remove_thumb_files(names):
    for n in names:
        if not n:
            continue
        try:
            os.remove(os.path.join(THUMB_DIR, os.path.basename(n)))
        except OSError:
            pass


def list_images(d):
    try:
        return {f.name: f.stat().st_size for f in os.scandir(d) if f.is_file() and f.name.lower().endswith(('.png', '.jpg'))}
    except OSError:
        return {}


# ---------------------------------------------------------------- API
class Api:
    window = None

    def get_state(self):
        return {
            'roots': LIB.data['roots'], 'data_dir': DATA_DIR, 'app': APP_NAME,
            'repo': LIB.data.get('repo', ''), 'link_mode': LIB.data.get('link_mode', 'hardlink'),
            'instances': [{'root': r, 'name': instance_name(r), 'is_instance': is_instance_root(r)} for r in LIB.data['roots']],
        }

    # ---------- 遊戲內截圖 ----------
    def _game(self):
        global GAME
        if GAME is None:
            GAME = GameInput()
        return GAME

    def game_windows(self):
        return self._game().windows()

    def game_shot(self, hwnd, root, command, wait_sec):
        """
        對遊戲視窗：按 T 開聊天 → 輸入指令 → Enter → 等模型載入 → F2 截圖，
        回傳新截圖的路徑。遊戲視窗不在最前面時立即停止（使用者切走 = 中止）。
        """
        g = self._game()
        hwnd = int(hwnd)
        gd = game_dir_of(root)
        if not gd:
            raise ValueError('找不到這個實例的遊戲資料夾（需要 …/config/yes_steve_model）')
        shots = os.path.join(gd, 'screenshots')
        # 可以一次送多條指令（例如先解除隱形再換模型），依序輸入
        commands = command if isinstance(command, list) else [command]
        if not 1 <= len(commands) <= 4:
            raise ValueError('指令格式不正確')
        for c in commands:
            if not isinstance(c, str) or not c.startswith('/') or '\n' in c or len(c) > 240:
                raise ValueError('指令格式不正確')
        wait_sec = max(0.5, min(float(wait_sec), 20))

        def ensure_front():
            if g.foreground() != hwnd:
                raise ValueError('遊戲視窗不在最前面，已停止（切換視窗會中止截圖）')

        g.focus(hwnd)
        time.sleep(0.3)
        ensure_front()
        ime_prev = g.ime_off(hwnd)
        try:
            for i, c in enumerate(commands):
                if i:
                    time.sleep(0.35)
                g.tap(SCAN_T)
                time.sleep(0.45)
                ensure_front()
                g.type_text(c)
                time.sleep(0.15)
                ensure_front()
                g.tap(SCAN_ENTER)
        finally:
            g.ime_restore(hwnd, ime_prev)
        time.sleep(wait_sec)
        ensure_front()
        before = list_images(shots)
        # 截圖前按 F1 隱藏介面（聊天訊息、快捷欄不會擋到模型），截完再按一次還原
        g.tap(SCAN_F1)
        time.sleep(0.2)
        try:
            g.tap(SCAN_F2)
        finally:
            time.sleep(0.3)
            g.tap(SCAN_F1)
        deadline = time.time() + 8
        new = None
        while time.time() < deadline:
            time.sleep(0.25)
            now = list_images(shots)
            added = [n for n in now if n not in before]
            if added:
                new = os.path.join(shots, sorted(added)[-1])
                break
        if not new:
            raise ValueError('按了 F2 但沒有找到新截圖。請確認截圖鍵是 F2、遊戲沒有開著選單，且這個視窗屬於所選的實例')
        # 等檔案寫完
        last = -1
        for _ in range(20):
            size = os.path.getsize(new)
            if size == last and size > 0:
                break
            last = size
            time.sleep(0.15)
        return {'path': new}

    # ---------- 配套 MOD（YSM Shot）----------
    def _bridge(self, root):
        gd = game_dir_of(root)
        if not gd:
            raise ValueError('找不到這個實例的遊戲資料夾（需要 …/config/yes_steve_model）')
        cfg = os.path.join(gd, 'config', 'ysmshot.json')
        try:
            with open(cfg, encoding='utf-8') as f:
                info = json.load(f)
            port, token = int(info['port']), str(info['token'])
        except (OSError, ValueError, KeyError, TypeError):
            raise ValueError('這個實例沒有執行中的 YSM Shot MOD。請確認已把 ysmshot 放進 mods 並啟動遊戲')
        return port, token

    def _bridge_req(self, root, path, body=None, timeout=10):
        import urllib.request
        import urllib.error
        port, token = self._bridge(root)
        data = None if body is None else json.dumps(body).encode('utf-8')
        req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data,
                                     method='GET' if body is None else 'POST',
                                     headers={'X-YsmShot-Token': token, 'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=timeout) as r:
                return r.headers, r.read()
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode('utf-8')).get('error', '')
            except Exception:
                err = str(e)
            msg = {
                'not_in_world': '遊戲還沒進入世界，請先進入單人世界',
                'paused': '遊戲已暫停（開著選單或視窗失去焦點）。請在遊戲中按 F3+P 關閉「失去焦點時暫停」，並關閉選單',
                'bad token': '連線驗證失敗，請重新啟動遊戲',
            }.get(err, err)
            raise ValueError(msg)
        except OSError:
            raise ValueError('連不上遊戲中的 YSM Shot MOD（遊戲沒開、或已關閉）')

    def install_bridge_mod(self, root):
        """把內附的 YSM Shot jar 複製到實例的 mods 資料夾（同名舊版會被取代）。"""
        gd = game_dir_of(root)
        if not gd:
            raise ValueError('找不到這個實例的遊戲資料夾（需要 …/config/yes_steve_model）')
        src = os.path.join(APP_DIR, 'mods', BRIDGE_JAR)
        if not os.path.isfile(src):
            raise ValueError('程式內找不到 YSM Shot MOD 檔案')
        mods = os.path.join(gd, 'mods')
        os.makedirs(mods, exist_ok=True)
        removed = []
        for f in os.listdir(mods):
            if f.lower().startswith('ysmshot-') and f.lower().endswith('.jar') and f != BRIDGE_JAR:
                os.remove(os.path.join(mods, f))
                removed.append(f)
        shutil.copy2(src, os.path.join(mods, BRIDGE_JAR))
        return {'path': os.path.join(mods, BRIDGE_JAR), 'removed': removed}

    def bridge_ids(self, root):
        """向遊戲要 /ysm model set 的自動完成清單（= YSM 目前載入的所有模型 ID）。"""
        _, raw = self._bridge_req(root, '/suggest', {'text': 'ysm model set @s '}, timeout=20)
        res = json.loads(raw.decode('utf-8'))
        if not res.get('ok'):
            raise ValueError({'not_in_world': '遊戲還沒進入世界，請先進入單人世界'}.get(res.get('error'), res.get('error') or '讀取失敗'))
        ids = []
        for s in res.get('suggestions', []):
            t = s.get('text', '')
            if len(t) >= 2 and t[0] == '"' and t[-1] == '"':
                t = re.sub(r'\\(.)', r'\1', t[1:-1])
            ids.append(t)
        return ids

    def bridge_status(self, root):
        _, raw = self._bridge_req(root, '/status', timeout=6)
        return json.loads(raw.decode('utf-8'))

    def bridge_shot(self, root, command, wait_sec, size=768, zoom=1.0, yaw=0):
        if not isinstance(command, str) or '\n' in command or len(command) > 240:
            raise ValueError('指令格式不正確')
        wait_ticks = int(max(0, min(float(wait_sec), 20)) * 20)
        headers, raw = self._bridge_req(root, '/shot', {
            'command': command, 'waitTicks': wait_ticks, 'size': int(size),
            'zoom': float(zoom), 'yaw': float(yaw)}, timeout=wait_ticks / 20 + 25)
        if not headers.get('Content-Type', '').startswith('image/png'):
            raise ValueError('MOD 回傳的不是圖片')
        try:
            messages = json.loads(base64.b64decode(headers.get('X-YsmShot-Messages', '')).decode('utf-8') or '[]')
        except Exception:
            messages = []
        return {'png': base64.b64encode(raw).decode('ascii'), 'messages': messages}

    # ---------- 倉庫 ----------
    def set_repo(self, path):
        if not path:
            with LIB.lock:
                LIB.data['repo'] = ''
                LIB.save()
            return self.get_state()
        path = os.path.abspath(os.path.expandvars(path.strip().strip('"')))
        for r in LIB.data['roots']:
            rn = os.path.normcase(os.path.abspath(r))
            pn = os.path.normcase(path)
            if pn == rn or pn.startswith(rn + os.sep) or rn.startswith(pn + os.sep):
                raise ValueError('倉庫不能放在遊戲實例資料夾裡（也不能包含遊戲實例），請選另一個資料夾，例如 D:\\YSM倉庫')
        os.makedirs(path, exist_ok=True)
        with LIB.lock:
            LIB.data['repo'] = path
            LIB.save()
        return self.get_state()

    def set_link_mode(self, mode):
        if mode not in ('hardlink', 'copy'):
            raise ValueError('未知的模式')
        with LIB.lock:
            LIB.data['link_mode'] = mode
            LIB.save()
        return self.get_state()

    def _repo_entry_for(self, key):
        for e in LIB.entries.values():
            if e.get('location') == 'repo' and e['key'] == key and os.path.exists(e['path']):
                return e
        return None

    def install(self, repo_id, root, allow_copy=False):
        """硬連結做不到時：allow_copy=False 且設定要求詢問 → 回傳 need_copy，什麼都不做"""
        try:
            return self._install(repo_id, root, allow_copy or not SETTINGS['confirm_copy'])
        except NeedCopy:
            return {'need_copy': True}

    def _install(self, repo_id, root, allow_copy):
        e = self._entry(repo_id)
        if e.get('location') != 'repo':
            raise ValueError('只能從倉庫安裝')
        if root not in LIB.data['roots'] or not is_instance_root(root):
            raise ValueError('這不是遊戲實例的 yes_steve_model 資料夾')
        for x in LIB.entries.values():
            if x.get('location') == root and x['key'] == e['key']:
                return {'path': x['path'], 'already': True}
        # 倉庫中的子資料夾也照樣放進遊戲的 custom（模型 ID 會是「資料夾/檔名」）
        sub = [p for p in (e.get('group') or '').split('/') if p]
        dst = os.path.join(root, 'custom', *sub, e['filename'])
        if os.path.exists(os.path.join(root, DISABLED_DIRNAME, 'custom', *sub, e['filename'])):
            raise ValueError('這個實例中有同名的停用模型，請先處理')
        used = place(e['path'], dst, LIB.data.get('link_mode', 'hardlink'), allow_copy)
        return {'path': dst, 'mode': used, 'fallback': used != LIB.data.get('link_mode', 'hardlink')}

    def install_many(self, ids, root, allow_copy=False):
        """把選取的倉庫模型裝到某個實例；需要改用複製而還沒同意時，停在第一個並回傳 need_copy"""
        done, copied, skipped, errors = 0, 0, 0, []
        have = {x['key'] for x in LIB.entries.values() if x.get('location') == root}
        for eid in ids:
            e = LIB.entries.get(eid)
            if not e or e.get('location') != 'repo' or e['key'] in have:
                skipped += 1
                continue
            try:
                res = self.install(e['id'], root, allow_copy)
                if res.get('need_copy'):
                    return {'need_copy': True, 'done': done, 'copied': copied, 'skipped': skipped, 'errors': errors}
                have.add(e['key'])
                done += 1
                if res.get('fallback'):
                    copied += 1
            except Exception as ex:
                errors.append(f"{e['filename']}：{ex}")
        return {'done': done, 'copied': copied, 'skipped': skipped, 'errors': errors}

    # ---------- 倉庫子資料夾 ----------
    def _repo(self):
        repo = LIB.data.get('repo')
        if not repo or not os.path.isdir(repo):
            raise ValueError('請先設定倉庫資料夾')
        return repo

    def _folder_path(self, rel):
        parts = [p for p in (rel or '').replace('\\', '/').split('/') if p]
        for p in parts:
            check_folder_name(p)
        return os.path.join(self._repo(), *parts), '/'.join(parts)

    def repo_folders(self):
        """倉庫中所有的分類資料夾（不含模型資料夾本身），用 / 分隔的相對路徑"""
        repo = LIB.data.get('repo')
        out = []
        if not repo or not os.path.isdir(repo):
            return out

        def walk(base, rel, depth):
            try:
                items = sorted(os.scandir(base), key=lambda d: d.name.lower())
            except OSError:
                return
            for d in items:
                if d.is_dir() and not is_model_dir(d.path):
                    r = f'{rel}/{d.name}' if rel else d.name
                    out.append(r)
                    if depth < 5:
                        walk(d.path, r, depth + 1)
        walk(repo, '', 0)
        return out

    def create_folder(self, parent, name):
        base, _ = self._folder_path(parent)
        name = check_folder_name(name)
        path = os.path.join(base, name)
        if os.path.exists(path):
            raise ValueError('已經有同名的資料夾或檔案')
        os.makedirs(path)
        return self.repo_folders()

    def _repo_in_folder(self, rel):
        return [e for e in LIB.entries.values() if e.get('location') == 'repo'
                and (e.get('group') == rel or (e.get('group') or '').startswith(rel + '/'))]

    def rename_folder(self, rel, new_name):
        old, rel = self._folder_path(rel)
        if not rel or not os.path.isdir(old):
            raise ValueError('找不到這個資料夾，請重新掃描')
        new_name = check_folder_name(new_name)
        new = os.path.join(os.path.dirname(old), new_name)
        if os.path.normcase(new) == os.path.normcase(old) and new_name == os.path.basename(old):
            return {'folders': self.repo_folders(), 'moved': 0, 'errors': []}
        if os.path.exists(new) and os.path.normcase(new) != os.path.normcase(old):
            raise ValueError('已經有同名的資料夾或檔案')
        new_rel = (rel.rsplit('/', 1)[0] + '/' + new_name) if '/' in rel else new_name
        moves = [(e['key'], new_rel + e['group'][len(rel):]) for e in self._repo_in_folder(rel)]
        os.rename(old, new)
        moved, errors = self._sync_installs(moves)
        return {'folders': self.repo_folders(), 'moved': moved, 'errors': errors}

    def move_folder(self, rel, dest):
        """把整個子資料夾移到另一個資料夾底下；已安裝到遊戲的模型也照新結構移動"""
        old, rel = self._folder_path(rel)
        base, dest = self._folder_path(dest)
        if not rel or not os.path.isdir(old):
            raise ValueError('找不到這個資料夾，請重新掃描')
        if dest == rel or dest.startswith(rel + '/'):
            raise ValueError(f'不能把「{rel}」移到它自己裡面')
        name = rel.split('/')[-1]
        new_rel = f'{dest}/{name}' if dest else name
        if new_rel == rel:
            return {'moved': 0, 'errors': []}
        new = os.path.join(base, name)
        if os.path.exists(new):
            raise ValueError(f'目的地已經有名為「{name}」的資料夾或檔案')
        moves = [(e['key'], new_rel + e['group'][len(rel):]) for e in self._repo_in_folder(rel)]
        os.makedirs(base, exist_ok=True)
        shutil.move(old, new)
        moved, errors = self._sync_installs(moves)
        return {'moved': moved, 'errors': errors}

    def delete_folder_all(self, rel):
        """刪除整個資料夾（含裡面的模型）；能用資源回收筒就丟進回收筒。遊戲中已安裝的那份不受影響"""
        path, rel = self._folder_path(rel)
        if not rel or not os.path.isdir(path):
            raise ValueError('找不到這個資料夾，請重新掃描')
        n = len(self._repo_in_folder(rel))
        recycled = can_recycle(path)
        if recycled:
            send_to_recycle_bin(path)
        else:
            shutil.rmtree(path)
        for e in self._repo_in_folder(rel):
            LIB.entries.pop(e['id'], None)
        return {'models': n, 'recycled': recycled}

    def delete_folder(self, rel):
        path, rel = self._folder_path(rel)
        if not rel or not os.path.isdir(path):
            raise ValueError('找不到這個資料夾，請重新掃描')
        for _, _, files in os.walk(path):
            if files:
                raise ValueError('資料夾裡還有檔案，請先把模型移到其他資料夾')
        shutil.rmtree(path)
        return self.repo_folders()

    def move_models(self, ids, folder):
        """把倉庫模型移到另一個子資料夾；已安裝到遊戲的也一起移到相同位置"""
        base, folder = self._folder_path(folder)
        os.makedirs(base, exist_ok=True)
        done, errors, moves = 0, [], []
        for eid in ids:
            e = LIB.entries.get(eid)
            if not e or e.get('location') != 'repo':
                continue
            dst = os.path.join(base, e['filename'])
            if os.path.normcase(os.path.abspath(dst)) == os.path.normcase(os.path.abspath(e['path'])):
                continue
            if os.path.exists(dst):
                errors.append(f"{e['filename']}：目的資料夾已有同名的模型")
                continue
            try:
                shutil.move(e['path'], dst)
                done += 1
                moves.append((e['key'], folder))
            except Exception as ex:
                errors.append(f"{e['filename']}：{ex}")
        moved, errs = self._sync_installs(moves)
        return {'done': done, 'moved_installs': moved, 'errors': errors + errs}

    def _sync_installs(self, moves):
        """倉庫模型換資料夾後，把各實例 custom 中同一個模型移到對應的子資料夾"""
        moved, errors = 0, []
        for key, group in moves:
            sub = [p for p in group.split('/') if p]
            for x in list(LIB.entries.values()):
                if x.get('location') in (None, 'repo') or x['key'] != key or x.get('source') != 'custom':
                    continue
                base = os.path.join(x['root'], 'custom') if x['enabled'] else os.path.join(x['root'], DISABLED_DIRNAME, 'custom')
                dst = os.path.join(base, *sub, x['filename'])
                if os.path.normcase(dst) == os.path.normcase(x['path']) or not os.path.exists(x['path']):
                    continue
                if os.path.exists(dst):
                    errors.append(f"{x['instance']}：{x['filename']} 的目的位置已有同名模型")
                    continue
                try:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.move(x['path'], dst)
                    moved += 1
                    p = os.path.dirname(x['path'])  # 清掉留下的空資料夾
                    while os.path.normcase(p).startswith(os.path.normcase(base) + os.sep):
                        try:
                            os.rmdir(p)
                        except OSError:
                            break
                        p = os.path.dirname(p)
                except Exception as ex:
                    errors.append(f"{x['instance']}：{x['filename']}：{ex}")
        return moved, errors

    # ---------- 刪除模型（倉庫或遊戲實例中的）----------
    def delete_info(self, eid):
        e = self._entry(eid)
        in_repo = e.get('location') == 'repo'
        if in_repo:
            others = sorted({instance_name(x['root']) for x in LIB.entries.values()
                             if x.get('location') not in (None, 'repo') and x['key'] == e['key']})
        else:
            others = sorted({instance_name(x['root']) for x in LIB.entries.values()
                             if x.get('location') not in (None, 'repo') and x['key'] == e['key'] and x['id'] != eid})
        return {'name': e['filename'], 'path': e['path'], 'size': human_size(e['size']),
                'in_repo': in_repo, 'instance': '' if in_repo else instance_name(e['root']),
                'installs': others,  # 倉庫：已安裝在哪些實例；實例：其他也有這個模型的實例
                'backup': (not in_repo) and bool(self._repo_entry_for(e['key'])),
                'recycle': can_recycle(e['path'])}

    def delete_model(self, eid):
        """刪除倉庫或遊戲實例中的一個模型（能用資源回收筒就丟進回收筒）。其他位置的同一個模型不受影響。"""
        e = self._entry(eid)
        base = (LIB.data.get('repo') or '') if e.get('location') == 'repo' else e.get('root', '')
        if e.get('location') != 'repo' and base not in LIB.data['roots']:
            raise ValueError('這個模型不屬於已加入的遊戲實例，不會刪除')
        p = os.path.normcase(os.path.abspath(e['path']))
        if not base or not p.startswith(os.path.normcase(os.path.abspath(base)) + os.sep):
            raise ValueError('這個檔案不在倉庫或遊戲實例的資料夾內，不會刪除')
        recycled = can_recycle(e['path'])
        if recycled:
            send_to_recycle_bin(e['path'])
        else:
            remove_model(e['path'])
        LIB.entries.pop(eid, None)
        return {'recycled': recycled}

    def delete_many(self, ids, where='repo'):
        """批量刪除。where='repo'：只刪倉庫中的（實例中已安裝的那份不受影響）；
        where='instance'：只刪遊戲實例中的（倉庫中的不受影響）"""
        done, recycled, errors = 0, 0, []
        for eid in ids:
            e = LIB.entries.get(eid)
            if not e or (e.get('location') == 'repo') != (where == 'repo'):
                continue
            try:
                if self.delete_model(eid)['recycled']:
                    recycled += 1
                done += 1
            except Exception as ex:
                errors.append(f"{e['filename']}：{ex}")
        return {'done': done, 'recycled': recycled, 'errors': errors}

    # ---------- 解除安裝管理器 ----------
    def _bridge_mod_files(self):
        out = []
        for r in LIB.data['roots']:
            gd = game_dir_of(r)
            if not gd:
                continue
            mods = os.path.join(gd, 'mods')
            try:
                for f in os.listdir(mods):
                    if f.lower().startswith('ysmshot-') and f.lower().endswith('.jar'):
                        out.append((r, os.path.join(mods, f)))
            except OSError:
                pass
        return out

    def uninstall_info(self):
        disabled = [e for e in LIB.entries.values() if e.get('location') not in (None, 'repo') and not e['enabled']]
        return {
            'base_dir': BASE_DIR, 'data_dir': DATA_DIR,
            'exe': sys.executable if getattr(sys, 'frozen', False) else '',
            'disabled': len(disabled),
            'mod_instances': sorted({instance_name(r) for r, _ in self._bridge_mod_files()}),
        }

    def uninstall_app(self, restore_disabled=True, remove_mod=True):
        """
        解除安裝管理器本身：先（選擇性地）把停用的模型移回原位、移除各實例的 YSM Shot MOD，
        再關閉程式，由背景腳本在程式結束後刪除管理器的資料與 exe。遊戲與模型檔案不會被刪除。
        """
        problems = []
        if restore_disabled:
            for e in [x for x in LIB.entries.values() if x.get('location') not in (None, 'repo') and not x['enabled']]:
                try:
                    self.set_enabled(e['id'], True)
                except Exception as ex:
                    problems.append(f"{e['filename']}：{ex}")
        if remove_mod:
            for r, jar in self._bridge_mod_files():
                try:
                    os.remove(jar)
                except OSError:
                    problems.append(f'{instance_name(r)} 的 YSM Shot MOD 無法刪除（遊戲可能正在執行）')
                try:
                    os.remove(os.path.join(game_dir_of(r), 'config', 'ysmshot.json'))
                except OSError:
                    pass
        if problems:
            # 有東西沒處理好就不要繼續，讓使用者先處理
            raise ValueError('解除安裝已中止：' + '；'.join(problems[:3]) + ('…' if len(problems) > 3 else ''))

        def q(p):
            return "'" + p.replace("'", "''") + "'"
        frozen = getattr(sys, 'frozen', False)
        pids = [os.getpid()] + ([os.getppid()] if frozen else [])  # onefile 版有一個啟動用的父行程
        lines = [
            "$ErrorActionPreference = 'SilentlyContinue'",
            f"$pids = @({', '.join(map(str, pids))})",
            "while ($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }) { Start-Sleep -Milliseconds 500 }",
            "Start-Sleep -Seconds 1",
        ]
        # 只刪除管理器自己的檔案；資料夾（可能是使用者自選的）只在清空後才移除
        for d in {os.path.normcase(DATA_DIR): DATA_DIR, os.path.normcase(BASE_DIR): BASE_DIR}.values():
            for name in ('library.json', 'library.json.tmp', 'library.json.broken', 'settings.json', 'settings.json.tmp'):
                lines.append(f"Remove-Item -LiteralPath {q(os.path.join(d, name))} -Force")
            for name in ('thumbs', 'webview'):
                lines.append(f"Remove-Item -LiteralPath {q(os.path.join(d, name))} -Recurse -Force")
            lines.append(f"if (-not (Get-ChildItem -LiteralPath {q(d)} -Force)) {{ Remove-Item -LiteralPath {q(d)} -Force }}")
        if frozen:
            lines.append(f"Remove-Item -LiteralPath {q(sys.executable)} -Force")
        lines.append("Remove-Item -LiteralPath $PSCommandPath -Force")
        script = os.path.join(os.environ.get('TEMP') or BASE_DIR, f'ysm_manager_uninstall_{os.getpid()}.ps1')
        with open(script, 'w', encoding='utf-8-sig') as f:
            f.write('\r\n'.join(lines) + '\r\n')
        cmd = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script]
        base_flags = 0x08000000 | 0x00000200  # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        try:
            subprocess.Popen(cmd, creationflags=base_flags | 0x01000000, close_fds=True)  # + CREATE_BREAKAWAY_FROM_JOB
        except OSError:
            subprocess.Popen(cmd, creationflags=base_flags, close_fds=True)

        def bye():
            time.sleep(1.2)
            try:
                if self.window:
                    self.window.destroy()
                    return
            except Exception:
                pass
            os._exit(0)
        threading.Thread(target=bye, daemon=True).start()
        return {'ok': True, 'exe': sys.executable if frozen else ''}

    # ---------- 設定 ----------
    def get_settings(self):
        return dict(SETTINGS, data_dir_now=DATA_DIR, data_dir_default=BASE_DIR, version=APP_VERSION, github=GITHUB_URL)

    def open_project_page(self, which='home'):
        """開啟本專案的 GitHub 頁面（固定網址，不需警告）"""
        import webbrowser
        webbrowser.open(GITHUB_URL + ('/releases/latest' if which == 'releases' else ''), new=2)
        return True

    def set_settings(self, patch):
        for k in ('lang', 'confirm_copy', 'confirm_delete_twice', 'group_versions'):
            if k in patch:
                v = patch[k]
                if k == 'lang' and v not in ('zh-Hant',):
                    raise ValueError('不支援的語言')
                SETTINGS[k] = bool(v) if k != 'lang' else v
        save_settings()
        return self.get_settings()

    def move_data_dir(self, new_dir):
        """把模型資料庫（標籤、評分、備註…）與縮圖搬到新的資料夾"""
        global DATA_DIR, THUMB_DIR, DB_PATH
        new_dir = os.path.abspath(os.path.expandvars((new_dir or '').strip().strip('"'))) if new_dir else BASE_DIR
        old_dir = DATA_DIR
        if os.path.normcase(new_dir) == os.path.normcase(old_dir):
            return self.get_settings()
        nn, tn = os.path.normcase(new_dir), os.path.normcase(THUMB_DIR)
        if nn == tn or nn.startswith(tn + os.sep):
            raise ValueError('不能搬到目前的縮圖資料夾裡')
        if os.path.exists(os.path.join(new_dir, 'library.json')):
            raise ValueError('那個資料夾裡已經有模型資料庫（library.json），請選一個空的資料夾')
        new_thumbs = os.path.join(new_dir, 'thumbs')
        os.makedirs(new_thumbs, exist_ok=True)
        with LIB.lock:
            names = [f for f in os.listdir(THUMB_DIR) if os.path.isfile(os.path.join(THUMB_DIR, f))]
            for f in names:
                shutil.copy2(os.path.join(THUMB_DIR, f), os.path.join(new_thumbs, f))
            old_thumbs, old_db = THUMB_DIR, DB_PATH
            DATA_DIR, THUMB_DIR, DB_PATH = new_dir, new_thumbs, os.path.join(new_dir, 'library.json')
            LIB.save()
            SETTINGS['data_dir'] = '' if os.path.normcase(new_dir) == os.path.normcase(BASE_DIR) else new_dir
            save_settings()
            # 新位置都寫好後才清掉舊的（只刪自己的檔案）
            for f in names:
                try:
                    os.remove(os.path.join(old_thumbs, f))
                except OSError:
                    pass
            for f in (old_db, old_db + '.tmp'):
                try:
                    os.remove(f)
                except OSError:
                    pass
            try:
                os.rmdir(old_thumbs)
            except OSError:
                pass
        return self.get_settings()

    def uninstall(self, eid):
        """從實例移除（只在倉庫中確認有完全相同的內容時才刪除）"""
        e = self._entry(eid)
        if e.get('location') == 'repo':
            raise ValueError('這是倉庫中的模型，不能用「移除」')
        r = self._repo_entry_for(e['key'])
        if not r:
            raise ValueError('倉庫裡沒有這個模型，為了避免遺失，不會刪除。請先「加入倉庫」')
        if not contents_equal(r['path'], e['path']):
            raise ValueError('實例中的檔案和倉庫的內容不同，為了避免遺失，不會刪除')
        remove_model(e['path'])
        return True

    def import_to_repo(self, eid):
        """把實例中的模型複製進倉庫；硬連結模式下再把實例中的檔案換成連結（省空間）"""
        repo = LIB.data.get('repo')
        if not repo or not os.path.isdir(repo):
            raise ValueError('請先設定倉庫資料夾')
        e = self._entry(eid)
        if e.get('location') == 'repo':
            return {'path': e['path']}
        existing = self._repo_entry_for(e['key'])
        if existing and contents_equal(existing['path'], e['path']):
            dst = existing['path']
        else:
            dst = os.path.join(repo, e['filename'])
            if os.path.exists(dst):
                if contents_equal(dst, e['path']):
                    pass
                else:
                    base, ext = os.path.splitext(e['filename']) if e['kind'] != 'folder' else (e['filename'], '')
                    i = 2
                    while os.path.exists(os.path.join(repo, f'{base}_{i}{ext}')):
                        i += 1
                    dst = os.path.join(repo, f'{base}_{i}{ext}')
            if not os.path.exists(dst):
                if os.path.isdir(e['path']):
                    shutil.copytree(e['path'], dst)
                else:
                    shutil.copy2(e['path'], dst)
        linked = False
        if LIB.data.get('link_mode') == 'hardlink':
            linked = relink(dst, e['path'])
        return {'path': dst, 'linked': linked}

    def import_all(self):
        repo = LIB.data.get('repo')
        if not repo or not os.path.isdir(repo):
            raise ValueError('請先設定倉庫資料夾')
        done, linked, errors = 0, 0, []
        for e in list(LIB.entries.values()):
            if e.get('location') == 'repo':
                continue
            try:
                in_repo_before = self._repo_entry_for(e['key']) is not None
                res = self.import_to_repo(e['id'])
                if not in_repo_before:
                    done += 1
                    # 讓同一份內容的其他實例也對應到剛加入的倉庫項目
                    LIB.entries[path_id(res['path'])] = dict(e, id=path_id(res['path']), path=res['path'], location='repo')
                if res.get('linked'):
                    linked += 1
            except Exception as ex:
                errors.append(f"{e['filename']}：{ex}")
        return {'done': done, 'linked': linked, 'errors': errors}

    def detect_roots(self):
        """自動偵測結果，附上實例名稱、啟動器與模型數，方便分辨"""
        out = []
        for r in detect_roots():
            low = r.lower().replace('/', '\\')
            launcher = ('Prism' if '\\prismlauncher\\' in low else 'CurseForge' if '\\curseforge\\' in low
                        else 'Modrinth' if 'modrinth' in low else '版本隔離' if '\\.minecraft\\versions\\' in low
                        else '.minecraft')
            n = 0
            try:
                for d in os.scandir(os.path.join(r, 'custom')):
                    if d.is_dir() or d.name.lower().endswith(MODEL_EXTS):
                        n += 1
            except OSError:
                pass
            out.append({'path': r, 'name': instance_name(r), 'launcher': launcher, 'models': n})
        return out

    def pick_folder(self):
        if not self.window:
            return {'unsupported': True}
        import webview
        res = self.window.create_file_dialog(webview.FileDialog.FOLDER)
        return {'path': res[0] if res else None}

    def add_root(self, path):
        root = normalize_root(path)
        with LIB.lock:
            if not any(os.path.normcase(r) == os.path.normcase(root) for r in LIB.data['roots']):
                LIB.data['roots'].append(root)
                LIB.save()
        return {'root': root, 'roots': LIB.data['roots']}

    def remove_root(self, root):
        with LIB.lock:
            LIB.data['roots'] = [r for r in LIB.data['roots'] if r != root]
            LIB.save()
        return {'roots': LIB.data['roots']}

    def scan(self):
        out = []
        for root in LIB.data['roots']:
            if not os.path.isdir(root):
                continue
            has_sources = any(os.path.isdir(os.path.join(root, s)) for s in SOURCES)
            if has_sources:
                for s in SOURCES:
                    scan_dir(os.path.join(root, s), root, s, True, out)
                dis = os.path.join(root, DISABLED_DIRNAME)
                for s in SOURCES:
                    scan_dir(os.path.join(dis, s), root, s, False, out)
            else:
                scan_dir(root, root, '', True, out)  # 一般收藏資料夾
        for e in out:
            e['location'] = e['root']
            e['instance'] = instance_name(e['root'])
        repo = LIB.data.get('repo')
        repo_entries = []
        if repo and os.path.isdir(repo):
            scan_dir(repo, repo, '', True, repo_entries)
            for e in repo_entries:
                e['location'] = 'repo'
                e['instance'] = '倉庫'
        # 對應倉庫與各實例中的同一個模型（依內容）
        by_key = {}
        for e in repo_entries:
            by_key.setdefault(e['key'], e)
            e['installs'] = []
        for e in out:
            r = by_key.get(e['key'])
            e['repo_id'] = r['id'] if r else None
            if r:
                try:
                    st = link_state(r['path'], e['path'])
                except OSError:
                    st = 'copy'
                r['installs'].append({'root': e['root'], 'instance': e['instance'], 'id': e['id'], 'enabled': e['enabled'], 'link': st, 'rel': e['rel']})
        out = repo_entries + out
        with LIB.lock:
            LIB.entries = {e['id']: e for e in out}
            for e in out:
                rec = LIB.record(e['key'])
                rec['last_path'] = e['path']
                e['user'] = rec
            # 清理已不存在的雜湊快取
            alive = {os.path.normcase(e['path']) for e in out}
            LIB.data['hash_cache'] = {k: v for k, v in LIB.data['hash_cache'].items() if k in alive}
            LIB.save()
        return out

    def update_user(self, key, fields):
        allowed = {'tags', 'notes', 'rating', 'display_name'}
        with LIB.lock:
            rec = LIB.record(key)
            for k, v in fields.items():
                if k in allowed:
                    if k == 'tags':
                        v = sorted({str(t).strip() for t in v if str(t).strip()})
                    if k == 'rating':
                        v = max(0, min(5, int(v)))
                    rec[k] = v
            LIB.save()
            return rec

    def set_thumb(self, key, data_url):
        m = re.match(r'data:image/(png|jpeg|webp);base64,(.+)', data_url or '', re.S)
        if not m:
            raise ValueError('圖片格式不支援')
        ext = 'jpg' if m.group(1) == 'jpeg' else m.group(1)
        raw = base64.b64decode(m.group(2))
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('圖片太大')
        with LIB.lock:
            rec = LIB.record(key)
            olds = [rec.get('thumb'), rec.pop('thumb_src', '')]  # 換了新縮圖，換背景前保留的原圖也不再需要
            name = f'{key}_{int(time.time() * 1000)}.{ext}'
            with open(os.path.join(THUMB_DIR, name), 'wb') as f:
                f.write(raw)
            rec['thumb'] = name
            LIB.save()
        _remove_thumb_files(o for o in olds if o != name)
        return rec

    def set_thumb_bg(self, key, data_url):
        """換背景：data_url 是已經合成好背景的圖。第一次換時把原本的透明圖留下（thumb_src），之後可以再換或還原"""
        m = re.match(r'data:image/png;base64,(.+)', data_url or '', re.S)
        if not m:
            raise ValueError('圖片格式不支援')
        raw = base64.b64decode(m.group(1))
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('圖片太大')
        with LIB.lock:
            rec = LIB.record(key)
            cur, src = rec.get('thumb'), rec.get('thumb_src')
            if not cur and not src:
                raise ValueError('這個模型沒有縮圖')
            name = f'{key}_{int(time.time() * 1000)}_bg.png'
            with open(os.path.join(THUMB_DIR, name), 'wb') as f:
                f.write(raw)
            drop = []
            if src:
                if cur and cur != src:
                    drop.append(cur)
            else:
                rec['thumb_src'] = cur
            rec['thumb'] = name
            LIB.save()
        _remove_thumb_files(drop)
        return rec

    def restore_thumb_bg(self, keys):
        """還原成換背景前的原圖，回傳 {'restored': n, 'users': {key: rec}}"""
        drop, out, n = [], {}, 0
        with LIB.lock:
            for key in dict.fromkeys(keys or []):
                rec = LIB.record(key)
                src = rec.pop('thumb_src', '')
                if src:
                    if rec.get('thumb') and rec['thumb'] != src:
                        drop.append(rec['thumb'])
                    rec['thumb'] = src
                    n += 1
                out[key] = rec
            LIB.save()
        _remove_thumb_files(drop)
        return {'restored': n, 'users': out}

    def clear_thumb(self, key):
        with LIB.lock:
            rec = LIB.record(key)
            olds = [rec.get('thumb'), rec.pop('thumb_src', '')]
            rec['thumb'] = ''
            LIB.save()
        _remove_thumb_files(olds)
        return rec

    def clear_thumbs(self, keys):
        """批量刪除縮圖，回傳 {key: 新的使用者資料}"""
        olds, out, n = [], {}, 0
        with LIB.lock:
            for key in dict.fromkeys(keys or []):
                rec = LIB.record(key)
                if rec.get('thumb'):
                    n += 1
                olds += [rec.get('thumb'), rec.pop('thumb_src', '')]
                rec['thumb'] = ''
                out[key] = rec
            LIB.save()
        _remove_thumb_files(olds)
        return {'removed': n, 'users': out}

    def _entry(self, eid):
        e = LIB.entries.get(eid)
        if not e or not os.path.exists(e['path']):
            raise ValueError('找不到這個模型，請重新掃描')
        return e

    def rename(self, eid, new_name):
        e = self._entry(eid)
        new_name = new_name.strip()
        if not new_name or re.search(r'[\\/:*?"<>|]', new_name) or new_name in ('.', '..'):
            raise ValueError('名稱含有不允許的字元')
        if e['kind'] != 'folder':
            ext = os.path.splitext(e['path'])[1]
            if not new_name.lower().endswith(ext.lower()):
                new_name += ext
        dst = os.path.join(os.path.dirname(e['path']), new_name)
        if os.path.exists(dst):
            raise ValueError('已有同名的檔案或資料夾')
        os.rename(e['path'], dst)
        return {'path': dst}

    def set_enabled(self, eid, enabled):
        e = self._entry(eid)
        if not e['source']:
            raise ValueError('這個資料夾不是遊戲的 yes_steve_model 資料夾，無法啟用或停用')
        if e['enabled'] == enabled:
            return {'path': e['path']}
        base_on = os.path.join(e['root'], e['source'])
        base_off = os.path.join(e['root'], DISABLED_DIRNAME, e['source'])
        dst = os.path.join(base_on if enabled else base_off, e['rel'])
        if os.path.exists(dst):
            raise ValueError('目的地已有同名模型：' + dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(e['path'], dst)
        # 移除停用區中留下的空資料夾
        p = os.path.dirname(e['path'])
        dis_root = os.path.join(e['root'], DISABLED_DIRNAME)
        while p.startswith(dis_root + os.sep):
            try:
                os.rmdir(p)
            except OSError:
                break
            p = os.path.dirname(p)
        return {'path': dst}

    def reveal(self, eid):
        e = self._entry(eid)
        subprocess.Popen(['explorer', '/select,', os.path.normpath(e['path'])])
        return True

    def open_url(self, url):
        """用系統預設瀏覽器開啟連結（只接受 http/https；前端會先顯示警告）"""
        url = str(url or '').strip()
        if not re.match(r'^https?://[^\s]+$', url, re.I) or len(url) > 2000:
            raise ValueError('只能開啟 http 或 https 連結')
        import webbrowser
        webbrowser.open(url, new=2)
        return True

    def open_special_dir(self, which):
        """開啟資料存放資料夾（data）或倉庫資料夾（repo）"""
        path = {'data': DATA_DIR, 'repo': LIB.data.get('repo') or ''}.get(which, '')
        if path and os.path.isdir(path):
            os.startfile(path)
        return True

    def open_dir(self, path):
        if path in LIB.data['roots'] and os.path.isdir(path):
            os.startfile(path)
        return True

    def list_screenshots(self):
        shots = []
        dirs = []
        for r in LIB.data['roots']:
            dirs += screenshot_dirs(r)
        for d in sorted(set(dirs)):
            if not os.path.isdir(d):
                continue
            for f in os.scandir(d):
                if f.is_file() and f.name.lower().endswith(('.png', '.jpg', '.jpeg')):
                    shots.append({'path': f.path, 'name': f.name, 'mtime': int(f.stat().st_mtime)})
        shots.sort(key=lambda s: -s['mtime'])
        return shots[:120]

    def model_files(self, eid):
        e = self._entry(eid)
        if e['kind'] == 'folder':
            files = []
            for r, _, fs in os.walk(e['path']):
                for fn in fs:
                    if fn.lower().endswith('.ogg'):
                        continue
                    fp = os.path.join(r, fn)
                    files.append(os.path.relpath(fp, e['path']).replace('\\', '/'))
            return {'kind': 'folder', 'name': os.path.basename(e['path']), 'files': files}
        if e['kind'] == 'zip':
            return {'kind': 'zip', 'name': os.path.basename(e['path']), 'files': ['']}
        raise ValueError('這種格式無法在程式中預覽')


API = Api()


def allowed_screenshot(path):
    p = os.path.normcase(os.path.abspath(path))
    for r in LIB.data['roots']:
        for d in screenshot_dirs(r):
            if p.startswith(os.path.normcase(os.path.abspath(d)) + os.sep):
                return True
    return False


# ---------------------------------------------------------------- HTTP 伺服器
TOKEN = secrets.token_urlsafe(16)
MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
        '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.zip': 'application/zip', '.avif': 'image/avif'}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path):
        if not os.path.isfile(path):
            return self._send(404, '{"error":"not found"}')
        ext = os.path.splitext(path)[1].lower()
        with open(path, 'rb') as f:
            data = f.read()
        self._send(200, data, MIME.get(ext, 'application/octet-stream'))

    def _authed(self, q):
        return q.get('t', [''])[0] == TOKEN or self.headers.get('X-Token') == TOKEN

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        path = urllib.parse.unquote(u.path)
        if path.startswith('/api/'):
            if not self._authed(q):
                return self._send(403, '{"error":"forbidden"}')
            if path.startswith('/api/thumb/'):
                name = os.path.basename(path[len('/api/thumb/'):])
                return self._file(os.path.join(THUMB_DIR, name))
            if path == '/api/shot':
                p = q.get('p', [''])[0]
                if not allowed_screenshot(p):
                    return self._send(403, '{"error":"forbidden"}')
                return self._file(p)
            if path == '/api/model':
                try:
                    e = API._entry(q.get('id', [''])[0])
                except Exception as ex:
                    return self._send(404, json.dumps({'error': str(ex)}))
                rel = q.get('p', [''])[0]
                if e['kind'] == 'zip':
                    return self._file(e['path'])
                if e['kind'] != 'folder':
                    return self._send(403, '{"error":"forbidden"}')
                full = os.path.abspath(os.path.join(e['path'], rel))
                if not os.path.normcase(full).startswith(os.path.normcase(os.path.abspath(e['path'])) + os.sep):
                    return self._send(403, '{"error":"forbidden"}')
                return self._file(full)
            return self._send(404, '{"error":"not found"}')
        # 靜態檔案
        if path in ('', '/'):
            path = '/manager.html'
        full = os.path.abspath(os.path.join(APP_DIR, path.lstrip('/')))
        if not os.path.normcase(full).startswith(os.path.normcase(APP_DIR) + os.sep):
            return self._send(403, 'forbidden', 'text/plain')
        return self._file(full)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path != '/api/call' or not self._authed(q):
            return self._send(403, '{"error":"forbidden"}')
        try:
            n = int(self.headers.get('Content-Length', '0'))
            req = json.loads(self.rfile.read(n).decode('utf-8'))
            method = req.get('method', '')
            if method.startswith('_') or not hasattr(API, method):
                raise ValueError('未知的指令：' + method)
            result = getattr(API, method)(*req.get('args', []))
            self._send(200, json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
        except Exception as ex:
            self._send(200, json.dumps({'ok': False, 'error': str(ex)}, ensure_ascii=False))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def start_server(port=0):
    srv = Server(('127.0.0.1', port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    serve_only = '--serve' in sys.argv
    port = 0
    if '--port' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1])
    srv = start_server(port)
    url = f'http://127.0.0.1:{srv.server_address[1]}/manager.html?t={TOKEN}'
    if serve_only:
        print(url, flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    import webview
    win = webview.create_window(APP_NAME, url, width=1360, height=860, min_size=(960, 600), background_color='#16181d')
    API.window = win
    webview.start(private_mode=False, storage_path=os.path.join(BASE_DIR, 'webview'))
    os._exit(0)  # 視窗關閉後立即結束（不等背景執行緒），解除安裝腳本才能刪除 exe


if __name__ == '__main__':
    main()

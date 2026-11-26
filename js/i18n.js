/* 介面語言：zh-Hant（原文，不需翻譯表）、zh-Hans、en。
 * 翻譯表在 js/i18n_data.js（window.I18N_DATA = { 'zh-Hans': {原文: 譯文}, en: {...} }），
 * 原文就是程式中的繁體中文字串；{0}、{1}… 是參數位置。
 * 語言來源：網址的 ?lang=（管理器啟動時帶上）→ 上層頁面（內嵌的 3D 預覽器）→ 瀏覽器語言。
 */
(function () {
  'use strict';
  const DATA = window.I18N_DATA || {};
  const SUPPORTED = ['zh-Hant', 'zh-Hans', 'en'];
  const LOCALES = { 'zh-Hant': 'zh-TW', 'zh-Hans': 'zh-CN', en: 'en-US' };

  function fromSystem(l) {
    l = String(l || '').toLowerCase();
    if (!l.startsWith('zh')) return 'en';
    return /hans|cn|sg|my/.test(l) ? 'zh-Hans' : 'zh-Hant';
  }
  let lang = null;
  try { lang = new URLSearchParams(location.search).get('lang'); } catch (e) { /* 忽略 */ }
  if (!SUPPORTED.includes(lang)) {
    try { if (window.parent !== window && window.parent.I18N) lang = window.parent.I18N.lang; } catch (e) { /* 不同來源 */ }
  }
  if (!SUPPORTED.includes(lang)) lang = fromSystem(navigator.language);

  const dict = DATA[lang] || {};
  const missing = new Set();
  const HAN = /[㐀-鿿]/;

  function lookup(key) {
    const v = dict[key];
    if (v != null) return v;
    if (lang !== 'zh-Hant' && HAN.test(key)) missing.add(key);
    return key;
  }
  /** __('已安裝 {0} 個', n) */
  function __(key, ...args) {
    const s = lookup(key);
    return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] == null ? '' : String(args[i]))) : s;
  }

  // ---- 靜態頁面（HTML 裡寫死的文字）：由頁面的主程式在一開始呼叫 I18N.translatePage() ----
  // 只含 b / kbd / code / br 等行內標籤的段落整段翻譯（語序才會對），其餘逐個文字節點翻譯
  const INLINE = new Set(['B', 'KBD', 'CODE', 'BR', 'SMALL', 'I', 'STRONG', 'EM']);
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  function trText(s) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!HAN.test(m[2])) return s;
    return m[1] + lookup(m[2]) + m[3];
  }
  function walk(el) {
    if (el.nodeType !== 1 || el.translate === false || /^(SCRIPT|STYLE)$/.test(el.tagName)) return;
    for (const a of ATTRS) if (el.hasAttribute(a) && HAN.test(el.getAttribute(a))) el.setAttribute(a, trText(el.getAttribute(a)));
    const kids = [...el.childNodes];
    const elems = kids.filter((n) => n.nodeType === 1);
    if (elems.length && elems.every((n) => INLINE.has(n.tagName) && !n.children.length)
      && kids.some((n) => n.nodeType === 3 && HAN.test(n.nodeValue))) {
      const key = el.innerHTML.trim();
      if (dict[key] != null) { el.innerHTML = dict[key]; return; }
      if (lang !== 'zh-Hant') missing.add(key);
    }
    for (const n of kids) {
      if (n.nodeType === 3) { if (HAN.test(n.nodeValue)) n.nodeValue = trText(n.nodeValue); } else walk(n);
    }
  }
  function translatePage() {
    document.documentElement.lang = lang;
    if (lang === 'zh-Hant') return;
    walk(document.documentElement);
  }

  window.__ = __;
  window.I18N = { lang, locale: LOCALES[lang], supported: SUPPORTED, missing, translatePage, fromSystem };
})();

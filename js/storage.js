/* ==========================================================================
   AZILE storage — localStorage の薄いラッパー（すべて try/catch で保護）
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.storage = (function () {
  'use strict';

  const KEY_HISTORY = 'azile.history';
  const KEY_USER = 'azile.user';
  const KEY_SEEN = 'azile.seen';
  const KEY_CACHE = 'azile.cache';
  const HISTORY_LIMIT = 200;

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function remove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }

  /* ---- 会話履歴 ---- */
  function getHistory() {
    const h = read(KEY_HISTORY, []);
    return Array.isArray(h) ? h : [];
  }

  function pushHistory(role, html, emo) {
    const h = getHistory();
    h.push({ role, html, emo: emo || undefined, ts: Date.now() });
    while (h.length > HISTORY_LIMIT) h.shift();
    write(KEY_HISTORY, h);
  }

  function clearHistory() { remove(KEY_HISTORY); }

  /* ---- ユーザー情報 ---- */
  function getUser() { return read(KEY_USER, {}) || {}; }
  function setUser(patch) { write(KEY_USER, Object.assign({}, getUser(), patch)); }

  function getUserName() { return (getUser().name || '').trim(); }
  function setUserName(name) { setUser({ name: String(name || '').trim() }); }

  function isFirstVisit() { return !read(KEY_SEEN, false); }
  function markSeen() { write(KEY_SEEN, true); }

  /* ---- API キャッシュ（法令IDなど小さいもの） ---- */
  function cacheGet(name) {
    const c = read(KEY_CACHE, {}) || {};
    return c[name];
  }
  function cacheSet(name, value) {
    const c = read(KEY_CACHE, {}) || {};
    c[name] = value;
    write(KEY_CACHE, c);
  }

  /* ---- 機嫌 ---- */
  const KEY_MOOD = 'azile.mood';
  function getMood() { return read(KEY_MOOD, null); }
  function setMood(m) { write(KEY_MOOD, m); }

  function resetAll() {
    remove(KEY_HISTORY);
    remove(KEY_USER);
    remove(KEY_SEEN);
    remove(KEY_CACHE);
    remove(KEY_MOOD);
  }

  return {
    getHistory, pushHistory, clearHistory,
    getUser, setUser, getUserName, setUserName,
    isFirstVisit, markSeen,
    cacheGet, cacheSet,
    getMood, setMood,
    resetAll
  };
})();

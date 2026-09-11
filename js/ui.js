/* ==========================================================================
   AZILE ui — コンソール風端末の描画・入力・タイプライタ・アイドルタイマー
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.ui = (function () {
  'use strict';

  const els = {};
  let queue = Promise.resolve();       // AZILE の発言は順番に再生
  let onInput = null;                  // app.js から注入
  let onIdle = null;
  let idleTimer = null;
  let idleStreak = 0;                  // 連続で無反応だった回数（間隔を伸ばす）
  let thinkingEl = null;
  let skipTyping = false;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- 初期化 --------------------------------------------------------- */
  function init(handlers) {
    onInput = handlers.onInput;
    onIdle = handlers.onIdle;
    els.output = document.getElementById('output');
    els.form = document.getElementById('prompt-form');
    els.input = document.getElementById('prompt-input');
    els.engine = document.getElementById('engine-status');
    els.net = document.getElementById('net-status');
    els.clock = document.getElementById('clock');

    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.input.value;
      if (!text.trim()) return;
      els.input.value = '';
      resetIdle();
      if (onInput) onInput(text);
    });
    els.input.addEventListener('input', resetIdle);
    els.output.addEventListener('click', () => { skipTyping = true; });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearIdle(); else resetIdle();
    });
    /* 出力領域をクリックしても入力欄にフォーカスを戻す（リンク以外） */
    els.output.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      els.input.focus();
    });

    tickClock();
    setInterval(tickClock, 1000);
    setNet(navigator.onLine ? 'ok' : 'bad');
    window.addEventListener('online', () => setNet('ok'));
    window.addEventListener('offline', () => setNet('bad'));
    resetIdle();
  }

  function tickClock() {
    if (!els.clock) return;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    els.clock.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ---- ステータス表示 -------------------------------------------------- */
  function setEngine(name) {
    if (!els.engine) return;
    els.engine.innerHTML = 'ENGINE: <b>' + (name === 'kuromoji' ? 'KUROMOJI' : 'TINY') + '</b>';
    els.engine.classList.toggle('ok', name === 'kuromoji');
  }

  function setNet(state) {
    if (!els.net) return;
    const label = state === 'ok' ? 'ONLINE' : state === 'bad' ? 'OFFLINE' : '—';
    els.net.innerHTML = 'NET: <b>' + label + '</b>';
    els.net.classList.toggle('ok', state === 'ok');
    els.net.classList.toggle('bad', state === 'bad');
  }

  /* ---- 行の描画 -------------------------------------------------------- */
  function makeLine(role, who) {
    const line = document.createElement('div');
    line.className = 'line ' + role;
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    const b = document.createElement('span');
    b.className = 'body';
    line.appendChild(w);
    line.appendChild(b);
    els.output.appendChild(line);
    return b;
  }

  function scrollBottom() {
    els.output.scrollTop = els.output.scrollHeight;
  }

  const WHO = { azile: 'AZILE>', user: 'you>', sys: 'sys>', err: 'err>' };

  /** 即時描画（履歴復元・ユーザー発言・システム行） */
  function printNow(role, html) {
    const b = makeLine(role, WHO[role] || role);
    b.innerHTML = html;
    scrollBottom();
    return b;
  }

  function user(text) {
    const b = makeLine('user', WHO.user);
    b.textContent = text;
    scrollBottom();
  }

  function sys(html) { printNow('sys', html); }
  function err(html) { printNow('err', html); }
  /** システム行を AZILE の発言キューの順序を守って出す（発言の途中に割り込まない） */
  function sysQueued(html) {
    queue = queue.then(() => { printNow('sys', html); }).catch(() => { /* keep queue alive */ });
    return queue;
  }

  /** タイプライタ表示。HTML はいったんプレーンテキストで打ち出し、最後に本物の HTML に差し替える */
  function typewrite(b, html) {
    return new Promise((resolve) => {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const text = tmp.textContent || '';
      if (reduceMotion || text.length === 0) { b.innerHTML = html; scrollBottom(); resolve(); return; }

      b.classList.add('typing');
      skipTyping = false;
      /* 長文ほど速く。全体で 0.6〜2.4 秒程度に収める */
      const perChar = Math.max(8, Math.min(28, 2400 / Math.max(text.length, 1)));
      let i = 0;
      const step = () => {
        if (skipTyping) { i = text.length; }
        i += 1;
        b.textContent = text.slice(0, i);
        scrollBottom();
        if (i < text.length) { setTimeout(step, perChar); }
        else {
          b.classList.remove('typing');
          b.innerHTML = html;
          scrollBottom();
          resolve();
        }
      };
      setTimeout(step, 120);
    });
  }

  /** AZILE の発言（キューに積んで順番に再生）。resolve は表示完了時 */
  function say(html) {
    queue = queue.then(() => {
      hideThinking();
      const b = makeLine('azile', WHO.azile);
      return typewrite(b, html);
    }).catch(() => { /* keep queue alive */ });
    return queue;
  }

  /* ---- 「考え中」インジケータ ------------------------------------------- */
  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = makeLine('azile', WHO.azile);
    thinkingEl.classList.add('typing');
    thinkingEl.textContent = '';
    scrollBottom();
  }
  function hideThinking() {
    if (!thinkingEl) return;
    const line = thinkingEl.parentElement;
    if (line && line.parentElement) line.parentElement.removeChild(line);
    thinkingEl = null;
  }

  function clear() {
    els.output.innerHTML = '';
    thinkingEl = null;
  }

  /* ---- アイドルタイマー（AZILE から話しかける） ------------------------- */
  function idleDelay() {
    const base = 45000 + Math.random() * 45000;          // 45〜90 秒
    const factor = Math.min(4, 1 + idleStreak * 0.8);    // 無反応が続くほど間隔を伸ばす（最大4倍）
    return base * factor;
  }

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function scheduleIdle() {
    clearIdle();
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (document.hidden || !onIdle) { scheduleIdle(); return; }
      idleStreak += 1;
      /* streak 1 = 最初の話しかけ、2 以上 = 前回の話しかけが無視された */
      try { await onIdle(idleStreak); } catch (_) { /* ignore */ }
      scheduleIdle();
    }, idleDelay());
  }

  /** 機嫌レベルを見た目に反映（AZILE> の色と発光がじわっと変わる） */
  function setMood(level) {
    const t = document.getElementById('terminal');
    if (t) t.setAttribute('data-mood', level || 'good');
  }

  function resetIdle() {
    idleStreak = 0;
    scheduleIdle();
  }

  function focus() { if (els.input) els.input.focus(); }

  return { init, printNow, user, sys, sysQueued, err, say, showThinking, hideThinking, clear, setEngine, setNet, setMood, resetIdle, focus };
})();

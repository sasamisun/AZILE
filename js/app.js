/* ==========================================================================
   AZILE app — 起動と配線
   ========================================================================== */
(function () {
  'use strict';

  const UI = AZILE.ui;
  const BRAIN = AZILE.brain;
  const S = AZILE.storage;
  const A = AZILE.analyzer;
  const M = AZILE.mood;
  const C = AZILE.clock;

  let busy = false;

  /* ---- コマンド --------------------------------------------------------- */
  function handleCommand(text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase()) {
      case '/help':
      case '/?':
        UI.sys(BRAIN.helpText());
        return true;
      case '/clear':
        UI.clear();
        UI.sys('画面をクリアしたよ（履歴は残ってる。消すなら /reset）。');
        return true;
      case '/reset':
        S.resetAll();
        M.load();
        UI.clear();
        UI.sys('履歴・名前・機嫌・キャッシュを全部消したよ。はじめまして、からやり直そ。');
        BRAIN.welcome(true).forEach((m) => UI.say(m.html, m.emo));
        S.markSeen();
        UI.setMood(M.level());
        return true;
      case '/name':
        if (!arg) { UI.sys('使い方: <kbd>/name さくら</kbd>'); return true; }
        S.setUserName(arg.slice(0, 20));
        UI.say('了解！ ' + BRAIN.esc(arg.slice(0, 20)) + 'って呼ぶね。', 'uresi');
        return true;
      case '/engine':
        UI.sys('形態素解析エンジン: <b>' + A.currentEngine().toUpperCase() + '</b>' +
          (A.currentEngine() === 'tiny' ? '（kuromoji の辞書を読み込み中、または読み込みに失敗。TinySegmenter で動作中）' : '（kuromoji.js 辞書ロード済み・品詞付き解析）'));
        return true;
      case '/memory':
        UI.sys('記憶スタック: ' + (BRAIN.getMemory().map(BRAIN.esc).join(' / ') || '（空）'));
        return true;
      case '/mood': {
        /* 隠しパラメータのデバッグ表示（/help には載せない） */
        const hist = M.history().slice(-6).map((h) => (h.delta > 0 ? '+' : '') + h.delta + ' ' + BRAIN.esc(h.reason)).join(' / ');
        UI.sys('機嫌: <b>' + M.get() + '</b> / 100（' + M.level() + '、時間帯補正後 ' + Math.round(M.effective()) + '）' +
          '　時刻: ' + BRAIN.esc(C.label()) + '（' + C.period() + (C.timezone() ? ' / ' + BRAIN.esc(C.timezone()) : '') + '）' +
          (hist ? '<br>最近の変動: ' + hist : ''));
        return true;
      }
      case '/time':
        BRAIN.respond('今何時？').then((msgs) => msgs.forEach((m) => UI.say(m.html, m.emo)));
        return true;
      case '/diary':
        UI.say(BRAIN.diaryEntry(), 'raku');
        return true;
      default:
        UI.sys('知らないコマンド: ' + BRAIN.esc(cmd) + '。<kbd>/help</kbd> で一覧を見てね。');
        return true;
    }
  }

  /* ---- 入力処理 --------------------------------------------------------- */
  async function onInput(text) {
    if (text.trim().startsWith('/')) { handleCommand(text); return; }
    UI.user(text);
    S.pushHistory('user', BRAIN.esc(text));
    if (busy) return;
    busy = true;
    UI.showThinking();
    let msgs;
    try {
      msgs = await BRAIN.respond(text);
    } catch (e) {
      console.error(e);
      msgs = [{ html: 'うっ、頭の中でゼロ除算が起きた。もう一回言ってくれる？', emo: 'housin' }];
    }
    UI.hideThinking();
    for (const m of msgs) {
      if (!m || !m.html) continue;
      S.pushHistory('azile', m.html, m.emo);
      await UI.say(m.html, m.emo);
    }
    busy = false;
    UI.resetIdle();
  }

  async function onIdle(streak) {
    if (busy) return;
    let msgs;
    try { msgs = await BRAIN.idleTalk(streak); } catch (e) { console.error(e); return; }
    for (const m of msgs) {
      if (!m || !m.html) continue;
      S.pushHistory('azile', m.html, m.emo);
      await UI.say(m.html, m.emo);
    }
  }

  /* ---- 起動 ------------------------------------------------------------- */
  function boot() {
    UI.init({ onInput, onIdle });

    /* 機嫌の復元と表示連動 */
    M.load();
    UI.setMood(M.level());
    M.onChange((level) => UI.setMood(level));

    /* 履歴復元（タイプライタなし） */
    const history = S.getHistory();
    if (history.length) {
      history.forEach((h) => UI.printNow(h.role === 'user' ? 'user' : 'azile', h.html));
      UI.sys('── 前回の続き（' + history.length + ' 行を復元） ──');
      const lastEmo = history.slice().reverse().find((h) => h.role === 'azile' && h.emo);
      if (lastEmo) UI.setEmotion(lastEmo.emo);
    }

    const first = S.isFirstVisit();
    BRAIN.welcome(first).forEach((m) => { UI.say(m.html, m.emo); S.pushHistory('azile', m.html, m.emo); });
    S.markSeen();

    /* kuromoji を裏でロード */
    UI.setEngine('tiny');
    A.onEngineChange((name) => {
      UI.setEngine(name);
      UI.sysQueued('kuromoji.js の辞書ロード完了。品詞付きの本格解析に切り替えたよ。');
    });
    A.loadKuromoji().then((ok) => { if (!ok) UI.sysQueued('kuromoji.js の辞書を読み込めなかったので TinySegmenter のまま続けるね。'); });

    UI.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

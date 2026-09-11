/* ==========================================================================
   AZILE analyzer — 形態素解析の抽象層
   起動直後: TinySegmenter（辞書不要・即時）＋ 文字種ヒューリスティックで品詞推定
   その後:   kuromoji.js の辞書ロードが完了したら自動で切替（品詞・基本形・読み付き）
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.analyzer = (function () {
  'use strict';

  const KUROMOJI_SCRIPT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js';
  const DIC_PATH = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
  const WORKER_PATH = 'js/kuromoji-worker.js';
  const WORKER_TIMEOUT = 4000;   // Worker の応答がこれ以上遅ければ TinySegmenter で代替

  let engine = 'tiny';
  let tiny = null;
  let kuro = null;               // 同一スレッド版 tokenizer（Worker が使えない環境のみ）
  let worker = null;             // Web Worker 版
  let kuroPromise = null;
  const listeners = [];
  const pending = new Map();     // Worker へのリクエスト id → resolve
  let seq = 0;

  /* ---- 代名詞・形式名詞など、キーワードとして拾いたくない名詞 ---------- */
  const NOUN_STOP = new Set([
    'こと', 'もの', 'の', 'これ', 'それ', 'あれ', 'どれ', 'ここ', 'そこ', 'あそこ', 'どこ', 'こっち', 'そっち',
    '何', 'なに', 'なん', '誰', 'だれ', 'いつ', '私', 'わたし', '僕', 'ぼく', '俺', 'おれ', 'あなた', '君', 'きみ',
    'お前', '自分', '今日', '明日', '昨日', '今', '時', 'とき', '人', 'ため', 'よう', 'さん', 'ちゃん', 'くん',
    '感じ', '気', '方', 'ほう', '的', 'さ', 'み', '中', '前', '後', '上', '下', '間', 'うち', 'はず', 'わけ', 'つもり',
    'みたい', 'そう', 'よ', 'ね', 'な', 'AZILE', 'アジール', 'azile', '画像', 'イラスト', '絵', '写真', 'ピクチャ',
    '生成', '作成', '検索', '法律', '条', '第', '項', '号', '意味', '説明', '解説', '定義', '話', '件', '一', '二', '三',
    'ちょうだい', '頂戴', 'ください', '下さい', 'お願い', 'おねがい', '名言', 'セリフ', '台詞', '決め台詞',
    'ムカ', 'あり', 'とう', 'イラ', 'ドキドキ', 'ワクワク', 'そう', 'こう', 'どう'
  ]);

  const PARTICLES = new Set(['は', 'が', 'を', 'に', 'の', 'と', 'で', 'も', 'へ', 'から', 'まで', 'より', 'や', 'か',
    'ね', 'よ', 'な', 'わ', 'さ', 'ぞ', 'ぜ', 'って', 'とか', 'だけ', 'しか', 'でも', 'など', 'くらい', 'ぐらい', 'ほど',
    'ながら', 'けど', 'けれど', 'のに', 'ので', 'し', 'たり']);

  const INTERROGATIVES = /(何|なに|なん|どこ|誰|だれ|いつ|なぜ|なんで|どうして|どう|どんな|いくつ|いくら|どっち|どちら|どれ|どの)/;

  /* ---- 正規化 --------------------------------------------------------- */
  function normalize(text) {
    let t = String(text || '');
    try { t = t.normalize('NFKC'); } catch (_) { /* old browsers */ }
    return t.replace(/[　\t]+/g, ' ').replace(/\s+/g, ' ').replace(/[~〜～]/g, '〜').trim();
  }

  /* ---- 文字種判定 ------------------------------------------------------ */
  const isKanji = (s) => /^[一-龠々〆ヵヶ]+$/.test(s);
  const hasKanji = (s) => /[一-龠々〆ヵヶ]/.test(s);
  const isKatakana = (s) => /^[ァ-ヶー]+$/.test(s);
  const isHiragana = (s) => /^[ぁ-ん]+$/.test(s);
  const isAlnum = (s) => /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/.test(s);
  const isPunct = (s) => /^[\s、。，．・!?！？…「」『』（）()\[\]【】〈〉《》“”"'‘’:;：；\-ー〜]+$/.test(s);

  /* ---- TinySegmenter → 擬似トークン ------------------------------------ */
  function guessPos(w) {
    if (isPunct(w)) return '記号';
    if (PARTICLES.has(w)) return '助詞';
    if (/^[0-9０-９]+$/.test(w)) return '名詞-数';
    if (isKatakana(w) || isAlnum(w)) return '名詞';
    if (isKanji(w)) return '名詞';
    if (hasKanji(w)) {
      if (/[うくすつぬむるぐずぶ]$/.test(w) || /(った|んだ|いた|えた|して|った|てる|ます|ました|たい|ない)$/.test(w)) return '動詞';
      if (/い$/.test(w)) return '形容詞';
      return '名詞';
    }
    if (isHiragana(w)) {
      if (/(です|でした|ます|ません|だ|だった|である)$/.test(w)) return '助動詞';
      if (/(たい|ない|らしい|しい|よい|いい|すごい|やばい|つらい|さびしい|うれしい|かなしい|こわい|ねむい|だるい)$/.test(w)) return '形容詞';
      if (/(する|した|して|やる|やった|いる|ある|なる|なった|くる|きた|いく|いった|できる|できた|わかる|しよう|やろう)$/.test(w)) return '動詞';
      if (w.length >= 2) return '名詞';
      return 'その他';
    }
    return 'その他';
  }

  function tinyTokens(text) {
    if (!tiny) tiny = new TinySegmenter();
    return tiny.segment(text).filter((w) => w.trim().length).map((w) => ({
      surface: w, pos: guessPos(w), detail: '', basic: w, reading: ''
    }));
  }

  /* ---- kuromoji → トークン（同一スレッド版） ----------------------------- */
  function kuroTokens(text) {
    return kuro.tokenize(text).map((t) => ({
      surface: t.surface_form,
      pos: t.pos,
      detail: t.pos_detail_1 || '',
      basic: (t.basic_form && t.basic_form !== '*') ? t.basic_form : t.surface_form,
      reading: (t.reading && t.reading !== '*') ? t.reading : ''
    }));
  }

  /* ---- kuromoji → トークン（Worker 版・非同期） ------------------------- */
  function workerTokens(text) {
    return new Promise((resolve) => {
      if (!worker) { resolve(null); return; }
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, WORKER_TIMEOUT);
      pending.set(id, (tokens) => { clearTimeout(timer); resolve(tokens); });
      try { worker.postMessage({ type: 'tokenize', id, text }); }
      catch (_) { clearTimeout(timer); pending.delete(id); resolve(null); }
    });
  }

  /* ---- 名詞抽出（複合名詞の連結つき） ---------------------------------- */
  function extractNouns(tokens) {
    const out = [];
    let buf = '';
    const flush = () => {
      if (buf && !NOUN_STOP.has(buf) && buf.length >= 1 && !/^[0-9]+$/.test(buf)) out.push(buf);
      buf = '';
    };
    for (const t of tokens) {
      const isNoun = t.pos.startsWith('名詞') &&
        !['非自立', '代名詞', '接尾', '副詞可能', '数', '特殊'].includes(t.detail);
      if (isNoun && !NOUN_STOP.has(t.surface) && !isPunct(t.surface)) {
        buf += t.surface;
      } else {
        flush();
      }
    }
    flush();
    /* 長い複合名詞と、その構成要素の両方を候補にしておく */
    const parts = tokens.filter((t) => t.pos.startsWith('名詞') && !NOUN_STOP.has(t.surface) &&
      !['非自立', '代名詞', '接尾', '数'].includes(t.detail) && !isPunct(t.surface)).map((t) => t.surface);
    return Array.from(new Set(out.concat(parts)));
  }

  function polarity(text) {
    const R = AZILE.rules;
    let s = 0;
    for (const w of R.positiveWords) if (text.includes(w)) s += 1;
    for (const w of R.negativeWords) if (text.includes(w)) s -= 1;
    /* 否定で反転しがちな簡易処理: 「〜くない」「〜じゃない」 */
    if (/(くない|じゃない|ではない|くなかった)/.test(text)) s = -s * 0.5;
    return Math.max(-1, Math.min(1, s / 2));
  }

  /* ---- メイン --------------------------------------------------------- */
  /** 同期版: TinySegmenter か、同一スレッドの kuromoji（Node テスト用）を使う */
  function analyze(raw) {
    const text = normalize(raw);
    let tokens;
    let used = engine;
    try {
      tokens = engine === 'kuromoji' && kuro ? kuroTokens(text) : tinyTokens(text);
      if (!kuro) used = 'tiny';
    } catch (_) {
      tokens = tinyTokens(text);
      used = 'tiny';
    }
    return build(text, tokens, used);
  }

  /** 非同期版: Worker の kuromoji が使えればそれを、遅ければ TinySegmenter を使う */
  async function analyzeAsync(raw) {
    const text = normalize(raw);
    if (engine === 'kuromoji' && worker) {
      const tokens = await workerTokens(text);
      if (tokens) return build(text, tokens, 'kuromoji');
    }
    return analyze(raw);
  }

  function build(text, tokens, used) {
    const nouns = extractNouns(tokens);
    const verbs = tokens.filter((t) => t.pos === '動詞' && t.detail !== '非自立').map((t) => t.basic);
    const adjectives = tokens.filter((t) => t.pos === '形容詞').map((t) => t.basic);

    const isQuestion = /[?？]\s*$/.test(text) ||
      /(か|かな|かしら|の|なの|でしょ|でしょう|ですか|ますか|だっけ|っけ|って何|ってなに|とは)\s*[?？]?$/.test(text) && INTERROGATIVES.test(text) ||
      /(教えて|知ってる|知ってます|わかる[?？]|分かる[?？])/.test(text);
    const isNegative = /(ない|ません|なかった|ぬ|ず)(です|よ|ね|。|$)/.test(text) || /ない$/.test(text);
    const isRequest = /(して|ちょうだい|頂戴|ください|下さい|お願い|してほしい|して欲しい|作って|出して|描いて|書いて|教えて|見せて|探して|調べて|言って|聞かせて)/.test(text);

    return {
      text, tokens, nouns, verbs, adjectives,
      isQuestion, isNegative, isRequest,
      polarity: polarity(text),
      engine: used
    };
  }

  /* ---- kuromoji の非同期ロード ------------------------------------------ */
  function ready() {
    engine = 'kuromoji';
    listeners.forEach((fn) => { try { fn('kuromoji'); } catch (_) { /* ignore */ } });
  }

  /**
   * ブラウザでは Web Worker で辞書を展開・構築する（18MB の展開と trie 構築を
   * メインスレッドで行うと遅い環境で数十秒固まり「ページが応答しません」になるため）。
   * Worker が使えない環境（Node のテストなど）では、すでに読み込まれた
   * window.kuromoji を同一スレッドで使う。
   */
  function loadKuromoji() {
    if (kuroPromise) return kuroPromise;
    kuroPromise = new Promise((resolve) => {
      if (typeof Worker === 'function' && /^https?:/.test(location.protocol)) {
        /* Worker のスクリプトは fetch で取得して Blob URL から起動する。
           GitHub Pages 上でファイル URL の Worker から CDN を importScripts すると
           完了しない現象があったため（Blob URL 経由なら同じコードで完走する）。 */
        fetch(WORKER_PATH, { cache: 'no-cache' })
          .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
          .then((src) => {
            const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
            worker = new Worker(url);
            attachWorker(resolve);
          })
          .catch((err) => {
            console.warn('kuromoji worker: could not start', err && err.message);
            worker = null;
            resolve(false);
          });
        return;
      }
      resolve(loadInThread());
    });
    return kuroPromise;
  }

  function attachWorker(resolve) {
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'ready') { ready(); resolve(true); }
      else if (msg.type === 'error') { console.warn('kuromoji worker:', msg.message); worker.terminate(); worker = null; resolve(false); }
      else if (msg.type === 'tokens') {
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg.tokens); }
      }
    };
    worker.onerror = (err) => {
      console.warn('kuromoji worker failed:', err && err.message);
      try { worker.terminate(); } catch (_) { /* ignore */ }
      worker = null;
      resolve(false);
    };
    worker.postMessage({ type: 'init', script: KUROMOJI_SCRIPT, dicPath: DIC_PATH });
  }

  /* フォールバック: 同一スレッド（Worker が使えない環境。Node のテストなど） */
  function loadInThread() {
    return new Promise((resolve) => {
      if (typeof window.kuromoji === 'undefined') { resolve(false); return; }
      try {
        window.kuromoji.builder({ dicPath: DIC_PATH }).build((err, tokenizer) => {
          if (err || !tokenizer) { resolve(false); return; }
          kuro = tokenizer;
          ready();
          resolve(true);
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function onEngineChange(fn) { listeners.push(fn); }
  function currentEngine() { return engine; }

  return { analyze, analyzeAsync, normalize, loadKuromoji, onEngineChange, currentEngine, NOUN_STOP };
})();

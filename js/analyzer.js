/* ==========================================================================
   AZILE analyzer — 形態素解析の抽象層
   起動直後: TinySegmenter（辞書不要・即時）＋ 文字種ヒューリスティックで品詞推定
   その後:   kuromoji.js の辞書ロードが完了したら自動で切替（品詞・基本形・読み付き）
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.analyzer = (function () {
  'use strict';

  const DIC_PATH = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

  let engine = 'tiny';
  let tiny = null;
  let kuro = null;
  let kuroPromise = null;
  const listeners = [];

  /* ---- 代名詞・形式名詞など、キーワードとして拾いたくない名詞 ---------- */
  const NOUN_STOP = new Set([
    'こと', 'もの', 'の', 'これ', 'それ', 'あれ', 'どれ', 'ここ', 'そこ', 'あそこ', 'どこ', 'こっち', 'そっち',
    '何', 'なに', 'なん', '誰', 'だれ', 'いつ', '私', 'わたし', '僕', 'ぼく', '俺', 'おれ', 'あなた', '君', 'きみ',
    'お前', '自分', '今日', '明日', '昨日', '今', '時', 'とき', '人', 'ため', 'よう', 'さん', 'ちゃん', 'くん',
    '感じ', '気', '方', 'ほう', '的', 'さ', 'み', '中', '前', '後', '上', '下', '間', 'うち', 'はず', 'わけ', 'つもり',
    'みたい', 'そう', 'よ', 'ね', 'な', 'AZILE', 'アジール', 'azile', '画像', 'イラスト', '絵', '写真', 'ピクチャ',
    '生成', '作成', '検索', '法律', '条', '第', '項', '号', '意味', '説明', '解説', '定義', '話', '件', '一', '二', '三',
    'ちょうだい', '頂戴', 'ください', '下さい', 'お願い', 'おねがい', '名言', 'セリフ', '台詞', '決め台詞'
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

  /* ---- kuromoji → トークン ---------------------------------------------- */
  function kuroTokens(text) {
    return kuro.tokenize(text).map((t) => ({
      surface: t.surface_form,
      pos: t.pos,
      detail: t.pos_detail_1 || '',
      basic: (t.basic_form && t.basic_form !== '*') ? t.basic_form : t.surface_form,
      reading: (t.reading && t.reading !== '*') ? t.reading : ''
    }));
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
  function analyze(raw) {
    const text = normalize(raw);
    let tokens;
    let used = engine;
    try {
      tokens = engine === 'kuromoji' && kuro ? kuroTokens(text) : tinyTokens(text);
    } catch (_) {
      tokens = tinyTokens(text);
      used = 'tiny';
    }

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
  function loadKuromoji() {
    if (kuroPromise) return kuroPromise;
    kuroPromise = new Promise((resolve) => {
      const start = () => {
        if (typeof window.kuromoji === 'undefined') { resolve(false); return; }
        try {
          window.kuromoji.builder({ dicPath: DIC_PATH }).build((err, tokenizer) => {
            if (err || !tokenizer) { resolve(false); return; }
            kuro = tokenizer;
            engine = 'kuromoji';
            listeners.forEach((fn) => { try { fn('kuromoji'); } catch (_) { /* ignore */ } });
            resolve(true);
          });
        } catch (_) {
          resolve(false);
        }
      };
      /* kuromoji.js は defer 読込なので、まだ無ければ load を待つ */
      if (typeof window.kuromoji !== 'undefined' || document.readyState === 'complete') start();
      else window.addEventListener('load', start, { once: true });
    });
    return kuroPromise;
  }

  function onEngineChange(fn) { listeners.push(fn); }
  function currentEngine() { return engine; }

  return { analyze, normalize, loadKuromoji, onEngineChange, currentEngine, NOUN_STOP };
})();

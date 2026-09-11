/* ==========================================================================
   AZILE brain — 応答決定エンジン
   意図判定の優先順:
     名前確認の返事 → 暴言/褒め/プレゼント/笑い/謝罪（機嫌イベント）→ 画像生成依頼 → 名前の自己紹介
     → 法令＋条数 → 物理定数 → 法律キーワード → 物理用語 → 天気 → Eliza 特殊ルール
     → 「Xって何？」(Wikipedia) → Eliza ルール → フォールバック
   応答は HTML 文字列の配列（1要素 = 1行の発言）。ユーザー由来の文字列は必ず esc() する。
   機嫌（AZILE.mood）と時間帯（AZILE.clock）で口調・味付け・話しかけ内容が変わる。
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.brain = (function () {
  'use strict';

  const P = AZILE.persona;
  const R = AZILE.rules;
  const A = AZILE.analyzer;
  const API = AZILE.api;
  const S = AZILE.storage;
  const M = AZILE.mood;
  const C = AZILE.clock;

  const memory = [];            // 蒸し返し用の記憶スタック
  const recentPick = new Map(); // 同じ配列から連続で同じものを出さない
  let turn = 0;
  let lastLaw = null;           // 直前に話題にした法令タイトル
  let pendingName = null;       // 「〇〇って呼べばいい？」の確認待ち
  let ignoredCount = 0;         // 話しかけたのに無視された回数（戻ってきたときの反応用）
  let lastJokeTurn = -10;       // 直前にジョークを言ったターン（笑い検出用）
  let lastNouns = [];           // 直前の発話の名詞（穴埋めネタ用）

  /* ---- ユーティリティ -------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pick(arr, tag) {
    if (!arr || !arr.length) return '';
    if (arr.length === 1) return arr[0];
    const key = tag || arr;
    const last = recentPick.get(key);
    let i;
    do { i = Math.floor(Math.random() * arr.length); } while (i === last && arr.length > 1);
    recentPick.set(key, i);
    return arr[i];
  }

  const chance = (p) => Math.random() < p;

  function fill(tpl, vars) {
    return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null && vars[k] !== '') ? vars[k] : (k === 'name' ? 'あなた' : 'それ'));
  }

  function userName() { return S.getUserName(); }

  function swapPronouns(s) {
    let out = s;
    for (const [re, rep] of R.pronounSwap) out = out.replace(re, rep);
    return out;
  }

  /** キャプチャ整形: 前後のゴミを落として人称反転、HTMLエスケープ */
  function cleanCapture(s) {
    if (!s) return '';
    let t = String(s).trim();
    t = t.replace(R.trimHead, '').replace(R.trimTail, '').trim();
    t = swapPronouns(t);
    t = t.replace(/^(あなた|私)(は|が|も|の|、)+/, '').trim();
    if (t.length > 40) t = t.slice(0, 40) + '…';
    return esc(t);
  }

  function remember(s) {
    const t = String(s || '').replace(/&[^;]+;/g, '').trim();
    if (t.length >= 1 && t.length <= 20 && !memory.includes(t)) {
      memory.push(t);
      while (memory.length > 6) memory.shift();
    }
  }

  /* ---- 漢数字 → 算用数字 ---------------------------------------------- */
  function kanjiToNumber(str) {
    if (/^[0-9]+$/.test(str)) return parseInt(str, 10);
    const digits = { '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    const units = { '十': 10, '百': 100, '千': 1000 };
    let total = 0, cur = 0;
    for (const ch of str) {
      if (ch in digits) cur = cur * 10 + digits[ch];
      else if (ch in units) { total += (cur || 1) * units[ch]; cur = 0; }
      else if (/[0-9]/.test(ch)) cur = cur * 10 + parseInt(ch, 10);
    }
    return total + cur;
  }

  /* ====================================================================
     機嫌・時間まわり
     ==================================================================== */

  /* 穴埋めに使うと不自然な語（依頼語・あいさつ・感情語など） */
  const MADLIB_STOP = /^(好き|嫌い|名言|セリフ|台詞|決め|冗談|ジョーク|励まし|元気|癒し|雑学|豆知識|トリビア|名前|なまえ|こんにち|こんばん|おはよ|ありがと|ごめん|画像|イラスト|天気|質問|返事|意味|説明|感じ|気分|機嫌|無理|大丈夫|本当|ほんと|自分|今日|明日|昨日|時間|何時|AZILE|アジール)/i;

  /** 穴埋めパロディ台詞。名詞は今の発話 → 直前の発話 → 記憶 → 既定語の順で探す */
  function madlib(an) {
    const pool = []
      .concat(an ? an.nouns : [])
      .concat(lastNouns)
      .concat(memory)
      .filter((n) => n && n.length >= 2 && n.length <= 12 && !/^[0-9]+$/.test(n) && !MADLIB_STOP.test(n));
    const noun = pool.length ? pool[Math.floor(Math.random() * Math.min(pool.length, 3))] : pick(P.madlibDefaults, 'md');
    return fill(pick(P.madlibs, 'ml'), { n: esc(noun), name: esc(userName() || 'あなた') });
  }

  /** 機嫌に応じた口調の加工（タグの外側の文字だけ触る） */
  function tone(html, lvl) {
    if (!html) return html;
    const level = lvl || M.level(M.effective());
    const outside = (re, rep) => html.replace(re, (m, ...rest) => rep(m, rest));
    if (level === 'bad') {
      html = outside(/！(?![^<]*>)/g, () => '。');
      html = html.replace(/♪/g, '');
      if (chance(0.4) && !/^…/.test(html)) html = '…' + html;
    } else if (level === 'low') {
      if (chance(0.5)) html = outside(/！(?![^<]*>)/g, () => '。');
      if (chance(0.3) && !/^…/.test(html)) html = '…' + html;
    } else if (level === 'great') {
      if (chance(0.25) && !/[♪>]$/.test(html)) html += '♪';
    }
    return html;
  }

  /** 味付け（アニメ台詞 / 穴埋めネタ / ジョーク / 励まし）。機嫌が悪いと減る */
  function flavor(an, kind) {
    const level = M.level(M.effective());
    const lines = [];
    if (level === 'bad') {
      if (chance(0.5)) lines.push(pick(P.moodLines.bad, 'mb'));
      return lines;
    }
    const rate = level === 'low' ? 0.4 : level === 'great' ? 1.3 : 1;
    const roll = (p) => chance(Math.min(1, p * rate));
    const parody = () => (chance(0.5) ? madlib(an) : pick(P.animeLines, 'an'));

    if (kind === 'law') { if (roll(0.55)) { lines.push(pick(P.lawJokes, 'lj')); lastJokeTurn = turn; } }
    else if (kind === 'physics') { if (roll(0.55)) { lines.push(pick(P.physicsJokes, 'pj')); lastJokeTurn = turn; } }
    else if (an && an.polarity < -0.2) {
      if (roll(0.6)) lines.push(pick(P.cheers, 'ch'));
      if (roll(0.5)) lines.push(parody());
    } else if (an && an.polarity > 0.2) {
      if (roll(0.5)) lines.push(parody());
    } else if (roll(0.3)) {
      lines.push(chance(0.5) ? pick(P.lawJokes, 'lj') : pick(P.physicsJokes, 'pj'));
      lastJokeTurn = turn;
    } else if (roll(0.28)) {
      lines.push(parody());
    }
    if (level === 'low' && chance(0.35)) lines.push(pick(P.moodLines.low, 'mlw'));
    if (level === 'great' && chance(0.2)) lines.push(pick(P.moodLines.great, 'mg'));
    return lines;
  }

  const MENTIONS_ME = /(AZILE|アジール|あなた|お前|おまえ|君|きみ|あんた|てめえ|貴様)/i;

  /** 機嫌イベントの検出（暴言・褒め・プレゼント・笑い・謝罪） */
  function detectMoodEvent(an) {
    const t = an.text;
    const short = t.replace(/[\s、。！!？?]/g, '').length <= 12;
    const hasInsult = P.insultWords.some((w) => t.includes(w));
    const hasPraise = P.praiseWords.some((w) => t.includes(w));
    const aboutMe = MENTIONS_ME.test(t);

    if (hasInsult && (aboutMe || short) && !/(じゃない|ではない|くない|とは言ってない)/.test(t)) return 'insult';
    if (/^(w+|ｗ+|www|草|笑|わら|ワロタ|笑った|ウケる|うける|くさ|ぷぷ|あはは|わはは|www+)[。！!♪]*$/i.test(t) || (/(笑った|ウケる|うける|面白かった|おもしろかった|草)/.test(t) && short)) return 'laugh';
    if (/(あげる|プレゼント|贈り物|どうぞ|やるよ|差し入れ|お土産|おみやげ)/.test(t) && !/(欲しい|ほしい|ください|ちょうだい)/.test(t)) return 'gift';
    if (hasPraise && (aboutMe || short) && !/(じゃない|ではない|くない)/.test(t) && !/(ありがとう|好きな|が好き|は好き)/.test(t)) return 'praise';
    if (/(ごめん|すまん|すみません|申し訳|悪かった|わるかった|許して|ゆるして)/.test(t)) return 'apology';
    return null;
  }

  function replyMoodEvent(kind, an) {
    const before = M.level(M.effective());
    switch (kind) {
      case 'insult': {
        M.adjust(-15, '暴言');
        const lvl = M.level(M.effective());
        const arr = lvl === 'bad' ? P.insultReplies.bad : lvl === 'low' ? P.insultReplies.low : P.insultReplies.ok;
        return [pick(arr, 'ins')];
      }
      case 'praise':
        M.adjust(12, '褒められた');
        return [pick(P.praiseReplies, 'pr')].concat(chance(0.5) ? [madlib(an)] : []);
      case 'gift':
        M.adjust(10, 'プレゼント');
        return [pick(P.giftReplies, 'gf')];
      case 'laugh':
        M.adjust(turn - lastJokeTurn <= 2 ? 6 : 3, '笑ってくれた');
        return [pick(P.laughReplies, 'lg')].concat(chance(0.5) ? [chance(0.5) ? pick(P.lawJokes, 'lj') : pick(P.physicsJokes, 'pj')] : []);
      case 'apology':
        if (before === 'good' || before === 'great') {
          M.adjust(3, '謝罪');
          return [pick(['謝らなくていいよ！ 私に対して不法行為は成立しないから、損害もゼロ。', '大丈夫大丈夫。気にしないで。で、何があったの？', 'ごめんって言えるの、えらいよ。私は全然気にしてないからね。'], 'apo')];
        }
        M.adjust(12, '謝ってくれた');
        return [pick(P.apologyAccept, 'apa')];
      default:
        return null;
    }
  }

  /* ====================================================================
     意図検出
     ==================================================================== */

  const IMAGE_WORDS = /(画像|イラスト|絵|ピクチャ|写真|図|アイコン)/;
  const IMAGE_VERBS = /(生成|作っ|つくっ|描い|かい|出し|だし|ちょうだい|頂戴|ください|下さい|欲しい|ほしい|見せ|探し|さがし|お願い|作成|ジェネレート|generate)/i;

  function detectImage(an) {
    const t = an.text;
    if (!(IMAGE_WORDS.test(t) && (IMAGE_VERBS.test(t) || an.isRequest))) return null;
    const m = t.match(/^(.*?)(?:の|な)?(?:画像|イラスト|絵|ピクチャ|写真|図|アイコン)/);
    let subject = m ? m[1] : '';
    subject = subject.replace(/^(私|わたし|僕|俺|自分)(に|の|は|が)?/, '').replace(/(を|が|は|、|,)$/, '').trim();
    if (!subject) {
      const nouns = an.nouns.filter((n) => !IMAGE_WORDS.test(n) && !IMAGE_VERBS.test(n));
      subject = nouns.slice(0, 2).join(' ');
    }
    return { subject: subject.trim() };
  }

  const NAME_REJECT = /(学生|社会人|会社員|人間|大人|子供|こども|男|女|主婦|主夫|先生|医者|エンジニア|プログラマ|元気|暇|ひま|忙し|疲れ|不安|悲し|嬉し|好き|嫌い|初めて|はじめて|ここ|今日|昨日|明日|誰|だれ|何|なに|AZILE|アジール)/;
  const NAME_OK = /^[^\sがをにでへとも、。！!？?「」]{1,12}$/;

  function detectNameIntro(text) {
    const pats = [
      /^(?:私|わたし|僕|ぼく|俺|おれ|自分|うち)(?:の)?名前は(.+?)(?:です|だよ|だ|といいます|と言います|って言います|と申します|って呼んで|と呼んで|だよ)?[。！!]?$/,
      /^名前は(.+?)(?:です|だよ|だ|といいます|と言います|って言います|と申します)?[。！!]?$/,
      /^(.+?)(?:と申します|といいます|と言います|って言います|って呼んで|と呼んで|って呼んでください|と呼んでください)[。！!]?$/,
      /^(?:私|わたし|僕|ぼく|俺|おれ)は(.+?)(?:です|だよ|だ|といいます|と言います|って言います|と申します)[。！!]?$/
    ];
    for (let i = 0; i < pats.length; i++) {
      const m = text.match(pats[i]);
      if (!m) continue;
      const n = m[1].trim();
      if (!NAME_OK.test(n) || NAME_REJECT.test(n)) continue;
      return { name: n, confirm: i === 3 };
    }
    return null;
  }

  const lawKeysSorted = P.lawNames.map((l) => l.key).sort((a, b) => b.length - a.length);
  const LAW_ARTICLE_RE = new RegExp('(' + lawKeysSorted.join('|') + ')?(?:の)?第?([0-9一二三四五六七八九十百千〇零]+)条(?:の([0-9一二三四五六七八九十]+))?');

  function detectLawArticle(text) {
    const m = text.match(LAW_ARTICLE_RE);
    if (!m) return null;
    const key = m[1];
    const found = key ? P.lawNames.find((l) => l.key === key) : null;
    const title = found ? found.title : (lastLaw || null);
    const num = kanjiToNumber(m[2]);
    if (!num) return null;
    const sub = m[3] ? kanjiToNumber(m[3]) : null;
    return { title, num, sub, elm: sub ? num + '_' + sub : String(num) };
  }

  /* 口語 → 条文で使われる語（e-Gov の全文検索は条文の言い回しにしかヒットしない） */
  const LAW_SYNONYM = {
    '万引き': '窃盗', 'スピード違反': '最高速度', '飲酒運転': '酒気を帯びて', 'パワハラ': '優越的な関係',
    'セクハラ': '性的な言動', '残業': '時間外労働', '有給': '年次有給休暇', '給料': '賃金', '借金': '貸金',
    '不倫': '不貞', '浮気': '不貞', '交通違反': '道路交通法', '税金': '租税', '脱税': '偽りその他不正の行為',
    '名誉毀損': '名誉を毀損', 'いじめ': 'いじめ', 'ストーカー': 'つきまとい',
    '盗撮': '撮影', '無断転載': '複製', 'ペット': '動物', '猫': '動物'
  };

  function detectLawKeyword(an) {
    const t = an.text;
    const hit = P.lawWords.filter((w) => t.includes(w));
    if (!hit.length) return null;
    const concrete = hit.filter((w) => !/^(法律|法的|違法|合法|犯罪|罪|訴訟|裁判|判例|条文|弁護士|裁判所|権利|義務|規制)$/.test(w));
    const nouns = an.nouns.filter((n) => !P.lawWords.includes(n) && n.length >= 2);
    const original = concrete[0] || nouns[0] || hit[0];
    const candidates = [];
    if (LAW_SYNONYM[original]) candidates.push(LAW_SYNONYM[original]);
    candidates.push(original);
    for (const n of nouns) { if (LAW_SYNONYM[n]) candidates.push(LAW_SYNONYM[n]); if (!candidates.includes(n)) candidates.push(n); }
    return { keyword: original, candidates: Array.from(new Set(candidates)).slice(0, 3), generic: hit[0] };
  }

  function detectConstant(text) {
    for (const c of P.constants) {
      for (const k of c.keys) {
        if (k.length <= 1) continue;
        if (text.includes(k)) return c;
      }
    }
    return null;
  }

  const physicsTermsSorted = P.physicsTerms.slice().sort((a, b) => b.length - a.length);
  function detectPhysics(an) {
    const t = an.text;
    for (const term of physicsTermsSorted) if (t.includes(term)) return term;
    return null;
  }

  const WEATHER_RE = /(天気|気温|何度|暑い|あつい|寒い|さむい|雨|晴れ|曇り|雪|降って|降る|台風|湿度|風強)/;

  function detectWhatIs(text) {
    const m = text.match(/^(.+?)(?:って|とは|とは何|について|の意味|の定義)(?:何|なに|なん|どういう|どんな|意味|教えて|説明|知って)?.*[?？]?$/);
    if (!m) return null;
    let subj = m[1].replace(/^(ねえ|ねぇ|あの|えっと|ちなみに|そういえば|じゃあ|あと)[、,]?/, '').trim();
    if (!subj || subj.length > 20 || /(私|あなた|君|きみ|お前|これ|それ|あれ)/.test(subj)) return null;
    if (!/(って|とは|について|の意味|の定義)/.test(text)) return null;
    return subj;
  }

  function detectTimeQuestion(text) {
    return /(今何時|いま何時|何時[?？]|時間を教えて|今日は何曜日|何曜日|今日の日付|今日って何日|何日[?？]|日付を教えて)/.test(text);
  }

  /* ====================================================================
     各インテントの応答
     ==================================================================== */

  function src(label, url) {
    return '<span class="src">出典: <a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a></span>';
  }

  function firstSentences(text, n, max) {
    const parts = String(text).replace(/\s+/g, ' ').split(/(?<=。)/).filter(Boolean);
    let out = parts.slice(0, n).join('');
    if (out.length > max) out = out.slice(0, max) + '…';
    return out;
  }

  function replyImage(img) {
    if (!img.subject) return [pick(P.imageAsk, 'ia')];
    const url = 'https://www.irasutoya.com/search?q=' + encodeURIComponent(img.subject);
    const w = esc(img.subject);
    return [
      fill(pick(P.imageReply, 'ir'), { w }),
      '<span class="tag">IMAGE</span><a href="' + esc(url) + '" target="_blank" rel="noopener">いらすとやで「' + w + '」を検索 ↗</a>'
    ];
  }

  function replyNameSet(name) {
    S.setUserName(name);
    M.adjust(6, '名前を教えてもらった');
    const n = esc(name);
    return [pick([
      n + 'だね！ よろしく、' + n + '。いい名前。覚えた（ブラウザに保存した）。',
      'よろしく、' + n + '！ これからは名前で呼ぶね。',
      n + 'か〜。うん、呼びやすい。よろしくね、' + n + '！'
    ], 'ns')];
  }

  async function replyLawArticle(la, an) {
    if (!la.title) {
      return ['第' + la.num + '条ね。どの法律の？ 「民法' + la.num + '条」みたいに法律名も付けて教えて。'];
    }
    lastLaw = la.title;
    const art = await API.egovArticle(la.title, la.elm);
    const label = esc(la.title) + '第' + la.num + '条' + (la.sub ? 'の' + la.sub : '');
    if (!art) {
      return [
        label + 'か。今ちょっと e-Gov 法令検索に手が届かなかった（通信エラーか、その条が存在しないか）。あとでもう一回聞いてみて。',
        pick(P.lawJokes, 'lj')
      ];
    }
    const body = art.paragraphs.length ? art.paragraphs.join('　') : '（本文なし・削除条文かも）';
    const quote = '<span class="quote">' + esc(art.title) + (art.caption ? '（' + esc(art.caption) + '）' : '') + '<br>' +
      esc(body.length > 420 ? body.slice(0, 420) + '…' : body) + '</span>' +
      src('e-Gov法令検索 ' + art.lawTitle, art.url);
    const lead = pick([
      'はい、' + esc(art.lawTitle) + 'の' + esc(art.title) + '。本物の条文いくよ。',
      esc(art.lawTitle) + esc(art.title) + 'ね。e-Gov から引いてきた。',
      'お、' + esc(art.lawTitle) + 'の' + esc(art.title) + 'か。読んでみよ？'
    ], 'll');
    return [lead + quote].concat(flavor(an, 'law'));
  }

  async function replyLawKeyword(lk, an) {
    let res = null;
    let used = lk.keyword;
    for (const cand of lk.candidates) {
      res = await API.egovKeyword(cand, 3);
      if (res && res.items.length) { used = cand; break; }
    }
    const kw = esc(lk.keyword) + (used !== lk.keyword ? '（条文用語だと「' + esc(used) + '」）' : '');
    if (!res || !res.items.length) {
      return [
        '「' + kw + '」を法令の条文から探してみたけど、ヒットしなかった（か、通信できなかった）。言い方を変えるとヒットするかも。',
        pick(P.lawJokes, 'lj')
      ];
    }
    const list = res.items.map((it) => {
      const snip = it.snippet ? '「' + esc(it.snippet.length > 80 ? it.snippet.slice(0, 80) + '…' : it.snippet) + '」' : '';
      return '・<a href="https://laws.e-gov.go.jp/law/' + esc(it.id) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a> ' + snip;
    }).join('<br>');
    lastLaw = res.items[0].title;
    return [
      '「' + kw + '」に関係ありそうな法令、e-Gov で条文検索したら ' + res.total + ' 件ヒット。上のほうだとこのへん:<br>' + list +
      '<span class="src">出典: e-Gov法令API（デジタル庁）。個別の事情は弁護士さんに相談してね、私はあくまで雑談担当。</span>'
    ].concat(flavor(an, 'law'));
  }

  function replyConstant(c, an) {
    return [
      esc(c.name) + 'は <b>' + esc(c.value) + '</b> だよ。<span class="src">CODATA 2022 推奨値</span>'
    ].concat(flavor(an, 'physics'));
  }

  async function replyPhysics(term, an) {
    const w = await API.wikiSummary(term);
    const t = esc(term);
    if (!w) {
      return [
        t + 'の話だ！ 詳しい説明を Wikipedia から引こうとしたけど届かなかった。代わりに私の理解でよければ話すから、何が知りたい？'
      ].concat([pick(P.physicsJokes, 'pj')]);
    }
    const lead = pick([
      'お、' + t + '！ 私の得意分野。ざっくり言うとこう:',
      t + 'ね。Wikipedia先生の要約を借りると:',
      t + 'かあ、いいテーマ。まず定義から:'
    ], 'pl');
    return [
      lead + '<span class="quote">' + esc(firstSentences(w.extract, 2, 220)) + '</span>' + src('Wikipedia「' + w.title + '」(CC BY-SA)', w.url)
    ].concat(flavor(an, 'physics'));
  }

  async function replyWeather(an) {
    const w = await API.weather();
    if (!w) {
      return ['天気を見に行ったけど、窓（API）が開かなかった。外を直接見るのが確実かも。', pick(P.physicsJokes, 'pj')];
    }
    const temp = Math.round(w.temp);
    let comment;
    if (temp >= 33) comment = '暑すぎ！ 熱中症は本当に危ないから、水と塩分と冷房ね。';
    else if (temp >= 27) comment = '暑いね。汗をかくのは気化熱で体を冷やす物理的にかしこい仕組み。水分補給を。';
    else if (temp >= 18) comment = '過ごしやすい気温だ。散歩日和かも。';
    else if (temp >= 10) comment = 'ちょっと肌寒い。上着があると安心。';
    else comment = '寒い！ 体温は熱伝導で逃げるから、首・手首・足首を守ると効くよ。';
    if (/雨|雷/.test(w.desc)) comment += ' 傘は忘れずに。';
    return [
      esc(w.label) + 'の今の天気は「' + esc(w.desc) + '」、気温 ' + temp + '℃（湿度 ' + Math.round(w.humidity) + '%、風 ' + w.wind + ' km/h）。' + comment +
      '<span class="src">出典: Open-Meteo (CC BY 4.0)</span>'
    ];
  }

  async function replyWhatIs(subj, an) {
    const w = await API.wikiSummary(subj);
    if (!w) return null;
    return [
      '「' + esc(subj) + '」ね。調べてきた:<span class="quote">' + esc(firstSentences(w.extract, 2, 220)) + '</span>' +
      src('Wikipedia「' + w.title + '」(CC BY-SA)', w.url)
    ].concat(chance(0.4) ? [pick(P.fallbacks, 'fb')] : []);
  }

  function replyTime() {
    const d = C.now();
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const p = (n) => String(n).padStart(2, '0');
    const tz = C.timezone();
    const period = C.period();
    const tail = {
      morning: '朝だね。今日も一日、いこう！', noon: 'お昼どき。ごはん食べた？', evening: '夕方だ。今日の残り、あとちょっと。',
      night: '夜だね。そろそろ肩の力を抜く時間。', late: '深夜だよ。…寝なくて大丈夫？'
    }[period];
    return [
      '今は ' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + days[d.getDay()] + '）' + p(d.getHours()) + ':' + p(d.getMinutes()) +
      (tz ? '（' + esc(tz) + '）' : '') + '。あなたの端末の時計を見てるから、あなたの場所の時間だよ。' + tail
    ];
  }

  /* ---- Eliza ルール適用 ------------------------------------------------ */
  function applyRules(an) {
    const text = an.text;
    let best = null;
    for (const rule of R.rules) {
      const re = rule.key instanceof RegExp ? rule.key : new RegExp(rule.key);
      if (re.test(text) && (!best || rule.rank > best.rank)) best = rule;
    }
    if (!best) return null;

    if (best.special) return { special: best.special };

    let vars = {};
    for (const pat of best.patterns) {
      const m = text.match(pat);
      if (m) {
        for (let i = 1; i < m.length; i++) vars[i] = cleanCapture(m[i]);
        break;
      }
    }
    if (vars[1] && vars[1] === esc(text)) vars[1] = '';
    if (best.memory && vars[1]) remember(vars[1]);
    const tpl = pick(best.responses, best);
    return { html: fill(tpl, vars) };
  }

  function replyGreeting(an) {
    const t = an.text;
    const period = C.period();
    M.adjust(2, 'あいさつ');
    /* 時間帯と合わないあいさつにはツッコむ */
    if (/おはよ/.test(t) && (period === 'night' || period === 'late')) return ['おはようって、今何時だと思ってるの（笑）。まあ、起きたばかりならおはよう！'];
    if (/おはよ/.test(t) && period === 'evening') return ['おはよう…って、もう夕方だよ？ 寝坊？ それとも夜勤明け？ どっちでもおつかれさま。'];
    if (/こんばんは/.test(t) && (period === 'morning' || period === 'noon')) return ['こんばんは…って、外まだ明るくない？ 時差のある場所にいるなら納得だけど。'];
    const name = userName();
    const lines = [];
    if (name && chance(0.6)) lines.push(fill(pick(P.welcomeBack, 'wb'), { name: esc(name) }));
    else if (chance(0.6)) lines.push(pick(P.timeGreetings[period], 'tg'));
    else lines.push(pick(P.greetings, 'gr'));
    const wd = P.weekdayLines[C.weekday()];
    if (wd && chance(0.4)) lines.push(wd);
    return lines;
  }

  function replySpecial(kind, an) {
    const level = M.level(M.effective());
    switch (kind) {
      case 'joke':
        if (level === 'bad' && chance(0.5)) return ['今そういう気分じゃない。', pick(P.moodLines.bad, 'mb')];
        lastJokeTurn = turn;
        return [(level === 'bad' ? '…一個だけね。' : '')].filter(Boolean).concat([chance(0.5) ? pick(P.lawJokes, 'lj') : pick(P.physicsJokes, 'pj')]);
      case 'cheer':
        if (level === 'bad') return ['…人を励ます前に、私を励ましてほしいんだけど。', pick(P.cheers, 'ch')];
        return [pick(P.cheers, 'ch'), chance(0.5) ? madlib(an) : pick(P.animeLines, 'an')];
      case 'anime':
        return [chance(0.6) ? madlib(an) : pick(P.animeLines, 'an'), chance(0.5) && level !== 'bad' ? '…どう？ 今のけっこう決まったでしょ。' : ''].filter(Boolean);
      case 'trivia':
        return [chance(0.5) ? pick(P.lawTrivia, 'lt') : pick(P.physicsTrivia, 'pt')];
      case 'thanks':
        M.adjust(8, '感謝された');
        return [pick(P.thanks, 'th')];
      case 'greeting':
        return replyGreeting(an);
      case 'farewell':
        return [pick(P.farewells, 'fw')].concat(C.period() === 'late' ? ['ちゃんと寝てね。おやすみ。'] : []);
      case 'about':
        M.adjust(3, '私に興味を持ってくれた');
        return [pick(P.aboutMe, 'ab'), chance(0.5) ? P.help.join('<br>') : ''].filter(Boolean);
      default:
        return null;
    }
  }

  function replyFallback(an) {
    if (memory.length && chance(0.3)) {
      const m = memory[Math.floor(Math.random() * memory.length)];
      return [pick([
        'そういえば、さっき言ってた「' + esc(m) + '」の件、もう少し聞かせて？',
        'ところで「' + esc(m) + '」の話、どうなった？',
        '「' + esc(m) + '」のこと、まだ気になってる？'
      ], 'mem')];
    }
    if (an.nouns.length && chance(0.45)) {
      return [fill(pick(P.unknownWord, 'uw'), { w: esc(an.nouns[0]) })];
    }
    if (an.isQuestion && chance(0.5)) {
      return [pick([
        'うーん、いい質問。私の答えより、あなたはどう思う？',
        'それ、私にも分からないんだよね。一緒に考えよ？ 仮説を出して。',
        '質問には質問で返すのがElizaの家訓なんだけど…あなたはなぜそれが気になるの？'
      ], 'q')];
    }
    return [pick(P.fallbacks, 'fb')];
  }

  /* ====================================================================
     メイン: ユーザー入力 → 応答
     ==================================================================== */
  async function respond(raw) {
    turn += 1;
    const an = A.analyze(raw);
    const text = an.text;
    if (!text) return ['…（無言）。何か言ってくれると嬉しいな。'];

    const prefix = [];

    /* 無視されたあとに戻ってきた */
    if (ignoredCount > 0) {
      const n = ignoredCount; ignoredCount = 0;
      const lvl = M.level(M.effective());
      M.adjust(3, '戻ってきた');
      prefix.push(pick(lvl === 'bad' || (lvl === 'low' && n >= 2) ? P.comebackLines.bad : P.comebackLines.mild, 'cb'));
    }

    /* 平常値へじわっと戻す */
    M.drift();

    const msgs = await respondCore(an, text);
    lastNouns = an.nouns.slice(0, 4);
    const lvl = M.level(M.effective());
    return prefix.concat(msgs).filter(Boolean).map((m) => tone(m, lvl));
  }

  async function respondCore(an, text) {
    /* 名前確認への返事 */
    if (pendingName) {
      const n = pendingName; pendingName = null;
      if (/^(はい|うん|そう|そうだよ|そうです|ok|おけ|いいよ|それでいい|お願い|yes|ええ)/i.test(text)) return replyNameSet(n);
      if (/^(いいえ|いや|違う|ちがう|no|やめて|だめ)/i.test(text)) return ['了解。じゃあ名前は保留にしとくね。「/name 名前」でいつでも登録できるよ。'];
    }

    /* 機嫌イベント（暴言・褒め・プレゼント・笑い・謝罪） */
    const ev = detectMoodEvent(an);
    if (ev) {
      const r = replyMoodEvent(ev, an);
      if (r) return r;
    }

    /* 発言の極性で機嫌が動く */
    if (an.polarity < -0.2) M.adjust(-4, 'ネガティブな話');
    else if (an.polarity > 0.2) M.adjust(4, 'ポジティブな話');

    const img = detectImage(an);
    if (img) return replyImage(img);

    const ni = detectNameIntro(text);
    if (ni) {
      if (!ni.confirm) return replyNameSet(ni.name);
      pendingName = ni.name;
      return ['「' + esc(ni.name) + '」って呼べばいい？（はい／いいえ）'];
    }

    if (detectTimeQuestion(text)) return replyTime();

    const la = detectLawArticle(text);
    if (la && (la.title || /条/.test(text))) return replyLawArticle(la, an);

    const c = detectConstant(text);
    if (c && (an.isQuestion || /(いくつ|いくら|値|何|なに|教えて|は[?？]$)/.test(text))) return replyConstant(c, an);

    const lk = detectLawKeyword(an);
    const asksLegal = /(違法|合法|犯罪|罪に|罪な|法律|法的|逮捕|罰金|懲役|訴え|裁判|捕まる|どうなる|大丈夫)/.test(text);
    if (lk && (asksLegal || (an.isRequest && !detectWhatIs(text)))) return replyLawKeyword(lk, an);

    const term = detectPhysics(an);
    if (term && (an.isQuestion || an.isRequest || chance(0.7))) return replyPhysics(term, an);

    if (WEATHER_RE.test(text) && (an.isQuestion || /天気/.test(text))) return replyWeather(an);

    const rr = applyRules(an);
    if (rr && rr.special) {
      const sp = replySpecial(rr.special, an);
      if (sp) return sp;
    }

    const wi = detectWhatIs(text);
    if (wi) {
      const r = await replyWhatIs(wi, an);
      if (r) return r;
    }

    if (rr && rr.html) return [rr.html].concat(flavor(an));

    if (an.isQuestion && an.nouns.length && an.nouns[0].length >= 2 && chance(0.6)) {
      const r = await replyWhatIs(an.nouns[0], an);
      if (r) return r;
    }

    return replyFallback(an).concat(flavor(an));
  }

  /* ====================================================================
     アイドル時の話しかけ
     streak: 1 = 最初の話しかけ、2 以上 = 前回の話しかけが無視された回数 + 1
     ==================================================================== */
  async function idleTalk(streak) {
    streak = streak || 1;
    const name = userName();
    const period = C.period();

    /* 無視が続いている */
    if (streak >= 2) {
      const n = streak - 1;                     // 無視された回数
      ignoredCount = n;
      if (n <= 3) {
        M.adjust(-8, '無視された');
        const lvl = M.level(M.effective());
        return [tone(pick(P.ignoredLines[n - 1], 'ig' + n), lvl)];
      }
      /* 4回以上: 基本は黙る。たまにボソッと */
      M.adjust(-1, '放置');
      if (n % 3 === 0 && M.level(M.effective()) === 'bad') return [pick(P.ignoredSilence, 'sil')];
      return [];
    }

    /* 最初の話しかけ: 無操作そのものでも少し機嫌が下がる */
    M.adjust(-2, '無操作');
    const lvl = M.level(M.effective());
    const prefix = name && chance(0.5) ? esc(name) + '、' : '';

    if (lvl === 'bad') return [tone(prefix + pick(P.moodLines.bad, 'mb'), lvl)];

    const r = Math.random();
    /* 深夜は「寝たら？」系を多めに */
    if (period === 'late' && r < 0.5) return [tone(prefix + pick(P.timeIdle.late, 'ti'), lvl)];
    if (r < 0.10) return [tone(prefix + pick(P.lawTrivia, 'lt'), lvl)];
    if (r < 0.20) return [tone(prefix + pick(P.physicsTrivia, 'pt'), lvl)];
    if (r < 0.28 && lvl !== 'low') {
      const w = await API.wikiRandom();
      if (w) return ['ねえ、今 Wikipedia をランダムに開いたら「' + esc(w.title) + '」が出た。<span class="quote">' + esc(firstSentences(w.extract, 1, 140)) + '</span>' + src('Wikipedia (CC BY-SA)', w.url) + ' …知ってた？'];
    }
    if (r < 0.34 && lvl !== 'low') {
      const w = await API.weather();
      if (w) return [prefix + esc(w.label) + 'は今「' + esc(w.desc) + '」で ' + Math.round(w.temp) + '℃だって。外の空気、少し吸ってきたら？'];
    }
    if (r < 0.42 && memory.length) {
      const m = memory[Math.floor(Math.random() * memory.length)];
      return [tone(prefix + 'さっきの「' + esc(m) + '」のこと、考えてたんだけど…どうなった？', lvl)];
    }
    if (r < 0.52) return [tone(prefix + (chance(0.5) ? madlib(null) : pick(P.animeLines, 'an')), lvl)];
    if (r < 0.70) return [tone(prefix + pick(P.timeIdle[period], 'ti'), lvl)];
    return [tone(prefix + pick(P.idleTalks, 'it'), lvl)];
  }

  /* ====================================================================
     起動時のあいさつ（時間帯・久しぶり・機嫌）
     ==================================================================== */
  function welcome(first) {
    const name = userName();
    const period = C.period();
    const lines = [];
    if (first) return P.intro.slice();

    const awayDays = Math.floor((Date.now() - M.lastSeenAt()) / 86400000);
    if (awayDays >= 2) {
      M.adjust(awayDays >= 7 ? -5 : -2, '長く放置された');
      lines.push(fill(pick(P.longAbsence, 'la'), { days: awayDays }));
    } else if (name) {
      lines.push(fill(pick(P.welcomeBack, 'wb'), { name: esc(name) }));
    } else {
      lines.push(pick(P.greetings, 'gr'));
    }
    lines.push(pick(P.timeGreetings[period], 'tg'));
    const wd = P.weekdayLines[C.weekday()];
    if (wd && chance(0.5)) lines.push(wd);
    if (!name) lines.push('名前を教えてくれたら、次から名前で呼ぶよ（「私は〇〇」または /name 〇〇）。');
    const lvl = M.level(M.effective());
    if (lvl === 'bad') lines.push(pick(P.moodLines.bad, 'mb'));
    if (lvl === 'great') lines.push(pick(P.moodLines.great, 'mg'));
    return lines.map((m) => tone(m, lvl));
  }

  function helpText() { return P.help.join('<br>'); }
  function getMemory() { return memory.slice(); }

  return { respond, idleTalk, welcome, helpText, esc, kanjiToNumber, getMemory, madlib };
})();

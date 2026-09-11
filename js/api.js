/* ==========================================================================
   AZILE api — 外部 API ラッパー
   - e-Gov 法令API v2 (https://laws.e-gov.go.jp/api/2/)   認証不要 / CORS *
   - Wikipedia 日本語版 REST (https://ja.wikipedia.org/api/rest_v1/)
   - Open-Meteo (https://api.open-meteo.com/v1/forecast)
   すべて timeout 付き。失敗時は null を返し、呼び出し側が静的応答へフォールバックする。
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.api = (function () {
  'use strict';

  const TIMEOUT = 6000;
  const EGOV = 'https://laws.e-gov.go.jp/api/2/';
  const WIKI = 'https://ja.wikipedia.org/api/rest_v1/';
  const METEO = 'https://api.open-meteo.com/v1/forecast';
  const TOKYO = { lat: 35.6762, lon: 139.6503, label: '東京' };

  const memo = new Map();
  let lastError = null;

  async function fetchJSON(url, opts) {
    if (memo.has(url)) return memo.get(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!(opts && opts.noCache)) memo.set(url, json);
      lastError = null;
      return json;
    } catch (e) {
      lastError = e;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ====================================================================
     e-Gov 法令API v2
     ==================================================================== */

  /** 法令タイトルから law_id を引く（localStorage にキャッシュ） */
  async function egovLawId(title) {
    const cached = AZILE.storage.cacheGet('lawid:' + title);
    if (cached) return cached;
    const json = await fetchJSON(EGOV + 'laws?law_title=' + encodeURIComponent(title) + '&limit=20');
    if (!json || !Array.isArray(json.laws) || !json.laws.length) return null;
    const exact = json.laws.find((l) => l.revision_info && l.revision_info.law_title === title);
    const pick = exact || json.laws.find((l) => l.law_info && l.law_info.law_type === 'Act') || json.laws[0];
    const id = pick && pick.law_info && pick.law_info.law_id;
    if (id) AZILE.storage.cacheSet('lawid:' + title, id);
    return id || null;
  }

  /** e-Gov の JSON ツリーからテキストを平坦化 */
  function flat(node) {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flat).join('');
    if (node.children) return flat(node.children);
    return '';
  }

  function findAll(node, tag, out) {
    out = out || [];
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => findAll(n, tag, out)); return out; }
    if (node.tag === tag) out.push(node);
    if (node.children) findAll(node.children, tag, out);
    return out;
  }

  /**
   * 条文を取得。articleNum は "709" や "709_2"（第709条の2）形式。
   * @returns {{lawTitle, caption, title, paragraphs:string[], url}|null}
   */
  async function egovArticle(lawTitle, articleNum) {
    const id = await egovLawId(lawTitle);
    if (!id) return null;
    const url = EGOV + 'law_data/' + encodeURIComponent(id) +
      '?elm=' + encodeURIComponent('MainProvision-Article_' + articleNum) + '&response_format=json';
    const json = await fetchJSON(url);
    if (!json || !json.law_full_text) return null;
    const root = json.law_full_text;
    const article = root.tag === 'Article' ? root : findAll(root, 'Article')[0];
    if (!article) return null;

    const caption = flat(findAll(article, 'ArticleCaption')[0]).replace(/^（|）$/g, '');
    const title = flat(findAll(article, 'ArticleTitle')[0]);
    const paragraphs = findAll(article, 'Paragraph').map((p) => {
      const num = flat(findAll(p, 'ParagraphNum')[0]);
      const sent = flat(findAll(p, 'ParagraphSentence')[0]);
      const items = findAll(p, 'Item').slice(0, 4).map((it) => {
        const it_t = flat(findAll(it, 'ItemTitle')[0]);
        const it_s = flat(findAll(it, 'ItemSentence')[0]);
        return (it_t ? it_t + ' ' : '') + it_s;
      });
      return (num ? num + ' ' : '') + sent + (items.length ? ' ' + items.join('　') : '');
    }).filter(Boolean);

    const revTitle = json.revision_info && json.revision_info.law_title;
    return {
      lawTitle: revTitle || lawTitle,
      caption, title, paragraphs,
      url: 'https://laws.e-gov.go.jp/law/' + id + '#Mp-At_' + articleNum
    };
  }

  /** キーワード検索（条文本文の全文検索） */
  async function egovKeyword(keyword, limit) {
    const url = EGOV + 'keyword?keyword=' + encodeURIComponent(keyword) + '&limit=' + (limit || 3);
    const json = await fetchJSON(url);
    if (!json || !Array.isArray(json.items)) return null;
    return {
      total: json.total_count || 0,
      items: json.items.map((it) => ({
        title: it.revision_info && it.revision_info.law_title,
        id: it.law_info && it.law_info.law_id,
        /* e-Gov はヒット語を <span> で囲んで返すのでタグを除去 */
        snippet: String((it.sentences && it.sentences[0] && it.sentences[0].text) || '').replace(/<[^>]+>/g, '')
      })).filter((it) => it.title)
    };
  }

  /* ====================================================================
     Wikipedia 日本語版
     ==================================================================== */

  function wikiShape(json) {
    if (!json || !json.extract) return null;
    return {
      title: json.title,
      extract: json.extract,
      url: (json.content_urls && json.content_urls.desktop && json.content_urls.desktop.page) ||
        ('https://ja.wikipedia.org/wiki/' + encodeURIComponent(json.title))
    };
  }

  async function wikiSummary(title) {
    const json = await fetchJSON(WIKI + 'page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
    if (json && json.type === 'disambiguation') return null;
    return wikiShape(json);
  }

  async function wikiRandom() {
    return wikiShape(await fetchJSON(WIKI + 'page/random/summary', { noCache: true }));
  }

  /* ====================================================================
     Open-Meteo（天気）
     ==================================================================== */

  function geolocate() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) { resolve(TOKYO); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish(TOKYO), 4000);
      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: '現在地' }),
          () => finish(TOKYO),
          { timeout: 3500, maximumAge: 600000 }
        );
      } catch (_) { finish(TOKYO); }
    });
  }

  async function weather() {
    const loc = await geolocate();
    const url = METEO + '?latitude=' + loc.lat.toFixed(3) + '&longitude=' + loc.lon.toFixed(3) +
      '&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto';
    const json = await fetchJSON(url, { noCache: true });
    if (!json || !json.current) return null;
    const c = json.current;
    return {
      label: loc.label,
      temp: c.temperature_2m,
      code: c.weather_code,
      desc: AZILE.persona.weatherCodes[c.weather_code] || '不明な天気',
      wind: c.wind_speed_10m,
      humidity: c.relative_humidity_2m
    };
  }

  function getLastError() { return lastError; }

  return { egovLawId, egovArticle, egovKeyword, wikiSummary, wikiRandom, weather, getLastError };
})();

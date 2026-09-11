/* ==========================================================================
   AZILE kuromoji worker — 辞書の展開・構築と形態素解析を別スレッドで行う
   メインスレッドをブロックしないための Web Worker。
   受信: { type:'init', script, dicPath } / { type:'tokenize', id, text }
   送信: { type:'ready' } / { type:'error', message } / { type:'tokens', id, tokens }
   ========================================================================== */
'use strict';

let tokenizer = null;

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === 'init') {
    try {
      importScripts(msg.script);
    } catch (err) {
      self.postMessage({ type: 'error', message: 'importScripts failed: ' + (err && err.message) });
      return;
    }
    try {
      self.kuromoji.builder({ dicPath: msg.dicPath }).build(function (err, t) {
        if (err || !t) { self.postMessage({ type: 'error', message: 'build failed: ' + (err && err.message) }); return; }
        tokenizer = t;
        self.postMessage({ type: 'ready' });
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: 'builder failed: ' + (err && err.message) });
    }
    return;
  }
  if (msg.type === 'tokenize') {
    if (!tokenizer) { self.postMessage({ type: 'tokens', id: msg.id, tokens: null }); return; }
    try {
      const tokens = tokenizer.tokenize(String(msg.text || '')).map(function (t) {
        return {
          surface: t.surface_form,
          pos: t.pos,
          detail: t.pos_detail_1 || '',
          basic: (t.basic_form && t.basic_form !== '*') ? t.basic_form : t.surface_form,
          reading: (t.reading && t.reading !== '*') ? t.reading : ''
        };
      });
      self.postMessage({ type: 'tokens', id: msg.id, tokens: tokens });
    } catch (err) {
      self.postMessage({ type: 'tokens', id: msg.id, tokens: null });
    }
  }
};

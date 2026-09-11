/* ==========================================================================
   AZILE mood / clock — 隠しパラメータ「機嫌」と時間帯
   機嫌: 0〜100（平常値 70）。localStorage に保存し、離れている間は時間とともに平常値へ戻る。
   時刻: new Date() はブラウザを動かしている端末のローカル時刻なので、ユーザーの場所の時間になる。
   ========================================================================== */
window.AZILE = window.AZILE || {};

AZILE.clock = (function () {
  'use strict';

  function now() { return new Date(); }
  function hour() { return now().getHours(); }

  /** 時間帯: morning 5-10 / noon 10-17 / evening 17-19 / night 19-23 / late 23-5 */
  function period(h) {
    if (h == null) h = hour();
    if (h >= 5 && h < 10) return 'morning';
    if (h >= 10 && h < 17) return 'noon';
    if (h >= 17 && h < 19) return 'evening';
    if (h >= 19 && h < 23) return 'night';
    return 'late';
  }

  function weekday() { return now().getDay(); }

  function timezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
  }

  function label() {
    const p = (n) => String(n).padStart(2, '0');
    const d = now();
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  return { now, hour, period, weekday, timezone, label };
})();

AZILE.mood = (function () {
  'use strict';

  const BASE = 70;
  const MIN = 0;
  const MAX = 100;
  const RECOVER_PER_MIN = 0.15;   // 離れている間の回復（1時間で約9ポイント平常値へ）
  const listeners = [];
  const log = [];                // 直近の変動理由（デバッグ用 /mood）

  let value = BASE;
  let lastSeen = Date.now();

  function clamp(v) { return Math.max(MIN, Math.min(MAX, v)); }

  function load() {
    const saved = AZILE.storage.getMood();
    if (saved && typeof saved.value === 'number') {
      value = clamp(saved.value);
      lastSeen = saved.ts || Date.now();
      /* 離れていた時間ぶん、平常値に向かって戻す */
      const mins = Math.max(0, (Date.now() - lastSeen) / 60000);
      const drift = Math.min(Math.abs(value - BASE), mins * RECOVER_PER_MIN);
      value = value < BASE ? value + drift : value - drift;
    }
    save();
    return value;
  }

  function save() {
    AZILE.storage.setMood({ value: Math.round(value * 10) / 10, ts: Date.now() });
  }

  function get() { return Math.round(value); }

  /** 4段階: great(85+) / good(60+) / low(35+) / bad */
  function level(v) {
    const x = v == null ? value : v;
    if (x >= 85) return 'great';
    if (x >= 60) return 'good';
    if (x >= 35) return 'low';
    return 'bad';
  }

  function adjust(delta, reason) {
    if (!delta) return value;
    const before = level();
    value = clamp(value + delta);
    log.push({ delta, reason, at: AZILE.clock.label(), value: get() });
    while (log.length > 12) log.shift();
    save();
    const after = level();
    if (before !== after) listeners.forEach((fn) => { try { fn(after, before); } catch (_) { /* ignore */ } });
    else listeners.forEach((fn) => { try { fn(after, after); } catch (_) { /* ignore */ } });
    return value;
  }

  /** 会話が続いているあいだ、1ターンごとに平常値へ 1 ポイント寄せる */
  function drift() {
    if (value === BASE) return;
    value = value < BASE ? Math.min(BASE, value + 1) : Math.max(BASE, value - 1);
    save();
  }

  /** 深夜はちょっと眠くて機嫌が渋い（表示用の補正。保存値は変えない） */
  function effective() {
    const p = AZILE.clock.period();
    return clamp(value + (p === 'late' ? -6 : p === 'morning' ? 2 : 0));
  }

  function onChange(fn) { listeners.push(fn); }
  function history() { return log.slice(); }
  function lastSeenAt() { return lastSeen; }

  return { BASE, load, get, level, adjust, drift, effective, onChange, history, lastSeenAt };
})();

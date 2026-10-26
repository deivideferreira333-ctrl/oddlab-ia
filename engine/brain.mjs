// Cérebro da IA: análise de mercados, emissão de sinais, liquidação e aprendizado contínuo
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, MARKET_LABEL } from './config.mjs';
import { clamp, devig, soccerPredict, soccerUpdate, bbPredict, bbUpdate } from './model.mjs';

import { fileURLToPath } from 'node:url';

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'data');

const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return fb; } };
const writeJSON = (f, v, pretty = false) => {
  fs.mkdirSync(path.dirname(path.join(DATA_DIR, f)), { recursive: true });
  const tmp = path.join(DATA_DIR, f + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(v, null, pretty ? 1 : 0));
  fs.renameSync(tmp, path.join(DATA_DIR, f));
};

export function loadAll() {
  const state = readJSON('brain.json', null) || {
    version: 1, bootstrapped: false, cycles: 0, created: new Date().toISOString(),
    soccerLeagues: {}, soccerTeams: {}, bbLeagues: {}, bbTeams: {},
    learned: structuredClone(DEFAULTS.learned),
    stats: {}, calib: {}, processed: {}, snapshots: {}, lastLogged: {},
  };
  state.learned = { ...structuredClone(DEFAULTS.learned), ...state.learned,
    blend: { ...DEFAULTS.learned.blend, ...state.learned?.blend },
    minEV: { ...DEFAULTS.learned.minEV, ...state.learned?.minEV } };
  const signals = readJSON('signals.json', []);
  const backtest = readJSON('backtest.json', []);
  const learning = readJSON('learning.json', { insights: [], params: [], archived: [] });
  return { state, signals, backtest, learning };
}

export function saveAll(ctx, extra = {}) {
  const { state, signals, backtest, learning } = ctx;
  // arquiva insights antigos em arquivos mensais: o histórico de aprendizado não tem limite
  if (learning.insights.length > 3000) {
    const old = learning.insights.splice(0, learning.insights.length - 2000);
    const byMonth = {};
    for (const i of old) (byMonth[i.t.slice(0, 7)] ??= []).push(i);
    for (const [m, list] of Object.entries(byMonth)) {
      const f = `archive/insights-${m}.json`;
      writeJSON(f, [...readJSON(f, []), ...list]);
      if (!learning.archived.includes(f)) learning.archived.push(f);
    }
  }
  if (learning.params.length > 5000) learning.params.splice(0, learning.params.length - 5000);
  writeJSON('brain.json', state);
  writeJSON('signals.json', signals);
  writeJSON('backtest.json', backtest);
  writeJSON('learning.json', learning);
  for (const [f, v] of Object.entries(extra)) writeJSON(f, v);
}

// ---------- análise de mercados ----------
function opt(marketKey, side, label, line, pModel, pMarket, odd, blendW) {
  const p = pMarket != null ? blendW * pModel + (1 - blendW) * pMarket : pModel;
  return {
    marketKey, market: MARKET_LABEL[marketKey], side, label, line,
    pModel, pMarket, p, odd: odd || null,
    fair: p > 0 ? 1 / p : null,
    ev: odd ? p * odd - 1 : null,
  };
}

export function analyze(state, ev) {
  const B = state.learned.blend;
  const o = ev.odds || {};
  const markets = [];
  let pred;
  if (ev.sport === 'soccer') {
    pred = soccerPredict(state, ev, state.learned.dcRho);
    const mk = o.home && o.draw && o.away ? devig([o.home, o.draw, o.away]) : null;
    const w = B['soccer:1x2'];
    markets.push(
      opt('soccer:1x2', 'home', ev.home.short || ev.home.name, null, pred.home, mk?.probs[0], o.home, w),
      opt('soccer:1x2', 'draw', 'Empate', null, pred.draw, mk?.probs[1], o.draw, w),
      opt('soccer:1x2', 'away', ev.away.short || ev.away.name, null, pred.away, mk?.probs[2], o.away, w),
    );
    const line = o.totalLine != null && Math.abs((o.totalLine * 2) % 2) === 1 ? o.totalLine : 2.5;
    const pOver = pred.over[line] ?? pred.over[2.5];
    const mt = o.totalLine === line && o.over && o.under ? devig([o.over, o.under]) : null;
    const wt = B['soccer:ou'];
    markets.push(
      opt('soccer:ou', 'over', `Over ${line}`, line, pOver, mt?.probs[0], mt ? o.over : null, wt),
      opt('soccer:ou', 'under', `Under ${line}`, line, 1 - pOver, mt?.probs[1], mt ? o.under : null, wt),
    );
  } else {
    pred = bbPredict(state, ev);
    const mk = o.home && o.away ? devig([o.home, o.away]) : null;
    markets.push(
      opt('basketball:ml', 'home', ev.home.short || ev.home.name, null, pred.home, mk?.probs[0], o.home, B['basketball:ml']),
      opt('basketball:ml', 'away', ev.away.short || ev.away.name, null, pred.away, mk?.probs[1], o.away, B['basketball:ml']),
    );
    if (pred.coverHome != null) {
      const ms = o.spreadHomeOdd && o.spreadAwayOdd ? devig([o.spreadHomeOdd, o.spreadAwayOdd]) : null;
      const l = o.spreadHome;
      markets.push(
        opt('basketball:spread', 'home', `${ev.home.abbr || ev.home.short} ${l > 0 ? '+' : ''}${l}`, l, pred.coverHome, ms?.probs[0], o.spreadHomeOdd, B['basketball:spread']),
        opt('basketball:spread', 'away', `${ev.away.abbr || ev.away.short} ${-l > 0 ? '+' : ''}${-l}`, -l, 1 - pred.coverHome, ms?.probs[1], o.spreadAwayOdd, B['basketball:spread']),
      );
    }
    if (pred.overLine != null) {
      const mt = o.over && o.under ? devig([o.over, o.under]) : null;
      markets.push(
        opt('basketball:total', 'over', `Over ${o.totalLine}`, o.totalLine, pred.overLine, mt?.probs[0], o.over, B['basketball:total']),
        opt('basketball:total', 'under', `Under ${o.totalLine}`, o.totalLine, 1 - pred.overLine, mt?.probs[1], o.under, B['basketball:total']),
      );
    }
  }
  return { pred, markets };
}

export function qualifies(state, m) {
  const S = DEFAULTS.signal;
  return m.odd && m.pMarket != null && m.ev >= state.learned.minEV[m.marketKey] && m.p >= S.minProb && m.odd >= S.minOdd && m.odd <= S.maxOdd;
}

function stakeFor(m) {
  const S = DEFAULTS.signal;
  const k = (m.p * m.odd - 1) / (m.odd - 1);
  return +clamp(k * S.kellyFraction * 100, 0.25, S.maxStake).toFixed(2);
}

function confidence(state, m, sample) {
  const edge = m.ev - state.learned.minEV[m.marketKey];
  const agree = 1 - Math.min(1, Math.abs(m.pModel - m.pMarket) * 4); // concordância parcial com o mercado reduz risco de erro de modelo
  const exp = Math.min(1, sample / 12);
  const score = clamp(28 + Math.min(22, edge * 250) + agree * 20 + exp * 18 + Math.min(10, m.p * 15), 5, 95);
  return Math.round(score);
}

export function bestSignals(state, ev, an) {
  const out = [];
  const byKey = {};
  for (const m of an.markets) if (qualifies(state, m)) if (!byKey[m.marketKey] || m.ev > byKey[m.marketKey].ev) byKey[m.marketKey] = m;
  for (const m of Object.values(byKey)) out.push({ ...m, stake: stakeFor(m), confidence: confidence(state, m, an.pred.sample) });
  return out.sort((a, b) => b.ev - a.ev).slice(0, 2);
}

// ---------- resultado de cada opção ----------
export function outcome(ev, m) {
  const gh = ev.home.score, ga = ev.away.score;
  if (gh == null || ga == null) return null;
  if (m.marketKey === 'soccer:1x2' || m.marketKey === 'basketball:ml') {
    const r = gh > ga ? 'home' : gh < ga ? 'away' : 'draw';
    return r === m.side ? 1 : 0;
  }
  if (m.marketKey.endsWith(':ou') || m.marketKey === 'basketball:total') {
    const t = gh + ga;
    if (t === m.line) return 0.5;
    return (t > m.line) === (m.side === 'over') ? 1 : 0;
  }
  if (m.marketKey === 'basketball:spread') {
    const diff = (m.side === 'home' ? gh - ga : ga - gh) + m.line;
    if (diff === 0) return 0.5;
    return diff > 0 ? 1 : 0;
  }
  return null;
}

// ---------- aprendizado com resultado ----------
const ll = (p) => -Math.log(clamp(p, 1e-4, 1));

function learnBlend(state, ev, an) {
  const groups = {};
  for (const m of an.markets) (groups[m.marketKey] ??= []).push(m);
  const changes = [];
  for (const [key, ms] of Object.entries(groups)) {
    if (ms.some((m) => m.pMarket == null)) continue;
    const res = ms.map((m) => outcome(ev, m));
    if (res.some((r) => r === 0.5 || r == null)) continue;
    const win = ms[res.indexOf(1)];
    if (!win) continue;
    const w = state.learned.blend[key];
    const pB = w * win.pModel + (1 - w) * win.pMarket;
    const grad = -(win.pModel - win.pMarket) / clamp(pB, 0.02, 1);
    const nw = clamp(w - 0.01 * grad, 0.05, 0.85);
    state.learned.blend[key] = nw;
    const st = (state.stats[key] ??= { n: 0, llModel: 0, llMarket: 0, llBlend: 0, emaModel: null, emaMarket: null });
    st.n++; st.llModel += ll(win.pModel); st.llMarket += ll(win.pMarket); st.llBlend += ll(pB);
    const a = 0.03;
    st.emaModel = st.emaModel == null ? ll(win.pModel) : (1 - a) * st.emaModel + a * ll(win.pModel);
    st.emaMarket = st.emaMarket == null ? ll(win.pMarket) : (1 - a) * st.emaMarket + a * ll(win.pMarket);
    changes.push({ key, from: w, to: nw });
  }
  return changes;
}

function learnCalib(state, ev, an) {
  const c = (state.calib[ev.sport] ??= Array.from({ length: 10 }, () => ({ n: 0, hits: 0, sumP: 0 })));
  for (const m of an.markets) {
    const r = outcome(ev, m);
    if (r == null || r === 0.5) continue;
    const b = Math.min(9, Math.floor(m.pModel * 10));
    c[b].n++; c[b].hits += r; c[b].sumP += m.pModel;
  }
}

export function settleSignal(sig, ev) {
  const r = outcome(ev, sig);
  if (r == null) return;
  sig.result = `${ev.home.score}-${ev.away.score}`;
  sig.settledAt = new Date().toISOString();
  if (r === 0.5) { sig.status = 'void'; sig.profit = 0; }
  else if (r === 1) { sig.status = 'green'; sig.profit = +(sig.stake * (sig.odd - 1)).toFixed(3); }
  else { sig.status = 'red'; sig.profit = -sig.stake; }
}

// processa um jogo encerrado: avalia, aprende e atualiza ratings
export function learnFromResult(ctx, ev, { backtest = false } = {}) {
  const { state } = ctx;
  if (state.processed[ev.id]) return null;
  // jogos encerrados perdem as odds no placar da ESPN: usa as odds pré-jogo memorizadas
  if (!ev.odds && state.oddsMemo?.[ev.id]) ev = { ...ev, odds: state.oddsMemo[ev.id] };
  const an = analyze(state, ev);
  let blendChanges = [];
  if (ev.odds) blendChanges = learnBlend(state, ev, an);
  learnCalib(state, ev, an);

  if (backtest) {
    for (const s of bestSignals(state, ev, an)) {
      const sig = baseSignal(ev, s, true);
      settleSignal(sig, ev);
      ctx.backtest.push(sig);
    }
  }
  for (const sig of ctx.signals) if (sig.eventId === ev.id && ['aberto', 'travado'].includes(sig.status)) settleSignal(sig, ev);

  // surpresa = probabilidade do modelo para o que aconteceu
  const res = ev.home.score > ev.away.score ? 'home' : ev.home.score < ev.away.score ? 'away' : 'draw';
  const pRes = res === 'home' ? an.pred.home : res === 'away' ? an.pred.away : an.pred.draw;
  const before = ev.sport === 'soccer'
    ? { h: { ...state.soccerTeams[ev.home.id] }, a: { ...state.soccerTeams[ev.away.id] } }
    : { h: { ...state.bbTeams[ev.home.id] }, a: { ...state.bbTeams[ev.away.id] } };
  const err = ev.sport === 'soccer' ? soccerUpdate(state, ev) : bbUpdate(state, ev);
  state.processed[ev.id] = ev.date;
  state.totalLearned = (state.totalLearned || 0) + 1;
  return { ev, an, pRes, res, err, blendChanges, before };
}

export function baseSignal(ev, s, backtest = false) {
  const now = new Date().toISOString();
  return {
    id: `${ev.id}:${s.marketKey}`,
    eventId: ev.id, sport: ev.sport, league: ev.league, leagueName: ev.leagueName, date: ev.date,
    home: ev.home.name, away: ev.away.name, homeLogo: ev.home.logo, awayLogo: ev.away.logo,
    marketKey: s.marketKey, market: s.market, side: s.side, label: s.label, line: s.line,
    odd: s.odd, p: +s.p.toFixed(4), pModel: +s.pModel.toFixed(4), pMarket: +s.pMarket.toFixed(4),
    ev: +s.ev.toFixed(4), stake: s.stake, confidence: s.confidence,
    provider: ev.odds?.provider || null,
    status: backtest ? 'travado' : 'aberto', backtest,
    createdAt: backtest ? ev.date : now, updatedAt: now,
  };
}

export function snapshot(ev, an, signals) {
  const r4 = (x) => (x == null ? null : +x.toFixed(4));
  return {
    pred: Object.fromEntries(Object.entries(an.pred).map(([k, v]) => [k, typeof v === 'number' ? r4(v) : v])),
    markets: an.markets.map((m) => ({ ...m, pModel: r4(m.pModel), pMarket: r4(m.pMarket), p: r4(m.p), fair: r4(m.fair), ev: r4(m.ev) })),
    signals: signals.map((s) => s.id),
    at: new Date().toISOString(),
  };
}

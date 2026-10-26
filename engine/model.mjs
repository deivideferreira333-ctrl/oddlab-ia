// Modelos estatísticos que aprendem online:
// - futebol: Poisson bivariado com correção Dixon-Coles
// - basquete: rating de margem e de ritmo (total) com distribuição normal + efeito de back-to-back
// - hóquei: Poisson do tempo normal + prorrogação/shootout (empate no tempo normal = +1 gol no total) + back-to-back
import { PRIORS } from './config.mjs';

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// probabilidades justas do mercado (remove a margem da casa proporcionalmente)
export function devig(odds) {
  const inv = odds.map((o) => (o && o > 1 ? 1 / o : 0));
  const s = inv.reduce((a, b) => a + b, 0);
  if (!s || inv.some((x) => !x)) return null;
  return { probs: inv.map((x) => x / s), margin: s - 1 };
}

function poisson(k, l) {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
}

// horas desde o último jogo do time (back-to-back < 36 h)
const restHours = (t, date) => (t?.last ? (Date.parse(date) - Date.parse(t.last)) / 36e5 : 999);
const isB2B = (t, date) => { const h = restHours(t, date); return h > 0 && h < 36 ? 1 : 0; };

// ---------------- FUTEBOL ----------------
function leagueS(state, lg) {
  if (!state.soccerLeagues[lg]) {
    const p = PRIORS[lg] || { total: 2.6, home: 0.56 };
    state.soccerLeagues[lg] = { lgH: Math.log(p.total * p.home), lgA: Math.log(p.total * (1 - p.home)), n: 0, goals: 0, homeWins: 0, draws: 0, over15: 0, over25: 0, over35: 0, btts: 0 };
  }
  return state.soccerLeagues[lg];
}
function teamS(state, id, name) {
  state.soccerTeams[id] ??= { att: 0, def: 0, n: 0, name, last: null, form: [] };
  if (name) state.soccerTeams[id].name = name;
  return state.soccerTeams[id];
}

export const SOCCER_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];

export function soccerPredict(state, ev, rho) {
  const L = leagueS(state, ev.league);
  const h = teamS(state, ev.home.id, ev.home.name);
  const a = teamS(state, ev.away.id, ev.away.name);
  const homeAdv = ev.neutral ? (L.lgH - L.lgA) / 2 : 0;
  const lh = Math.exp(L.lgH - homeAdv + h.att + a.def);
  const la = Math.exp(L.lgA + homeAdv + a.att + h.def);
  const N = 11;
  let pH = 0, pD = 0, pA = 0, btts = 0;
  const over = Object.fromEntries(SOCCER_LINES.map((l) => [l, 0]));
  const top = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let p = poisson(i, lh) * poisson(j, la);
      if (i === 0 && j === 0) p *= 1 - lh * la * rho;
      else if (i === 0 && j === 1) p *= 1 + lh * rho;
      else if (i === 1 && j === 0) p *= 1 + la * rho;
      else if (i === 1 && j === 1) p *= 1 - rho;
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
      for (const l of SOCCER_LINES) if (i + j > l) over[l] += p;
      if (i > 0 && j > 0) btts += p;
      top.push([i, j, p]);
    }
  }
  const s = pH + pD + pA;
  top.sort((x, y) => y[2] - x[2]);
  return {
    xgHome: lh, xgAway: la, total: lh + la,
    home: pH / s, draw: pD / s, away: pA / s,
    over: Object.fromEntries(Object.entries(over).map(([k, v]) => [k, v / s])),
    btts: btts / s,
    scores: top.slice(0, 5).map(([i, j, p]) => ({ score: `${i}-${j}`, p: p / s })),
    sample: Math.min(h.n, a.n),
  };
}

export function soccerUpdate(state, ev) {
  const L = leagueS(state, ev.league);
  const h = teamS(state, ev.home.id, ev.home.name);
  const a = teamS(state, ev.away.id, ev.away.name);
  // regressão à média após pausa longa (nova temporada)
  for (const t of [h, a]) if (t.last && (Date.parse(ev.date) - Date.parse(t.last)) / 864e5 > 75) { t.att *= 0.7; t.def *= 0.7; }
  const homeAdv = ev.neutral ? (L.lgH - L.lgA) / 2 : 0;
  const lh = Math.exp(L.lgH - homeAdv + h.att + a.def);
  const la = Math.exp(L.lgA + homeAdv + a.att + h.def);
  const gh = ev.home.score, ga = ev.away.score;
  const lrT = (n) => Math.max(0.035, 0.22 / Math.sqrt(n + 1));
  const eh = gh - lh, ea = ga - la;
  h.att += lrT(h.n) * eh * 0.5; a.def += lrT(a.n) * eh * 0.5;
  a.att += lrT(a.n) * ea * 0.5; h.def += lrT(h.n) * ea * 0.5;
  for (const t of [h, a]) {
    t.att = clamp(t.att * 0.998, -1.2, 1.2); t.def = clamp(t.def * 0.998, -1.2, 1.2); t.n++; t.last = ev.date;
    if (!/uefa|conmebol/.test(ev.league)) t.lg = ev.league;
  }
  if (!ev.neutral) { L.lgH += 0.012 * eh; L.lgA += 0.012 * ea; }
  const tot = gh + ga;
  L.n++; L.goals += tot; if (gh > ga) L.homeWins++; if (gh === ga) L.draws++;
  if (tot > 1.5) L.over15 = (L.over15 || 0) + 1; if (tot > 2.5) L.over25++; if (tot > 3.5) L.over35 = (L.over35 || 0) + 1; if (gh > 0 && ga > 0) L.btts = (L.btts || 0) + 1;
  const r = gh > ga ? 'W' : gh === ga ? 'D' : 'L';
  h.form = [...h.form, r].slice(-5);
  a.form = [...a.form, r === 'W' ? 'L' : r === 'L' ? 'W' : 'D'].slice(-5);
  h.tot = [...(h.tot || []), tot].slice(-10);
  a.tot = [...(a.tot || []), tot].slice(-10);
  return { errHome: eh, errAway: ea };
}

// ---------------- BASQUETE ----------------
function leagueB(state, lg) {
  if (!state.bbLeagues[lg]) {
    const p = PRIORS[lg] || { total: 220, hca: 2.3, sigM: 12.5, sigT: 18 };
    state.bbLeagues[lg] = { hca: p.hca, avgTotal: p.total, sigM: p.sigM, sigT: p.sigT, b2bT: 0, b2bM: 0, n: 0, sumTot: 0 };
  }
  const L = state.bbLeagues[lg];
  L.b2bT ??= 0; L.b2bM ??= 0;
  // prior: o elenco repõe a maior parte dos pontos do ausente (~12% do que ele fazia some do total)
  if (L.injV !== 2) { L.injT = -0.12; L.injM = 0.12; L.injV = 2; }
  return L;
}
function teamB(state, id, name) {
  state.bbTeams[id] ??= { r: 0, t: 0, n: 0, name, last: null, form: [] };
  if (name) state.bbTeams[id].name = name;
  return state.bbTeams[id];
}

export function bbPredict(state, ev) {
  const L = leagueB(state, ev.league);
  const h = teamB(state, ev.home.id, ev.home.name);
  const a = teamB(state, ev.away.id, ev.away.name);
  const hb = isB2B(h, ev.date), ab = isB2B(a, ev.date);
  // desfalques: pontos por jogo ausentes (ponderados por status e por quanto o rating já absorveu a ausência)
  const mh = ev.feat?.miss?.home || 0, ma = ev.feat?.miss?.away || 0;
  const margin = h.r - a.r + (ev.neutral ? 0 : L.hca) - L.b2bM * (hb - ab) - L.injM * (mh - ma);
  const injAdj = clamp(L.injT * (mh + ma), -12, 6);
  const total = L.avgTotal + h.t + a.t + L.b2bT * (hb + ab) + injAdj;
  const out = {
    margin, total, sigM: L.sigM, sigT: L.sigT, b2bHome: hb, b2bAway: ab, missHome: mh, missAway: ma, injTotal: injAdj,
    home: normCdf(margin / L.sigM), away: 1 - normCdf(margin / L.sigM),
    ptsHome: (total + margin) / 2, ptsAway: (total - margin) / 2,
    sample: Math.min(h.n, a.n),
  };
  if (ev.odds?.spreadHome != null) out.coverHome = normCdf((margin + ev.odds.spreadHome) / L.sigM);
  if (ev.odds?.totalLine != null) out.overLine = 1 - normCdf((ev.odds.totalLine - total) / L.sigT);
  return out;
}

export function bbUpdate(state, ev) {
  const L = leagueB(state, ev.league);
  const h = teamB(state, ev.home.id, ev.home.name);
  const a = teamB(state, ev.away.id, ev.away.name);
  for (const t of [h, a]) if (t.last && (Date.parse(ev.date) - Date.parse(t.last)) / 864e5 > 60) { t.r *= 0.65; t.t *= 0.5; }
  const pred = bbPredict(state, ev);
  const hb = pred.b2bHome, ab = pred.b2bAway;
  const m = ev.home.score - ev.away.score;
  const tot = ev.home.score + ev.away.score;
  const em = clamp(m - pred.margin, -30, 30), et = clamp(tot - pred.total, -45, 45);
  const k = (n) => Math.max(0.06, 0.3 / Math.sqrt(n + 1));
  h.r += k(h.n) * em / 2; a.r -= k(a.n) * em / 2;
  h.t += k(h.n) * et / 2 * 0.6; a.t += k(a.n) * et / 2 * 0.6;
  if (!ev.neutral) L.hca += 0.01 * em;
  L.avgTotal += 0.01 * et;
  if (hb || ab) { L.b2bT = clamp(L.b2bT + 0.02 * et * (hb + ab), -8, 8); L.b2bM = clamp(L.b2bM - 0.02 * em * (hb - ab), -6, 6); }
  const mh = pred.missHome, ma = pred.missAway;
  if (mh || ma) { L.injT = clamp(L.injT + 0.0003 * et * (mh + ma), -0.5, 0.2); L.injM = clamp(L.injM - 0.0003 * em * (mh - ma), -0.1, 0.4); L.injN = (L.injN || 0) + 1; }
  L.sigM = Math.sqrt(0.985 * L.sigM ** 2 + 0.015 * em ** 2);
  L.sigT = Math.sqrt(0.985 * L.sigT ** 2 + 0.015 * et ** 2);
  L.n++; L.sumTot = (L.sumTot || 0) + tot;
  for (const t of [h, a]) { t.n++; t.last = ev.date; t.lg = ev.league; t.dates = [...(t.dates || []), ev.date].slice(-30); }
  h.form = [...h.form, m > 0 ? 'W' : 'L'].slice(-5);
  a.form = [...a.form, m < 0 ? 'W' : 'L'].slice(-5);
  h.tot = [...(h.tot || []), tot].slice(-10);
  a.tot = [...(a.tot || []), tot].slice(-10);
  return { errMargin: em, errTotal: et };
}

// ---------------- HÓQUEI ----------------
function leagueH(state, lg) {
  state.hkLeagues ??= {};
  if (!state.hkLeagues[lg]) {
    const p = PRIORS[lg] || { total: 6.1, home: 0.52 };
    const reg = p.total - 0.23; // ~23% dos jogos vão à prorrogação e somam 1 gol
    state.hkLeagues[lg] = { lgH: Math.log(reg * p.home), lgA: Math.log(reg * (1 - p.home)), b2b: 0, otHome: 0.52, n: 0, goals: 0, ot: 0, over55: 0, over65: 0 };
  }
  const L = state.hkLeagues[lg];
  L.gk ??= 0.08; L.svAvg ??= 0.9; // prior: cada 1 p.p. de SV% do goleiro muda ~8% os gols sofridos
  return L;
}
function teamH(state, id, name) {
  state.hkTeams ??= {};
  state.hkTeams[id] ??= { att: 0, def: 0, n: 0, name, last: null, form: [] };
  if (name) state.hkTeams[id].name = name;
  return state.hkTeams[id];
}
export const HOCKEY_LINES = [4.5, 5.5, 6.5, 7.5, 8.5];

function hkLambdas(state, ev) {
  const L = leagueH(state, ev.league);
  const h = teamH(state, ev.home.id, ev.home.name);
  const a = teamH(state, ev.away.id, ev.away.name);
  const hb = isB2B(h, ev.date), ab = isB2B(a, ev.date);
  // time em back-to-back costuma sofrer mais (goleiro reserva, pernas cansadas): efeito aprendido em L.b2b
  // goleiro titular: x > 0 quando o goleiro defende pior que a média da liga
  const gx = (g) => (g?.sv ? clamp((L.svAvg - g.sv) * 100, -3, 3) : 0);
  const xh = gx(ev.feat?.gk?.home), xa = gx(ev.feat?.gk?.away);
  const lh = Math.exp(L.lgH + h.att + a.def + L.b2b * ab + L.gk * xa);
  const la = Math.exp(L.lgA + a.att + h.def + L.b2b * hb + L.gk * xh);
  return { L, h, a, lh, la, hb, ab, xh, xa };
}

export function hockeyPredict(state, ev) {
  const { L, h, a, lh, la, hb, ab, xh, xa } = hkLambdas(state, ev);
  const N = 13;
  let pH = 0, pT = 0, pA = 0;
  const dist = new Array(2 * N + 2).fill(0); // distribuição do total final
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const p = poisson(i, lh) * poisson(j, la);
    if (i > j) pH += p; else if (i < j) pA += p; else pT += p;
    dist[i === j ? 2 * i + 1 : i + j] += p;
  }
  const s = pH + pT + pA;
  const overAt = (l) => dist.reduce((acc, p, t) => acc + (t > l ? p : 0), 0) / s;
  const over = Object.fromEntries(HOCKEY_LINES.map((l) => [l, overAt(l)]));
  const out = {
    xgHome: lh, xgAway: la, total: lh + la + pT / s,
    home: (pH + pT * L.otHome) / s, away: (pA + pT * (1 - L.otHome)) / s,
    regDraw: pT / s, over, b2bHome: hb, b2bAway: ab, gkHome: ev.feat?.gk?.home || null, gkAway: ev.feat?.gk?.away || null, gkEffect: L.gk * (xh + xa),
    sample: Math.min(h.n, a.n),
  };
  if (ev.odds?.totalLine != null) out.overLine = overAt(ev.odds.totalLine);
  return out;
}

export function hockeyUpdate(state, ev) {
  const { L, h, a, lh, la, hb, ab, xh, xa } = hkLambdas(state, ev);
  for (const t of [h, a]) if (t.last && (Date.parse(ev.date) - Date.parse(t.last)) / 864e5 > 75) { t.att *= 0.7; t.def *= 0.7; }
  let gh = ev.home.score, ga = ev.away.score;
  const ot = /OT|SO/i.test(ev.detail || '') || (ev.period || 0) > 3;
  if (ot) { if (gh > ga) gh--; else ga--; L.otHome += 0.01 * ((ev.home.score > ev.away.score ? 1 : 0) - L.otHome); }
  const eh = gh - lh, ea = ga - la;
  const lrT = (n) => Math.max(0.03, 0.2 / Math.sqrt(n + 1));
  h.att += lrT(h.n) * eh * 0.5; a.def += lrT(a.n) * eh * 0.5;
  a.att += lrT(a.n) * ea * 0.5; h.def += lrT(h.n) * ea * 0.5;
  L.lgH += 0.01 * eh; L.lgA += 0.01 * ea;
  if (hb) L.b2b = clamp(L.b2b + 0.004 * ea, -0.3, 0.3);
  if (ab) L.b2b = clamp(L.b2b + 0.004 * eh, -0.3, 0.3);
  if (xh || xa) { L.gk = clamp(L.gk + 0.003 * (ea * xh + eh * xa), 0, 0.25); L.gkN = (L.gkN || 0) + 1; }
  for (const g of [ev.feat?.gk?.home, ev.feat?.gk?.away]) if (g?.sv) L.svAvg = 0.99 * L.svAvg + 0.01 * g.sv;
  const tot = ev.home.score + ev.away.score;
  L.n++; L.goals += tot; if (ot) L.ot++; if (tot > 5.5) L.over55++; if (tot > 6.5) L.over65++;
  for (const t of [h, a]) { t.att = clamp(t.att * 0.998, -1, 1); t.def = clamp(t.def * 0.998, -1, 1); t.n++; t.last = ev.date; t.lg = ev.league; }
  const w = ev.home.score > ev.away.score;
  h.form = [...h.form, w ? 'W' : 'L'].slice(-5);
  a.form = [...a.form, w ? 'L' : 'W'].slice(-5);
  h.tot = [...(h.tot || []), tot].slice(-10);
  a.tot = [...(a.tot || []), tot].slice(-10);
  return { errHome: eh, errAway: ea, ot };
}

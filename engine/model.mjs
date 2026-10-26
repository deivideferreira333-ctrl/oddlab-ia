// Modelos estatísticos: Poisson bivariado com correção Dixon-Coles (futebol) e
// rating de margem/total com distribuição normal (basquete). Ambos aprendem online.

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

// ---------------- FUTEBOL ----------------
function leagueS(state, lg) {
  state.soccerLeagues[lg] ??= { lgH: Math.log(1.45), lgA: Math.log(1.12), n: 0, goals: 0, homeWins: 0, draws: 0, over25: 0 };
  return state.soccerLeagues[lg];
}
function teamS(state, id, name) {
  state.soccerTeams[id] ??= { att: 0, def: 0, n: 0, name, last: null, form: [] };
  if (name) state.soccerTeams[id].name = name;
  return state.soccerTeams[id];
}

function poisson(k, l) {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
}

export function soccerPredict(state, ev, rho) {
  const L = leagueS(state, ev.league);
  const h = teamS(state, ev.home.id, ev.home.name);
  const a = teamS(state, ev.away.id, ev.away.name);
  const homeAdv = ev.neutral ? (L.lgH - L.lgA) / 2 : 0;
  const lh = Math.exp(L.lgH - homeAdv + h.att + a.def);
  const la = Math.exp(L.lgA + homeAdv + a.att + h.def);
  const N = 11;
  let pH = 0, pD = 0, pA = 0, over = {}, btts = 0;
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
  for (const l of lines) over[l] = 0;
  const grid = [];
  let top = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let p = poisson(i, lh) * poisson(j, la);
      if (i === 0 && j === 0) p *= 1 - lh * la * rho;
      else if (i === 0 && j === 1) p *= 1 + lh * rho;
      else if (i === 1 && j === 0) p *= 1 + la * rho;
      else if (i === 1 && j === 1) p *= 1 - rho;
      if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
      for (const l of lines) if (i + j > l) over[l] += p;
      if (i > 0 && j > 0) btts += p;
      top.push([i, j, p]);
    }
  }
  const s = pH + pD + pA;
  top.sort((x, y) => y[2] - x[2]);
  const conf = Math.min(h.n, a.n);
  return {
    xgHome: lh, xgAway: la,
    home: pH / s, draw: pD / s, away: pA / s,
    over: Object.fromEntries(Object.entries(over).map(([k, v]) => [k, v / s])),
    btts: btts / s,
    scores: top.slice(0, 5).map(([i, j, p]) => ({ score: `${i}-${j}`, p: p / s })),
    sample: conf,
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
  for (const t of [h, a]) { t.att = clamp(t.att * 0.998, -1.2, 1.2); t.def = clamp(t.def * 0.998, -1.2, 1.2); t.n++; t.last = ev.date; if (!/uefa|conmebol/.test(ev.league)) t.lg = ev.league; }
  if (!ev.neutral) { L.lgH += 0.012 * eh; L.lgA += 0.012 * ea; }
  L.n++; L.goals += gh + ga; if (gh > ga) L.homeWins++; if (gh === ga) L.draws++; if (gh + ga > 2.5) L.over25++;
  const r = gh > ga ? 'W' : gh === ga ? 'D' : 'L';
  h.form = [...h.form, r].slice(-5);
  a.form = [...a.form, r === 'W' ? 'L' : r === 'L' ? 'W' : 'D'].slice(-5);
  return { errHome: eh, errAway: ea };
}

// ---------------- BASQUETE ----------------
function leagueB(state, lg) {
  state.bbLeagues[lg] ??= { hca: 2.5, avgTotal: lg === 'wnba' ? 162 : 226, sigM: 12.5, sigT: 18, n: 0 };
  return state.bbLeagues[lg];
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
  const margin = h.r - a.r + (ev.neutral ? 0 : L.hca);
  const total = L.avgTotal + h.t + a.t;
  const out = {
    margin, total, sigM: L.sigM, sigT: L.sigT,
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
  const m = ev.home.score - ev.away.score;
  const tot = ev.home.score + ev.away.score;
  const em = clamp(m - pred.margin, -30, 30), et = clamp(tot - pred.total, -45, 45);
  const k = (n) => Math.max(0.06, 0.3 / Math.sqrt(n + 1));
  h.r += k(h.n) * em / 2; a.r -= k(a.n) * em / 2;
  h.t += k(h.n) * et / 2 * 0.6; a.t += k(a.n) * et / 2 * 0.6;
  if (!ev.neutral) L.hca += 0.01 * em;
  L.avgTotal += 0.01 * et;
  L.sigM = Math.sqrt(0.985 * L.sigM ** 2 + 0.015 * em ** 2);
  L.sigT = Math.sqrt(0.985 * L.sigT ** 2 + 0.015 * et ** 2);
  L.n++;
  for (const t of [h, a]) { t.n++; t.last = ev.date; t.lg = ev.league; }
  h.form = [...h.form, m > 0 ? 'W' : 'L'].slice(-5);
  a.form = [...a.form, m < 0 ? 'W' : 'L'].slice(-5);
  return { errMargin: em, errTotal: et };
}

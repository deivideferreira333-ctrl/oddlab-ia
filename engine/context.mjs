// Contexto pré-jogo que mexe no total: desfalques do basquete e goleiro titular do hóquei.
// Fontes: lista de lesionados da ESPN, ficha de cada jogador (médias da temporada) e goleiro provável do placar.
import { pool, source } from './espn.mjs';
import { loadHistory } from './history.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';
const DAY = 864e5;
const STATUS_W = { 'Out': 1, 'Doubtful': 0.75, 'Questionable': 0.4, 'Day-To-Day': 0.35, 'Probable': 0.1 };

async function get(url) {
  if (source.blocked) return null;
  try {
    source.requests++;
    const r = await fetch(url, { headers: { 'user-agent': 'OddLab-IA/1.0 (+github.com/oddlab-ia)' } });
    if (r.status === 403 || r.status === 429) { source.blocked = true; return null; }
    if (!r.ok) return null;
    await new Promise((res) => setTimeout(res, 200));
    return await r.json();
  } catch { return null; }
}

// médias da temporada mais recente na ficha do jogador
async function playerStats(state, sport, league, id) {
  state.players ??= {};
  const c = state.players[id];
  if (c && Date.now() - Date.parse(c.at) < (sport === 'hockey' ? 1 : 5) * DAY) return c;
  const j = await get(`${WEB}/${sport}/${league}/athletes/${id}/overview`);
  const s = j?.statistics;
  if (!s?.names) return c || null;
  const split = (n) => s.splits?.find((x) => x.displayName === n);
  const val = (sp, k) => { const i = s.names.indexOf(k); return sp && i >= 0 ? parseFloat(sp.stats[i]) : null; };
  const season = split('Regular Season'), career = split('Career');
  const out = { at: new Date().toISOString() };
  if (sport === 'hockey') {
    Object.assign(out, { saves: val(season, 'saves') || 0, shots: val(season, 'shotsAgainst') || 0, cSaves: val(career, 'saves') || 0, cShots: val(career, 'shotsAgainst') || 0, gp: val(season, 'games') || 0 });
  } else {
    Object.assign(out, { pts: val(season, 'avgPoints') || 0, min: val(season, 'avgMinutes') || 0, gp: val(season, 'gamesPlayed') || 0 });
  }
  state.players[id] = out;
  return out;
}

// SV% ajustado: temporada encolhida para a carreira, carreira encolhida para a média da liga
export function goalieSv(st, leagueSv = 0.9) {
  if (!st) return null;
  const career = (st.cSaves + leagueSv * 1500) / (st.cShots + 1500);
  return (st.saves + career * 800) / (st.shots + 800);
}

export async function gatherContext(state, events, log = () => {}) {
  const soon = events.filter((e) => e.state === 'pre' && Date.parse(e.date) - Date.now() < 2 * DAY);
  const feats = {};

  // ---- basquete: desfalques ----
  const bbLeagues = [...new Set(soon.filter((e) => e.sport === 'basketball').map((e) => e.league))];
  for (const lg of bbLeagues) {
    const j = await get(`${SITE}/basketball/${lg}/injuries`);
    if (!j?.injuries) continue;
    const byTeam = Object.fromEntries(j.injuries.map((t) => [String(t.id), t.injuries || []]));
    const games = soon.filter((e) => e.league === lg);
    const hist = loadHistory(lg).games;
    // jogos que o time fez depois da data da lesão (memória histórica)
    const playedSince = (teamId, date) => hist.filter((g) => (g[2] === teamId || g[4] === teamId) && g[1] > (date || '')).length;
    const need = [];
    for (const ev of games) for (const side of ['home', 'away']) for (const i of byTeam[String(ev[side].id)] || []) if (STATUS_W[i.status] && i.athlete) need.push(i);
    await pool([...new Map(need.map((i) => [i.athlete.links?.[0]?.href?.match(/id\/(\d+)/)?.[1], i])).entries()].filter(([id]) => id)
      .map(([id]) => () => playerStats(state, 'basketball', lg, id)), 3);
    for (const ev of games) {
      const f = { inj: {}, miss: {} };
      for (const side of ['home', 'away']) {
        const list = [];
        for (const i of byTeam[String(ev[side].id)] || []) {
          const id = i.athlete?.links?.[0]?.href?.match(/id\/(\d+)/)?.[1];
          const st = id && state.players?.[id];
          if (!STATUS_W[i.status] || !st?.pts) continue;
          // jogos que o time já fez desde a lesão: depois de ~15, o rating do time já reflete a ausência
          const since = playedSince(ev[side].id, i.date);
          const rec = Math.max(0.15, 1 - since / 15);
          const w = STATUS_W[i.status] * rec;
          list.push({ name: i.athlete.displayName, status: i.status, pts: st.pts, min: st.min, w: +w.toFixed(2) });
        }
        list.sort((a, b) => b.pts * b.w - a.pts * a.w);
        f.inj[side] = list.slice(0, 6);
        f.miss[side] = +list.reduce((a, p) => a + p.pts * p.w, 0).toFixed(1);
      }
      feats[ev.id] = f;
    }
  }

  // ---- hóquei: goleiro titular ----
  const hk = soon.filter((e) => e.sport === 'hockey');
  const gids = hk.flatMap((e) => [e.home.goalie?.id, e.away.goalie?.id]).filter(Boolean);
  await pool([...new Set(gids)].map((id) => () => playerStats(state, 'hockey', 'nhl', id)), 3);
  for (const ev of hk) {
    const L = state.hkLeagues?.[ev.league];
    const f = { gk: {} };
    for (const side of ['home', 'away']) {
      const g = ev[side].goalie;
      if (!g) continue;
      const sv = goalieSv(state.players?.[g.id], L?.svAvg ?? 0.9);
      f.gk[side] = { id: g.id, name: g.name, status: g.status, sv: sv == null ? null : +sv.toFixed(4) };
    }
    if (Object.keys(f.gk).length) feats[ev.id] = f;
  }
  log(`[contexto] desfalques em ${Object.values(feats).filter((f) => f.inj).length} jogos de basquete, goleiros em ${Object.values(feats).filter((f) => f.gk).length} jogos de hóquei`);
  return feats;
}

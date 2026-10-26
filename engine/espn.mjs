// Coleta e normalização dos dados da API pública da ESPN
const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

export const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

export function americanToDecimal(v) {
  if (v === undefined || v === null || v === '' || v === 'EVEN' || v === 'OFF') return v === 'EVEN' ? 2 : null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace('+', ''));
  if (!isFinite(n) || n === 0) return null;
  return +(n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n)).toFixed(3);
}

const pick = (o) => o?.close?.odds ?? o?.open?.odds;
const pickOpen = (o) => o?.open?.odds;
const lineOf = (o) => {
  const l = o?.close?.line ?? o?.open?.line;
  if (l === undefined || l === null) return null;
  const n = parseFloat(String(l).replace(/^[ou]/i, ''));
  return isFinite(n) ? n : null;
};

function parseOdds(comp) {
  const o = comp.odds?.[0];
  if (!o) return null;
  const ml = o.moneyline || {};
  const res = {
    provider: o.provider?.displayName || o.provider?.name || 'Mercado',
    home: americanToDecimal(pick(ml.home)),
    away: americanToDecimal(pick(ml.away)),
    draw: americanToDecimal(pick(ml.draw)) ?? americanToDecimal(o.drawOdds?.moneyLine),
    homeOpen: americanToDecimal(pickOpen(ml.home)),
    awayOpen: americanToDecimal(pickOpen(ml.away)),
    totalLine: lineOf(o.total?.over) ?? (isFinite(o.overUnder) ? o.overUnder : null),
    over: americanToDecimal(pick(o.total?.over)),
    under: americanToDecimal(pick(o.total?.under)),
    spreadHome: lineOf(o.pointSpread?.home) ?? (isFinite(o.spread) ? o.spread : null),
    spreadHomeOdd: americanToDecimal(pick(o.pointSpread?.home)),
    spreadAwayOdd: americanToDecimal(pick(o.pointSpread?.away)),
    details: o.details || null,
  };
  if (res.over == null && res.totalLine != null) { res.over = 1.91; res.under = 1.91; res.totalAssumed = true; }
  if (!res.home && !res.over && !res.spreadHomeOdd) return null;
  return res;
}

function team(c) {
  const rec = c.records?.find((r) => r.type === 'total' || r.name === 'overall') || c.records?.[0];
  return {
    id: c.team?.id,
    name: c.team?.displayName || c.team?.name,
    short: c.team?.shortDisplayName || c.team?.abbreviation,
    abbr: c.team?.abbreviation,
    logo: c.team?.logo || null,
    color: c.team?.color ? '#' + c.team.color : null,
    score: c.score !== undefined && c.score !== '' ? Number(c.score) : null,
    form: c.form || null,
    record: rec?.summary || null,
    goalie: (() => { const g = c.probables?.find((p) => p.name === 'probableStartingGoalie'); return g?.athlete ? { id: g.athlete.id, name: g.athlete.displayName, status: g.status?.name || '' } : null; })(),
  };
}

export function normalizeEvent(ev, league) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === 'home');
  const away = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const st = comp.status?.type || ev.status?.type || {};
  return {
    id: `${league.slug}:${ev.id}`,
    espnId: ev.id,
    sport: league.sport,
    league: league.slug,
    leagueName: league.name,
    date: ev.date,
    name: ev.name,
    state: st.state, // pre | in | post
    completed: !!st.completed,
    statusName: st.name,
    detail: st.shortDetail || st.detail || '',
    clock: comp.status?.displayClock || null,
    period: comp.status?.period || null,
    neutral: !!comp.neutralSite,
    venue: comp.venue?.fullName || null,
    home: team(home),
    away: team(away),
    odds: parseOdds(comp),
  };
}

// Coleta educada: poucas requisições, pausa entre elas e parada imediata se a fonte limitar o acesso
export const source = { blocked: false, requests: 0, errors: 0 };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function getJSON(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    if (source.blocked) return null;
    try {
      source.requests++;
      const r = await fetch(url, { headers: { 'user-agent': 'OddLab-IA/1.0 (+github.com/oddlab-ia)' } });
      if (r.ok) { await sleep(250); return await r.json(); }
      if (r.status === 403 || r.status === 429) { source.blocked = true; return null; }
      if (r.status === 400 || r.status === 404) return null;
    } catch {}
    source.errors++;
    await sleep(1500 * (i + 1));
  }
  return null;
}

export async function fetchDay(league, dateStr, strict = false) {
  const url = `${BASE}/${league.sport}/${league.slug}/scoreboard?dates=${dateStr}`;
  const j = await getJSON(url);
  if (!j) return strict ? null : [];
  if (!j.events) return [];
  return j.events.map((e) => normalizeEvent(e, league)).filter(Boolean);
}

// calendário da temporada que contém a data: lista de dias (YYYYMMDD) com jogos
export async function fetchCalendar(league, dateStr) {
  const j = await getJSON(`${BASE}/${league.sport}/${league.slug}/scoreboard?dates=${dateStr}`);
  const cal = j?.leagues?.[0]?.calendar;
  if (!Array.isArray(cal) || !cal.length || typeof cal[0] !== 'string') return null;
  return cal.map((c) => c.slice(0, 10).replace(/-/g, ''));
}

// executa tarefas com concorrência limitada
export async function pool(tasks, n = 10) {
  const out = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const k = i++;
      out[k] = await tasks[k]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

export async function fetchWindow(leagues, days) {
  const tasks = [];
  for (const lg of leagues) for (const d of days) tasks.push(() => fetchDay(lg, d));
  const res = await pool(tasks, 3);
  const map = new Map();
  for (const list of res) for (const e of list || []) map.set(e.id, e);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

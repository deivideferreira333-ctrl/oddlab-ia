// Memória histórica permanente: todos os jogos encerrados de cada liga, guardados em docs/data/history/<liga>.json.
// A coleta é gradual (um lote por ciclo) e cada dia passado é baixado uma única vez.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './brain.mjs';
import { fetchDay, fetchCalendar, pool, ymd, source } from './espn.mjs';

const DIR = path.join(DATA_DIR, 'history');
const file = (slug) => path.join(DIR, `${slug}.json`);
const cache = new Map();

export function loadHistory(slug) {
  if (cache.has(slug)) return cache.get(slug);
  let h;
  try { h = JSON.parse(fs.readFileSync(file(slug), 'utf8')); } catch { h = { slug, days: [], games: [] }; }
  h._days = new Set(h.days);
  h._ids = new Set(h.games.map((g) => g[0]));
  cache.set(slug, h);
  return h;
}

export function saveHistories() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const h of cache.values()) {
    if (!h._dirty) continue;
    h.days = [...h._days].sort();
    h.games.sort((a, b) => a[1].localeCompare(b[1]));
    const { _days, _ids, _dirty, ...out } = h;
    fs.writeFileSync(file(h.slug), JSON.stringify(out));
    h._dirty = false;
  }
}

// formato compacto: [id, data, idCasa, nomeCasa, idFora, nomeFora, golsCasa, golsFora, prorrogação(0/1), neutro(0/1), oddsFechamento|0, contexto|0]
const ODD_KEYS = ['home', 'away', 'draw', 'totalLine', 'over', 'under', 'spreadHome', 'spreadHomeOdd', 'spreadAwayOdd', 'provider'];
export function compactOdds(o) {
  if (!o) return 0;
  const out = {};
  for (const k of ODD_KEYS) if (o[k] != null) out[k] = o[k];
  return Object.keys(out).length ? out : 0;
}
export function compactFeat(f) {
  if (!f) return 0;
  const out = {};
  if (f.miss) out.miss = f.miss;
  if (f.gk) out.gk = Object.fromEntries(Object.entries(f.gk).map(([k, g]) => [k, { sv: g.sv }]));
  return Object.keys(out).length ? out : 0;
}

export function addGame(ev, { odds = null, feat = null } = {}) {
  if (!ev.completed || ev.home.score == null || ev.away.score == null) return false;
  const h = loadHistory(ev.league);
  if (h._ids.has(ev.id)) return false;
  const ot = /OT|SO/i.test(ev.detail || '') || (ev.sport === 'hockey' && (ev.period || 0) > 3) ? 1 : 0;
  h.games.push([ev.id, ev.date, ev.home.id, ev.home.name, ev.away.id, ev.away.name, ev.home.score, ev.away.score, ot, ev.neutral ? 1 : 0, compactOdds(odds), compactFeat(feat)]);
  h._ids.add(ev.id);
  h._dirty = true;
  return true;
}

export function toEvent(g, lg) {
  const [id, date, hid, hname, aid, aname, hs, as, ot, neutral, odds, feat] = g;
  return {
    id, sport: lg.sport, league: lg.slug, leagueName: lg.name, date, completed: true, state: 'post',
    detail: ot ? 'Final/OT' : 'Final', period: ot ? 4 : 3, neutral: !!neutral, odds: odds || null, feat: feat || null,
    home: { id: hid, name: hname, score: hs }, away: { id: aid, name: aname, score: as },
  };
}

// calendário oficial da temporada (dias com jogo), renovado 1x por dia: evita consultar dias vazios
export async function ensureCalendars(leagues) {
  await pool(leagues.map((lg) => async () => {
    const h = loadHistory(lg.slug);
    if (h.cal && Date.now() - Date.parse(h.cal.at) < 864e5) return;
    const a = await fetchCalendar(lg, ymd(new Date(lg.from)));
    const b = await fetchCalendar(lg, ymd(new Date()));
    if (a == null && b == null) return;
    const days = [...new Set([...(a || []), ...(b || [])])].sort();
    h.cal = { at: new Date().toISOString(), days };
    h._dirty = true;
  }), 3);
}

function pendingDays(lg) {
  const h = loadHistory(lg.slug);
  const from = ymd(new Date(lg.from)), end = ymd(new Date(Date.now() - 864e5));
  if (h.cal?.days?.length) return h.cal.days.filter((d) => d >= from && d <= end && !h._days.has(d));
  const out = [];
  for (let t = Date.parse(lg.from); t <= Date.now() - 864e5; t += 864e5) {
    const d = ymd(new Date(t));
    if (!h._days.has(d)) out.push(d);
  }
  return out;
}

export const isComplete = (lg) => pendingDays(lg).length === 0;

export function coverage(leagues) {
  return Object.fromEntries(leagues.map((lg) => {
    const h = loadHistory(lg.slug);
    const pending = pendingDays(lg).length;
    return [lg.slug, { games: h.games.length, withOdds: h.games.filter((g) => g[10]).length, pct: +(h._days.size / Math.max(1, h._days.size + pending)).toFixed(3), pending }];
  }));
}

// baixa um lote de dias pendentes, priorizando ligas ainda sem memória
export async function collectHistory(leagues, budget, log = () => {}, priority = []) {
  const tasks = [];
  await ensureCalendars(leagues);
  // ligas ainda não treinadas primeiro, depois as que têm mais dias faltando
  const order = [...leagues].sort((a, b) => (priority.includes(b.slug) - priority.includes(a.slug)) || pendingDays(b).length - pendingDays(a).length);
  const per = Math.max(20, Math.ceil(budget / order.length));
  for (const lg of order) for (const d of pendingDays(lg).slice(0, priority.includes(lg.slug) ? budget : per)) tasks.push([lg, d]);
  const batch = tasks.slice(0, budget);
  let added = 0;
  await pool(batch.map(([lg, d]) => async () => {
    if (source.blocked) return;
    const evs = await fetchDay(lg, d, true);
    if (evs == null) return; // falha: tenta de novo no próximo ciclo
    const h = loadHistory(lg.slug);
    for (const ev of evs) if (addGame(ev)) added++;
    h._days.add(d); h._dirty = true;
  }), 3);
  saveHistories();
  log(`[memória] ${batch.length} dias consultados, ${added} jogos novos guardados`);
  return { requested: batch.length, added };
}

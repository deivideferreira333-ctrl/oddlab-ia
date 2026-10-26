// Um ciclo completo da IA (executado a cada 10 minutos pelo GitHub Actions ou pelo servidor local):
// coleta ESPN -> guarda na memória -> aprende com resultados -> retreina quando a memória cresce ->
// recalibra parâmetros -> gera sinais de totais -> registra lições
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAGUES, WINDOW_BACK, WINDOW_AHEAD, MARKET_LABEL, DEFAULTS, SIGNAL_MARKETS, MODEL_VERSION, HISTORY_BUDGET } from './config.mjs';
import { fetchWindow, ymd, source } from './espn.mjs';
import { loadAll, saveAll, analyze, bestSignals, baseSignal, learnFromResult, snapshot, DATA_DIR } from './brain.mjs';
import { addGame, collectHistory, saveHistories, coverage, isComplete, loadHistory, toEvent } from './history.mjs';
import { PRINCIPLES, buildKnowledge, knowledgeInsights } from './knowledge.mjs';

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const DAY = 864e5;
const SPORT = { soccer: 'Futebol', basketball: 'Basquete', hockey: 'Hóquei' };
const isTotal = (k) => k.endsWith(':ou') || k.endsWith(':total');

function addInsight(ctx, cycle, type, text, extra = {}) {
  const recent = ctx.learning.insights.slice(-120);
  if (recent.some((i) => i.text === text)) return false;
  ctx.learning.insights.push({ t: new Date().toISOString(), cycle, type, text, ...extra });
  return true;
}

// ajusta o EV mínimo de cada mercado conforme o ROI real das últimas entradas
function tuneThresholds(ctx, cycle) {
  const { state } = ctx;
  const notes = [];
  for (const key of SIGNAL_MARKETS) {
    const real = ctx.signals.filter((s) => s.marketKey === key && ['green', 'red'].includes(s.status)).slice(-80);
    if (real.length < 25) continue;
    const staked = real.reduce((a, s) => a + s.stake, 0);
    const roi = real.reduce((a, s) => a + s.profit, 0) / staked;
    const cur = state.learned.minEV[key];
    let next = cur;
    if (roi < -0.04) next = Math.min(0.15, cur + 0.005);
    else if (roi > 0.06) next = Math.max(0.02, cur - 0.0025);
    if (next !== cur) {
      state.learned.minEV[key] = +next.toFixed(4);
      if (cycle - (state.lastLogged['minEV:' + key] || 0) >= 3) {
        notes.push(`${MARKET_LABEL[key]} (${SPORT[key.split(':')[0]]}): ROI recente de ${pct(roi, 1)} em ${real.length} entradas. Exigência de valor ${next > cur ? 'subiu' : 'caiu'} para EV ≥ ${pct(next, 1)}.`);
        state.lastLogged['minEV:' + key] = cycle;
      }
    }
  }
  return notes;
}

function calibrationNote(state, sport) {
  const c = state.calib[sport];
  if (!c) return null;
  const rows = c.map((b, i) => ({ i, ...b })).filter((b) => b.n >= 40);
  if (!rows.length) return null;
  const b = rows[Math.floor(Math.random() * rows.length)];
  const said = b.sumP / b.n, got = b.hits / b.n;
  const gap = got - said;
  const verdict = Math.abs(gap) < 0.03 ? 'bem calibrado' : gap > 0 ? 'conservador nessa faixa (acerta mais do que prevê)' : 'otimista nessa faixa (acerta menos do que prevê)';
  return `${SPORT[sport]}: quando o modelo projeta ${b.i * 10}–${b.i * 10 + 10}%, o evento ocorreu ${pct(got, 1)} das vezes (previsto ${pct(said, 1)}, n=${b.n}). Modelo ${verdict}.`;
}

function studyNotes(state) {
  const notes = [];
  const name = (lg) => LEAGUES.find((l) => l.slug === lg)?.name || lg;
  for (const [lg, L] of Object.entries(state.soccerLeagues)) {
    if (L.n < 30) continue;
    notes.push(`${name(lg)}: ${(L.goals / L.n).toFixed(2)} gols por jogo, over 2.5 em ${pct(L.over25 / L.n)} (n=${L.n}). Gols esperados base: casa ${Math.exp(L.lgH).toFixed(2)} × fora ${Math.exp(L.lgA).toFixed(2)}.`);
  }
  for (const [lg, L] of Object.entries(state.bbLeagues)) {
    if (L.n < 20) continue;
    notes.push(`${name(lg)}: total médio aprendido ${L.avgTotal.toFixed(1)} pts, desvio do total ${L.sigT.toFixed(1)}. Efeito de back-to-back no total: ${L.b2bT >= 0 ? '+' : ''}${(L.b2bT || 0).toFixed(2)} pts por time cansado.`);
  }
  for (const [lg, L] of Object.entries(state.hkLeagues || {})) {
    if (L.n < 20) continue;
    notes.push(`${name(lg)}: ${(L.goals / L.n).toFixed(2)} gols por jogo, over 5.5 em ${pct(L.over55 / L.n)}, over 6.5 em ${pct(L.over65 / L.n)}, prorrogação em ${pct(L.ot / L.n)}. Back-to-back muda os gols sofridos em ${pct(Math.exp(L.b2b) - 1, 1)}.`);
  }
  // times que mais puxam o over / under nos últimos 10 jogos
  for (const [sp, teams] of [['soccer', state.soccerTeams], ['basketball', state.bbTeams], ['hockey', state.hkTeams || {}]]) {
    const list = Object.values(teams).filter((t) => t.tot?.length >= 8);
    if (list.length < 6) continue;
    const avg = (t) => t.tot.reduce((a, b) => a + b, 0) / t.tot.length;
    const hi = list.reduce((a, b) => (avg(b) > avg(a) ? b : a));
    const lo = list.reduce((a, b) => (avg(b) < avg(a) ? b : a));
    notes.push(`${SPORT[sp]}: jogos de ${hi.name} têm o maior total recente (${avg(hi).toFixed(1)} nos últimos ${hi.tot.length}); os de ${lo.name}, o menor (${avg(lo).toFixed(1)}).`);
  }
  for (const [key, s] of Object.entries(state.stats)) {
    if (s.n < 30 || !SIGNAL_MARKETS.includes(key)) continue;
    const better = s.llModel < s.llMarket;
    notes.push(`${MARKET_LABEL[key]} (${SPORT[key.split(':')[0]]}): log-loss do modelo ${(s.llModel / s.n).toFixed(4)} contra ${(s.llMarket / s.n).toFixed(4)} do mercado (n=${s.n}). ${better ? 'O modelo próprio supera o mercado e ganha peso.' : 'O mercado ainda é mais preciso; a IA usa o modelo para achar desvios pontuais.'} Peso atual do modelo: ${pct(state.learned.blend[key])}.`);
  }
  return notes;
}

// retreino: zera os modelos dos esportes envolvidos e reaprende toda a memória em ordem cronológica
function retrain(ctx, leagues) {
  const { state } = ctx;
  const sports = new Set(leagues.map((l) => l.sport));
  if (sports.has('soccer')) { state.soccerLeagues = {}; state.soccerTeams = {}; }
  if (sports.has('basketball')) { state.bbLeagues = {}; state.bbTeams = {}; }
  if (sports.has('hockey')) { state.hkLeagues = {}; state.hkTeams = {}; }
  for (const sp of sports) delete state.calib[sp];
  const games = [];
  for (const lg of leagues) for (const g of loadHistory(lg.slug).games) games.push(toEvent(g, lg));
  games.sort((a, b) => a.date.localeCompare(b.date));
  const ids = new Set(games.map((e) => e.id));
  for (const id of Object.keys(state.processed)) if (ids.has(id)) delete state.processed[id];
  for (const ev of games) learnFromResult(ctx, ev);
  return games.length;
}

export async function runCycle({ log = console.log, budget = HISTORY_BUDGET } = {}) {
  const t0 = Date.now();
  const ctx = loadAll();
  const { state } = ctx;
  state.cycles = (state.cycles || 0) + 1;
  const cycle = state.cycles;
  const fresh = [];
  state.oddsMemo ??= {};
  // ligas que já têm modelo treinado (instalação antiga: as que já aparecem no cérebro)
  state.trainedLeagues ??= LEAGUES.filter((l) => state.soccerLeagues[l.slug] || state.bbLeagues[l.slug]).map((l) => l.slug);

  // 0) princípios de mercado: conhecimento de base, registrado uma única vez
  state.principles ??= [];
  for (const [sp, text] of PRINCIPLES) {
    if (state.principles.includes(text)) continue;
    addInsight(ctx, cycle, 'conhecimento', text, { sport: sp });
    state.principles.push(text);
  }

  // 1) coleta da janela atual
  const days = [];
  for (let d = -WINDOW_BACK; d <= WINDOW_AHEAD; d++) days.push(ymd(new Date(Date.now() + d * DAY)));
  const events = await fetchWindow(LEAGUES, days);
  log(`[coleta] ${events.length} jogos na janela · ${source.requests} requisições`);
  if (source.blocked) {
    addInsight(ctx, cycle, 'fonte', 'A fonte de dados limitou temporariamente as requisições. Ciclo pausado sem alterar sinais; nova tentativa em 10 minutos.');
    const prevMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta.json'), 'utf8')); } catch { return {}; } })();
    saveAll(ctx, { 'meta.json': { ...prevMeta, cycle, lastAttempt: new Date().toISOString(), sourceLimited: true, nextCycle: new Date(Date.now() + 10 * 6e4).toISOString() } });
    log('[coleta] fonte limitou o acesso (403/429). Ciclo pausado.');
    return { sourceLimited: true, cycle };
  }

  // 2) resultados novos: memória permanente + aprendizado (ligas ainda sem treino só guardam)
  const learned = [];
  for (const ev of events.filter((e) => e.completed && e.home.score != null)) {
    addGame(ev);
    if (!state.trainedLeagues.includes(ev.league)) continue;
    const r = learnFromResult(ctx, ev);
    if (r) learned.push(r);
  }
  saveHistories();

  // 3) memória histórica: baixa um lote por ciclo (ligas sem treino primeiro)
  const untrained = LEAGUES.filter((l) => !state.trainedLeagues.includes(l.slug)).map((l) => l.slug);
  const cov0 = coverage(LEAGUES);
  if (Object.values(cov0).some((c) => c.pending) || LEAGUES.some((l) => !loadHistory(l.slug).cal)) {
    const r = await collectHistory(LEAGUES, budget, log, untrained);
    if (r.added) fresh.push(['memoria', `Memória histórica ampliada: ${r.added} jogos antigos guardados neste ciclo (${r.requested} dias de jogo consultados na ESPN).`]);
  }

  // 4) liga nova: treina do zero assim que a memória dela fica completa
  for (const lg of LEAGUES.filter((l) => untrained.includes(l.slug) && isComplete(l))) {
    const sameSport = LEAGUES.filter((l) => l.sport === lg.sport);
    if (sameSport.some((l) => state.trainedLeagues.includes(l.slug))) continue; // espera o retreino completo
    const n = retrain(ctx, sameSport.filter((l) => isComplete(l)));
    for (const l of sameSport.filter((x) => isComplete(x))) if (!state.trainedLeagues.includes(l.slug)) state.trainedLeagues.push(l.slug);
    fresh.push(['treino', `${lg.name} treinada do zero com ${n} jogos da memória (desde ${lg.from.split('-').reverse().join('/')}). Ataque, defesa, prorrogação e efeito de back-to-back calculados.`]);
  }

  // 5) retreino completo quando toda a memória está baixada (ou o modelo mudou de versão)
  if (LEAGUES.every(isComplete) && state.trainedVersion !== MODEL_VERSION) {
    const n = retrain(ctx, LEAGUES);
    state.trainedVersion = MODEL_VERSION;
    state.trainedLeagues = LEAGUES.map((l) => l.slug);
    fresh.push(['treino', `Retreino completo: ${n} jogos de ${LEAGUES.length} ligas reaprendidos em ordem cronológica. A IA agora usa toda a memória histórica.`]);
    for (const t of knowledgeInsights(buildKnowledge(LEAGUES))) fresh.push(['conhecimento', t]);
  }

  // 6) lições dos resultados (foco em totais)
  const overOf = (r) => r.an.markets.find((m) => isTotal(m.marketKey) && m.side === 'over');
  for (const r of learned) {
    const tot = r.ev.home.score + r.ev.away.score, m = overOf(r);
    if (m && ((m.pModel > 0.72 && tot < m.line) || (m.pModel < 0.28 && tot > m.line))) {
      fresh.push(['zebra', `Total fora do esperado: ${r.ev.home.name} ${r.ev.home.score}–${r.ev.away.score} ${r.ev.away.name} (${r.ev.leagueName}). O modelo dava ${pct(m.pModel)} para over ${m.line}; ataque e defesa dos dois times foram recalibrados.`]);
    }
  }
  if (learned.length) {
    const with_ = learned.filter(overOf);
    const hits = with_.filter((r) => { const m = overOf(r); return (m.pModel >= 0.5) === (r.ev.home.score + r.ev.away.score > m.line); }).length;
    fresh.push(['resultado', `${learned.length} resultado(s) incorporado(s). O lado do total apontado pelo modelo acertou ${hits} de ${with_.length}.`]);
  }
  for (const key of SIGNAL_MARKETS) {
    const prev = state.lastLogged['blend:' + key] ?? DEFAULTS.learned.blend[key];
    const cur = state.learned.blend[key];
    if (Math.abs(cur - prev) >= 0.01) {
      fresh.push(['peso', `${MARKET_LABEL[key]} (${SPORT[key.split(':')[0]]}): peso do modelo próprio ${cur > prev ? 'subiu' : 'caiu'} de ${pct(prev, 1)} para ${pct(cur, 1)} após comparar previsões com resultados reais.`]);
      state.lastLogged['blend:' + key] = cur;
    }
  }
  for (const n of tuneThresholds(ctx, cycle)) fresh.push(['limiar', n]);

  // sinais ainda abertos em mercados fora do foco são retirados (não contam no desempenho)
  for (const s of ctx.signals) if (s.status === 'aberto' && !SIGNAL_MARKETS.includes(s.marketKey)) { s.status = 'cancelado'; s.note = 'mercado fora do foco'; s.updatedAt = new Date().toISOString(); }

  // 7) analisar jogos futuros/ao vivo e gerenciar sinais
  const feed = [];
  const now = new Date().toISOString();
  for (const ev of events) {
    let snap = state.snapshots[ev.id];
    const ready = state.trainedLeagues.includes(ev.league);
    if (ev.state === 'pre' && ready) {
      const an = analyze(state, ev);
      const sigs = bestSignals(state, ev, an);
      for (const s of sigs) {
        const id = `${ev.id}:${s.marketKey}`;
        if (ctx.signals.some((x) => x.id === id)) continue; // a odd do sinal fica travada na emissão
        ctx.signals.push(baseSignal(ev, s));
        fresh.push(['sinal', `Novo sinal: ${s.label} (${MARKET_LABEL[s.marketKey]}) em ${ev.home.name} × ${ev.away.name} @ ${s.odd.toFixed(2)}. Probabilidade ${pct(s.p, 1)}, valor esperado +${pct(s.ev, 1)}.`]);
      }
      // odd atual do mercado: vira a odd de fechamento quando o jogo começa (medição de CLV)
      for (const ex of ctx.signals) {
        if (ex.eventId !== ev.id || ex.status !== 'aberto') continue;
        const m = an.markets.find((x) => x.marketKey === ex.marketKey && x.side === ex.side && x.line === ex.line);
        if (m?.odd) { ex.closeOdd = m.odd; ex.evNow = m.ev == null ? null : +m.ev.toFixed(4); ex.updatedAt = now; }
      }
      const prevLine = state.oddsMemo[ev.id]?.totalLine;
      if (ev.odds?.totalLine != null && prevLine != null && ev.odds.totalLine !== prevLine && !state.lastLogged['line:' + ev.id]) {
        fresh.push(['mercado', `Linha de total moveu em ${ev.home.name} × ${ev.away.name}: ${prevLine} → ${ev.odds.totalLine}. Projeção da IA: ${an.pred.total.toFixed(2)}.`]);
        state.lastLogged['line:' + ev.id] = cycle;
      }
      snap = state.snapshots[ev.id] = snapshot(ev, an, sigs);
      if (ev.odds) state.oddsMemo[ev.id] = { ...ev.odds, at: now };
    } else if (ev.state !== 'pre') {
      for (const ex of ctx.signals) if (ex.eventId === ev.id && ex.status === 'aberto') { ex.status = 'travado'; ex.lockedAt = now; }
    }
    if (ev.completed && Date.now() - Date.parse(ev.date) > 36 * 36e5) continue;
    feed.push({ ...ev, analysis: snap || null });
  }

  // 8) lições de estudo: sempre aprende algo novo a cada ciclo
  for (const [type, text] of fresh) addInsight(ctx, cycle, type, text);
  const calib = ['soccer', 'basketball', 'hockey'].map((s) => calibrationNote(state, s)).filter(Boolean);
  const pool = [...calib, ...studyNotes(state)].sort(() => Math.random() - 0.5);
  let studied = 0;
  for (const n of pool) { if (addInsight(ctx, cycle, 'estudo', n)) studied++; if (studied >= 2) break; }

  // 9) limpeza
  const cutoff = Date.now() - 400 * DAY;
  for (const [k, d] of Object.entries(state.processed)) if (Date.parse(d) < cutoff) delete state.processed[k];
  for (const k of Object.keys(state.snapshots)) if (!feed.find((e) => e.id === k)) delete state.snapshots[k];
  for (const [k, o] of Object.entries(state.oddsMemo)) if (state.processed[k] || Date.parse(o.at) < Date.now() - 10 * DAY) delete state.oddsMemo[k];
  for (const k of Object.keys(state.lastLogged)) if (/^(move|line):/.test(k) && cycle - state.lastLogged[k] > 600) delete state.lastLogged[k];

  // 10) parâmetros e saídas para o site
  ctx.learning.params.push({ t: now, cycle, blend: { ...state.learned.blend }, minEV: { ...state.learned.minEV },
    hca: Object.fromEntries(Object.entries(state.bbLeagues).map(([k, v]) => [k, +v.hca.toFixed(3)])) });

  const avgTot = (t) => (t.tot?.length ? +(t.tot.reduce((a, b) => a + b, 0) / t.tot.length).toFixed(2) : null);
  const goalRow = ([id, t]) => ({ id, name: t.name, lg: t.lg, att: +t.att.toFixed(3), def: +t.def.toFixed(3), power: +(t.att - t.def).toFixed(3), n: t.n, form: t.form, tot: avgTot(t) });
  const cov = coverage(LEAGUES);
  const ratings = {
    soccer: Object.entries(state.soccerTeams).filter(([, t]) => t.n >= 5).map(goalRow).sort((a, b) => b.power - a.power).slice(0, 250),
    hockey: Object.entries(state.hkTeams || {}).filter(([, t]) => t.n >= 3).map(goalRow).sort((a, b) => b.power - a.power),
    basketball: Object.entries(state.bbTeams).filter(([, t]) => t.n >= 3)
      .map(([id, t]) => ({ id, name: t.name, lg: t.lg, r: +t.r.toFixed(2), t: +t.t.toFixed(2), n: t.n, form: t.form, tot: avgTot(t) }))
      .sort((a, b) => b.r - a.r),
    leagues: { soccer: state.soccerLeagues, basketball: state.bbLeagues, hockey: state.hkLeagues },
    calib: state.calib, stats: state.stats, learned: state.learned, signalMarkets: SIGNAL_MARKETS,
    knowledge: buildKnowledge(LEAGUES),
  };
  const meta = {
    lastCycle: now, cycle, durationMs: Date.now() - t0,
    nextCycle: new Date(Date.now() + 10 * 6e4).toISOString(),
    eventsInWindow: events.length,
    teamsKnown: Object.keys(state.soccerTeams).length + Object.keys(state.bbTeams).length + Object.keys(state.hkTeams || {}).length,
    gamesLearned: state.totalLearned || Object.keys(state.processed).length,
    memoryGames: Object.values(cov).reduce((a, c) => a + c.games, 0),
    memory: cov, trainedLeagues: state.trainedLeagues, fullyTrained: state.trainedVersion === MODEL_VERSION,
    leagues: LEAGUES, created: state.created,
  };
  saveAll(ctx, { 'feed.json': feed, 'ratings.json': ratings, 'meta.json': meta });
  log(`[ciclo ${cycle}] ok em ${((Date.now() - t0) / 1000).toFixed(1)}s · ${learned.length} resultados · ${ctx.signals.filter((s) => s.status === 'aberto').length} sinais abertos · memória ${meta.memoryGames} jogos`);
  return meta;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const b = process.argv.find((a) => a.startsWith('--budget='));
  runCycle({ budget: b ? Number(b.split('=')[1]) : HISTORY_BUDGET }).catch((e) => { console.error(e); process.exit(1); });
}

// Um ciclo completo da IA (executado a cada 10 minutos pelo servidor ou pelo GitHub Actions):
// coleta ESPN -> aprende com resultados -> recalibra parâmetros -> gera sinais -> registra lições
import { fileURLToPath } from 'node:url';
import { LEAGUES, SEED_RANGES, BOOTSTRAP_DAYS, WINDOW_BACK, WINDOW_AHEAD, MARKET_LABEL, DEFAULTS } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fetchWindow, ymd, source } from './espn.mjs';
import { loadAll, saveAll, analyze, bestSignals, baseSignal, learnFromResult, snapshot, DATA_DIR } from './brain.mjs';

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const DAY = 864e5;

function daysBetween(a, b) {
  const out = [];
  for (let t = Date.parse(a); t <= Date.parse(b); t += DAY) out.push(ymd(new Date(t)));
  return out;
}

function addInsight(ctx, cycle, type, text, extra = {}) {
  const recent = ctx.learning.insights.slice(-80);
  if (recent.some((i) => i.text === text)) return false;
  ctx.learning.insights.push({ t: new Date().toISOString(), cycle, type, text, ...extra });
  return true;
}

// ajusta o EV mínimo de cada mercado conforme o ROI real das últimas entradas
function tuneThresholds(ctx, cycle) {
  const { state } = ctx;
  const notes = [];
  for (const key of Object.keys(state.learned.minEV)) {
    const real = ctx.signals.filter((s) => s.marketKey === key && ['green', 'red'].includes(s.status));
    const bt = ctx.backtest.filter((s) => s.marketKey === key && ['green', 'red'].includes(s.status));
    const pool = [...bt.slice(-60), ...real.slice(-60), ...real.slice(-60)].slice(-80); // resultados reais pesam em dobro
    if (pool.length < 25) continue;
    const staked = pool.reduce((a, s) => a + s.stake, 0);
    const roi = pool.reduce((a, s) => a + s.profit, 0) / staked;
    const last = state.lastLogged['minEV:' + key] || 0;
    const cur = state.learned.minEV[key];
    let next = cur;
    if (roi < -0.04) next = Math.min(0.15, cur + 0.005);
    else if (roi > 0.06) next = Math.max(0.02, cur - 0.0025);
    if (next !== cur) {
      state.learned.minEV[key] = +next.toFixed(4);
      if (cycle - last >= 3) {
        notes.push(`${MARKET_LABEL[key]}: ROI recente de ${pct(roi, 1)} em ${pool.length} entradas. Exigência de valor ${next > cur ? 'subiu' : 'caiu'} para EV ≥ ${pct(next, 1)}.`);
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
  return `${sport === 'soccer' ? 'Futebol' : 'Basquete'}: quando o modelo projeta ${b.i * 10}–${b.i * 10 + 10}%, o evento ocorreu ${pct(got, 1)} das vezes (previsto ${pct(said, 1)}, n=${b.n}). Modelo ${verdict}.`;
}

function studyNotes(ctx) {
  const { state } = ctx;
  const notes = [];
  // tendências por liga
  for (const [lg, L] of Object.entries(state.soccerLeagues)) {
    if (L.n < 30) continue;
    const name = LEAGUES.find((l) => l.slug === lg)?.name || lg;
    notes.push(`${name}: média de ${(L.goals / L.n).toFixed(2)} gols por jogo, mandante vence ${pct(L.homeWins / L.n)}, empates ${pct(L.draws / L.n)}, over 2.5 em ${pct(L.over25 / L.n)} (n=${L.n}). Gols esperados base: casa ${Math.exp(L.lgH).toFixed(2)} × fora ${Math.exp(L.lgA).toFixed(2)}.`);
  }
  for (const [lg, L] of Object.entries(state.bbLeagues)) {
    if (L.n < 20) continue;
    notes.push(`${lg.toUpperCase()}: vantagem de mando aprendida em ${L.hca.toFixed(2)} pts, total médio ${L.avgTotal.toFixed(1)}, desvio da margem ${L.sigM.toFixed(1)} pts e do total ${L.sigT.toFixed(1)} pts (n=${L.n}).`);
  }
  // sequências
  for (const t of Object.values(state.soccerTeams).concat(Object.values(state.bbTeams))) {
    if (t.form?.length === 5 && t.form.every((f) => f === 'W')) notes.push(`${t.name} venceu os últimos 5 jogos. Rating ajustado, mas a IA evita supervalorizar sequências: o mercado costuma precificá-las em excesso.`);
  }
  // força ofensiva/defensiva
  const st = Object.values(state.soccerTeams).filter((t) => t.n >= 8);
  if (st.length) {
    const atk = st.reduce((a, b) => (b.att > a.att ? b : a));
    const def = st.reduce((a, b) => (b.def < a.def ? b : a));
    notes.push(`Ataque mais forte do banco: ${atk.name} (${pct(Math.exp(atk.att) - 1)} acima da média da liga). Defesa mais sólida: ${def.name} (sofre ${pct(1 - Math.exp(def.def))} menos que a média).`);
  }
  for (const [key, s] of Object.entries(state.stats)) {
    if (s.n < 30) continue;
    const better = s.llModel < s.llMarket;
    notes.push(`${MARKET_LABEL[key]}: log-loss médio do modelo ${(s.llModel / s.n).toFixed(4)} contra ${(s.llMarket / s.n).toFixed(4)} do mercado (n=${s.n}). ${better ? 'O modelo próprio supera o mercado e ganha peso.' : 'O mercado ainda é mais preciso; a IA usa o modelo para achar desvios pontuais.'} Peso atual do modelo: ${pct(state.learned.blend[key])}.`);
  }
  return notes;
}

export async function runCycle({ forceBootstrap = false, log = console.log } = {}) {
  const t0 = Date.now();
  const ctx = loadAll();
  const { state } = ctx;
  state.cycles = (state.cycles || 0) + 1;
  const cycle = state.cycles;
  const fresh = [];

  // 1) treino inicial com histórico
  if (!state.bootstrapped || forceBootstrap) {
    const end = new Date(Date.now() - DAY);
    const start = new Date(Date.now() - BOOTSTRAP_DAYS * DAY);
    log(`[bootstrap] treinando com ${BOOTSTRAP_DAYS} dias de histórico...`);
    const days = daysBetween(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    let hist = await fetchWindow(LEAGUES, days);
    for (const [slug, ranges] of Object.entries(SEED_RANGES)) {
      const lg = LEAGUES.filter((l) => l.slug === slug);
      for (const [a, b] of ranges) hist = hist.concat(await fetchWindow(lg, daysBetween(a, b)));
    }
    if (source.blocked) { log('[bootstrap] fonte limitou o acesso; treino será refeito no próximo ciclo.'); return { sourceLimited: true }; }
    hist = hist.filter((e) => e.completed && e.home.score != null).sort((a, b) => a.date.localeCompare(b.date));
    let n = 0;
    for (const ev of hist) if (learnFromResult(ctx, ev, { backtest: true })) n++;
    state.bootstrapped = true;
    const bt = ctx.backtest.filter((s) => s.status !== 'void');
    const prof = bt.reduce((a, s) => a + s.profit, 0), stk = bt.reduce((a, s) => a + s.stake, 0);
    addInsight(ctx, cycle, 'bootstrap', `Treino inicial concluído: ${n} jogos estudados em ${LEAGUES.length} ligas. Ratings de ataque, defesa, mando e ritmo calculados para ${Object.keys(state.soccerTeams).length + Object.keys(state.bbTeams).length} equipes.` +
      (bt.length ? ` Backtest: ${bt.length} entradas simuladas, acerto ${pct(bt.filter((s) => s.status === 'green').length / bt.length, 1)}, ROI ${pct(prof / Math.max(1, stk), 1)}.` : ' O placar histórico não traz odds, então a comparação com o mercado começa a partir dos próximos jogos.'));
    log(`[bootstrap] ${n} jogos processados`);
  }

  // 2) coleta da janela atual
  const days = [];
  for (let d = -WINDOW_BACK; d <= WINDOW_AHEAD; d++) days.push(ymd(new Date(Date.now() + d * DAY)));
  const events = await fetchWindow(LEAGUES, days);
  log(`[coleta] ${events.length} jogos na janela · ${source.requests} requisições`);
  state.oddsMemo ??= {};
  if (source.blocked) {
    // a ESPN limitou o acesso: não sobrescreve nada com dados parciais, tenta no próximo ciclo
    addInsight(ctx, cycle, 'fonte', 'A fonte de dados limitou temporariamente as requisições. Ciclo pausado sem alterar sinais; nova tentativa em 10 minutos.');
    const prevMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta.json'), 'utf8')); } catch { return {}; } })();
    saveAll(ctx, { 'meta.json': { ...prevMeta, cycle, lastAttempt: new Date().toISOString(), sourceLimited: true, nextCycle: new Date(Date.now() + 10 * 6e4).toISOString() } });
    log('[coleta] fonte limitou o acesso (403/429). Ciclo pausado.');
    return { sourceLimited: true, cycle };
  }

  // 3) aprender com jogos encerrados
  const learned = [];
  for (const ev of events.filter((e) => e.completed && e.home.score != null)) {
    const r = learnFromResult(ctx, ev);
    if (r) learned.push(r);
  }
  for (const r of learned) {
    if (r.pRes < 0.22) fresh.push(['zebra', `Zebra registrada: ${r.ev.home.name} ${r.ev.home.score}–${r.ev.away.score} ${r.ev.away.name} (${r.ev.leagueName}). O modelo dava ${pct(r.pRes)} para esse resultado; ratings dos dois times foram recalibrados.`]);
  }
  if (learned.length) {
    const avgP = learned.reduce((a, r) => a + r.pRes, 0) / learned.length;
    fresh.push(['resultado', `${learned.length} resultado(s) novo(s) incorporado(s). Probabilidade média que o modelo dava ao que aconteceu: ${pct(avgP, 1)}.`]);
  }
  // mudanças de peso modelo × mercado
  for (const key of Object.keys(state.learned.blend)) {
    const prev = state.lastLogged['blend:' + key] ?? DEFAULTS.learned.blend[key];
    const cur = state.learned.blend[key];
    if (Math.abs(cur - prev) >= 0.01) {
      fresh.push(['peso', `${MARKET_LABEL[key]}: peso do modelo próprio ${cur > prev ? 'subiu' : 'caiu'} de ${pct(prev, 1)} para ${pct(cur, 1)} após comparar previsões com resultados reais.`]);
      state.lastLogged['blend:' + key] = cur;
    }
  }
  for (const n of tuneThresholds(ctx, cycle)) fresh.push(['limiar', n]);

  // 4) analisar jogos futuros/ao vivo e gerenciar sinais
  const feed = [];
  const now = new Date().toISOString();
  for (const ev of events) {
    let snap = state.snapshots[ev.id];
    if (ev.state === 'pre') {
      const an = analyze(state, ev);
      const sigs = bestSignals(state, ev, an);
      const keys = new Set(sigs.map((s) => s.marketKey));
      for (const s of sigs) {
        const id = `${ev.id}:${s.marketKey}`;
        const ex = ctx.signals.find((x) => x.id === id);
        if (!ex) {
          ctx.signals.push(baseSignal(ev, s));
          fresh.push(['sinal', `Novo sinal: ${s.label} (${s.market}) em ${ev.home.name} × ${ev.away.name} @ ${s.odd.toFixed(2)}. Probabilidade ${pct(s.p, 1)}, valor esperado +${pct(s.ev, 1)}.`]);
        } else if (ex.status === 'aberto' || ex.status === 'cancelado') {
          if (ex.status === 'cancelado' && ex.side !== s.side) continue;
          Object.assign(ex, { status: 'aberto', side: s.side, label: s.label, line: s.line, odd: s.odd, p: +s.p.toFixed(4), pModel: +s.pModel.toFixed(4), pMarket: +s.pMarket.toFixed(4), ev: +s.ev.toFixed(4), stake: s.stake, confidence: s.confidence, updatedAt: now });
        }
      }
      for (const ex of ctx.signals) {
        if (ex.eventId === ev.id && ex.status === 'aberto' && !keys.has(ex.marketKey)) {
          ex.status = 'cancelado'; ex.updatedAt = now;
          fresh.push(['cancelado', `Sinal retirado antes do início: ${ex.label} em ${ex.home} × ${ex.away}. A odd se moveu e o valor esperado ficou abaixo do mínimo.`]);
        }
      }
      // movimento de linha (abertura -> agora)
      const o = ev.odds;
      if (o?.homeOpen && o.home && Math.abs(1 / o.homeOpen - 1 / o.home) >= 0.04 && !state.lastLogged['move:' + ev.id]) {
        const toward = 1 / o.home > 1 / o.homeOpen ? ev.home.name : ev.away.name;
        fresh.push(['mercado', `Movimento de linha em ${ev.home.name} × ${ev.away.name}: mandante foi de ${o.homeOpen.toFixed(2)} para ${o.home.toFixed(2)}. Dinheiro entrando em ${toward}; a IA reduz a confiança em sinais contra esse movimento.`]);
        state.lastLogged['move:' + ev.id] = cycle;
      }
      snap = state.snapshots[ev.id] = snapshot(ev, an, sigs);
      if (ev.odds) state.oddsMemo[ev.id] = { ...ev.odds, at: now };
    } else {
      for (const ex of ctx.signals) if (ex.eventId === ev.id && ex.status === 'aberto') { ex.status = 'travado'; ex.lockedAt = now; }
    }
    if (ev.completed && Date.now() - Date.parse(ev.date) > 36 * 36e5) continue;
    feed.push({ ...ev, analysis: snap || null });
  }

  // 5) lições de estudo: sempre aprende algo novo a cada ciclo
  for (const [type, text] of fresh) addInsight(ctx, cycle, type, text);
  const calib = [calibrationNote(state, 'soccer'), calibrationNote(state, 'basketball')].filter(Boolean);
  const pool = [...calib, ...studyNotes(ctx)].sort(() => Math.random() - 0.5);
  let studied = 0;
  for (const n of pool) { if (addInsight(ctx, cycle, 'estudo', n)) studied++; if (studied >= 2) break; }

  // 6) limpeza
  const cutoff = Date.now() - 200 * DAY;
  for (const [k, d] of Object.entries(state.processed)) if (Date.parse(d) < cutoff) delete state.processed[k];
  for (const k of Object.keys(state.snapshots)) if (!feed.find((e) => e.id === k)) delete state.snapshots[k];
  for (const [k, o] of Object.entries(state.oddsMemo)) if (state.processed[k] || Date.parse(o.at) < Date.now() - 10 * DAY) delete state.oddsMemo[k];
  for (const k of Object.keys(state.lastLogged)) if (k.startsWith('move:') && cycle - state.lastLogged[k] > 600) delete state.lastLogged[k];

  // 7) parâmetros e saídas para o site
  ctx.learning.params.push({ t: now, cycle, blend: { ...state.learned.blend }, minEV: { ...state.learned.minEV },
    hca: Object.fromEntries(Object.entries(state.bbLeagues).map(([k, v]) => [k, +v.hca.toFixed(3)])) });

  const ratings = {
    soccer: Object.entries(state.soccerTeams).filter(([, t]) => t.n >= 5)
      .map(([id, t]) => ({ id, name: t.name, lg: t.lg, att: +t.att.toFixed(3), def: +t.def.toFixed(3), power: +(t.att - t.def).toFixed(3), n: t.n, form: t.form }))
      .sort((a, b) => b.power - a.power).slice(0, 120),
    basketball: Object.entries(state.bbTeams).filter(([, t]) => t.n >= 3)
      .map(([id, t]) => ({ id, name: t.name, lg: t.lg, r: +t.r.toFixed(2), t: +t.t.toFixed(2), n: t.n, form: t.form }))
      .sort((a, b) => b.r - a.r),
    leagues: { soccer: state.soccerLeagues, basketball: state.bbLeagues },
    calib: state.calib, stats: state.stats, learned: state.learned,
  };
  const meta = {
    lastCycle: now, cycle, durationMs: Date.now() - t0,
    nextCycle: new Date(Date.now() + 10 * 6e4).toISOString(),
    eventsInWindow: events.length,
    teamsKnown: Object.keys(state.soccerTeams).length + Object.keys(state.bbTeams).length,
    gamesLearned: state.totalLearned || Object.keys(state.processed).length,
    insights: ctx.learning.insights.length + ctx.learning.archived.length * 0,
    leagues: LEAGUES,
    created: state.created,
  };
  saveAll(ctx, { 'feed.json': feed, 'ratings.json': ratings, 'meta.json': meta });
  log(`[ciclo ${cycle}] ok em ${((Date.now() - t0) / 1000).toFixed(1)}s · ${learned.length} resultados · ${ctx.signals.filter((s) => s.status === 'aberto').length} sinais abertos`);
  return meta;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCycle({ forceBootstrap: process.argv.includes('--bootstrap') }).catch((e) => { console.error(e); process.exit(1); });
}

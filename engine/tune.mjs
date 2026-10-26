// Ajuste automático de parâmetros: reaprende a memória com várias combinações e fica com a que
// prevê melhor o total de jogos que o modelo ainda não tinha visto (validação "walk-forward").
import { LEAGUES, DEFAULTS } from './config.mjs';
import { loadHistory, toEvent } from './history.mjs';
import { HYPER_DEFAULTS, soccerPredict, soccerUpdate, bbPredict, bbUpdate, hockeyPredict, hockeyUpdate } from './model.mjs';

export const GRIDS = {
  soccer: { lrMul: [0.5, 0.7, 1, 1.4, 2], wGoal: [1, 0.6, 0.3, 0.15, 0] },
  hockey: { lrMul: [0.5, 0.7, 1, 1.4, 2], wGoal: [1, 0.6, 0.3, 0.15, 0] },
  basketball: { kMul: [0.7, 1, 1.4, 2, 3], wLuck: [1, 0.7, 0.4, 0.1] },
};
const ENGINE = {
  soccer: { predict: (st, ev) => soccerPredict(st, ev, st.learned.dcRho), update: soccerUpdate },
  hockey: { predict: hockeyPredict, update: hockeyUpdate },
  basketball: { predict: bbPredict, update: bbUpdate },
};
const EVAL_FROM = 0.6; // os primeiros 60% dos jogos só treinam; os 40% finais são a prova

function combos(grid) {
  return Object.entries(grid).reduce((acc, [k, vals]) => acc.flatMap((c) => vals.map((v) => ({ ...c, [k]: v }))), [{}]);
}

function gamesOf(sport) {
  const out = [];
  for (const lg of LEAGUES.filter((l) => l.sport === sport)) for (const g of loadHistory(lg.slug).games) out.push(toEvent(g, lg));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// erro do total: log-loss da distribuição prevista (quanto menor, melhor) e erro médio absoluto em gols/pontos
function score(sport, games, hp) {
  const st = { soccerLeagues: {}, soccerTeams: {}, bbLeagues: {}, bbTeams: {}, hkLeagues: {}, hkTeams: {},
    learned: { dcRho: DEFAULTS.learned.dcRho, hyper: { [sport]: hp } } };
  const E = ENGINE[sport];
  const from = Math.floor(games.length * EVAL_FROM);
  let ll = 0, mae = 0, n = 0;
  games.forEach((ev, i) => {
    if (i >= from) {
      const p = E.predict(st, ev);
      const tot = ev.home.score + ev.away.score;
      if (sport === 'basketball') {
        const z = (tot - p.total) / p.sigT;
        ll += 0.5 * Math.log(2 * Math.PI * p.sigT ** 2) + 0.5 * z * z;
      } else {
        ll += -Math.log(Math.max(1e-6, p.tdist[Math.min(tot, p.tdist.length - 1)]));
      }
      mae += Math.abs(tot - p.total); n++;
    }
    E.update(st, ev);
  });
  return { ll: ll / Math.max(1, n), mae: mae / Math.max(1, n), n };
}

export function tuneSport(sport, current) {
  const games = gamesOf(sport);
  if (games.length < 300) return null;
  const withStats = games.filter((g) => g.home.stats || g.away.stats).length;
  const grid = combos(GRIDS[sport]);
  const results = grid.map((hp) => ({ hp, ...score(sport, games, hp) }));
  results.sort((a, b) => a.ll - b.ll);
  const base = results.find((r) => JSON.stringify(r.hp) === JSON.stringify({ ...HYPER_DEFAULTS[sport] })) || { hp: { ...HYPER_DEFAULTS[sport] }, ...score(sport, games, HYPER_DEFAULTS[sport]) };
  const cur = current ? (results.find((r) => JSON.stringify(r.hp) === JSON.stringify(current)) || { hp: current, ...score(sport, games, current) }) : base;
  return { sport, tried: grid.length, games: games.length, withStats, evaluated: results[0].n, best: results[0], current: cur, base, results: results.slice(0, 6), goalsOnly: results.find((r) => r.hp.wGoal === 1 || r.hp.wLuck === 1) };
}

// Completa a memória histórica (dias faltando e estatísticas dos jogos antigos) sem tocar no cérebro nem nos sinais.
// Uso: node engine/backfill.mjs --budget=2000
import { LEAGUES } from './config.mjs';
import { collectHistory, backfillStats, statsPending, coverage } from './history.mjs';
import { source } from './espn.mjs';

const b = process.argv.find((a) => a.startsWith('--budget='));
let budget = b ? Number(b.split('=')[1]) : 1000;
const r1 = await collectHistory(LEAGUES, budget, console.log);
budget -= r1.requested;
if (budget > 0 && !source.blocked) await backfillStats(LEAGUES, budget, console.log);
const pend = Object.values(coverage(LEAGUES)).reduce((a, c) => a + c.pending, 0);
console.log(`[backfill] dias faltando: ${pend} · dias sem estatísticas: ${statsPending(LEAGUES)} · ${source.requests} requisições${source.blocked ? ' · FONTE LIMITOU' : ''}`);

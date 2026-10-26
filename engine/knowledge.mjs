// Base de conhecimento: princípios de mercado de totais (registrados uma vez) e
// estatísticas medidas na memória histórica de cada liga (recalculadas a cada retreino).
import { loadHistory } from './history.mjs';

export const PRINCIPLES = [
  ['geral', 'Valor esperado (EV) = probabilidade real × odd − 1. Só existe vantagem quando a IA estima uma probabilidade maior do que a odd embute; acertar muito com odds baixas sem valor dá prejuízo no longo prazo.'],
  ['geral', 'A odd de fechamento é o preço mais eficiente do mercado. Pegar consistentemente uma odd melhor que a de fechamento (CLV positivo) é o indicador mais confiável de que os sinais têm valor, antes mesmo de o lucro aparecer.'],
  ['geral', 'Em totais, a casa costuma cobrar 4–5% de margem (−110/−110 ≈ 1,91/1,91). A IA remove essa margem antes de comparar com o modelo, para não confundir margem com probabilidade.'],
  ['geral', 'Linhas terminadas em .5 nunca devolvem. Linhas inteiras (2, 3, 6) devolvem a aposta se o total cair exatamente na linha; por isso a IA só emite sinal em linhas .5.'],
  ['geral', 'Variância: mesmo com EV de +4%, sequências de 6–8 reds seguidas acontecem. Stake fracionada (¼ Kelly, teto de 3%) existe para a banca sobreviver a elas.'],
  ['soccer', 'Gols no futebol seguem bem uma distribuição de Poisson para cada time. A correção Dixon-Coles ajusta os placares baixos (0-0, 1-0, 0-1, 1-1), que ocorrem com frequência um pouco diferente do Poisson puro.'],
  ['soccer', 'O total de gols de um jogo depende do ataque de cada time contra a defesa do outro: um time de ataque forte contra uma defesa fraca puxa o over mesmo que o adversário quase não marque.'],
  ['soccer', 'Ligas têm perfis de gols bem diferentes: Bundesliga e Eredivisie são historicamente de muitos gols; Argentina e Série B do Brasil, de poucos. A IA aprende a média de cada liga separadamente.'],
  ['soccer', 'Mata-mata e jogos de ida em copas costumam ser mais travados; em campo neutro a vantagem de mando desaparece. A IA trata campo neutro removendo o mando.'],
  ['soccer', 'Início de temporada tem mais incerteza: elencos mudaram. A IA regride os ratings em direção à média após pausas longas e dá menos confiança a times com poucos jogos na base.'],
  ['basketball', 'No basquete, o total de pontos depende principalmente do ritmo (número de posses) e da eficiência ofensiva dos dois times, não de quem é favorito.'],
  ['basketball', 'Jogos em back-to-back (dois dias seguidos) mudam ritmo e eficiência por cansaço e rotação. A IA mede esse efeito sobre o total e a margem em vez de assumir uma direção fixa.'],
  ['basketball', 'Na NBA o desvio-padrão do total fica perto de 18–20 pontos: uma diferença de 3 pontos entre a projeção e a linha vale só ~6 pontos percentuais de probabilidade.'],
  ['hockey', 'No hóquei, empate no tempo normal leva a prorrogação e, se preciso, shootout. O placar final sempre ganha exatamente 1 gol, e as casas contam esse gol no total. A IA modela o tempo normal e soma esse gol extra.'],
  ['hockey', 'A linha principal da NHL quase sempre é 5.5 ou 6.5. Como cada gol é raro, a diferença de preço entre over e under muda muito com pequenas mudanças de gols esperados.'],
  ['hockey', 'O goleiro titular pesa muito no total. Em back-to-back os times frequentemente usam o goleiro reserva; a IA mede quanto isso aumenta os gols sofridos.'],
];

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const share = (a, f) => a.filter(f).length / Math.max(1, a.length);

export function buildKnowledge(leagues) {
  const out = { leagues: {}, teams: {} };
  for (const lg of leagues) {
    const games = loadHistory(lg.slug).games;
    if (games.length < 20) continue;
    const tot = games.map((g) => g[6] + g[7]);
    const k = { name: lg.name, sport: lg.sport, n: games.length, avg: +mean(tot).toFixed(2), sd: +sd(tot).toFixed(2), homeShare: +(games.reduce((a, g) => a + g[6], 0) / Math.max(1, tot.reduce((a, b) => a + b, 0))).toFixed(3) };
    if (lg.sport === 'soccer') {
      Object.assign(k, { o15: share(tot, (t) => t > 1.5), o25: share(tot, (t) => t > 2.5), o35: share(tot, (t) => t > 3.5), btts: share(games, (g) => g[6] > 0 && g[7] > 0), nil: share(tot, (t) => t === 0) });
    } else if (lg.sport === 'hockey') {
      Object.assign(k, { o55: share(tot, (t) => t > 5.5), o65: share(tot, (t) => t > 6.5), ot: share(games, (g) => g[8]) });
    } else {
      const m = mean(tot);
      Object.assign(k, { within10: share(tot, (t) => Math.abs(t - m) <= 10), ot: share(games, (g) => g[8]) });
    }
    out.leagues[lg.slug] = k;
    // times que mais puxam over / under (média do total nos jogos do time, últimos 60 dias de dados do time)
    const byTeam = {};
    for (const g of games) for (const [id, name] of [[g[2], g[3]], [g[4], g[5]]]) (byTeam[id] ??= { name, t: [] }).t.push(g[6] + g[7]);
    const list = Object.values(byTeam).filter((t) => t.t.length >= 10).map((t) => ({ name: t.name, n: t.t.length, avg: +mean(t.t.slice(-20)).toFixed(2) })).sort((a, b) => b.avg - a.avg);
    out.teams[lg.slug] = { over: list.slice(0, 5), under: list.slice(-5).reverse() };
  }
  return out;
}

export function knowledgeInsights(K) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const notes = [];
  for (const [slug, k] of Object.entries(K.leagues)) {
    if (k.sport === 'soccer') notes.push(`Memória ${k.name} (${k.n} jogos): média de ${k.avg} gols, over 1.5 em ${pct(k.o15)}, over 2.5 em ${pct(k.o25)}, over 3.5 em ${pct(k.o35)}, ambos marcam ${pct(k.btts)}, 0-0 em ${pct(k.nil)}. Mandante faz ${pct(k.homeShare)} dos gols.`);
    else if (k.sport === 'hockey') notes.push(`Memória ${k.name} (${k.n} jogos): média de ${k.avg} gols por jogo (desvio ${k.sd}), over 5.5 em ${pct(k.o55)}, over 6.5 em ${pct(k.o65)}, ${pct(k.ot)} dos jogos foram para prorrogação/shootout.`);
    else notes.push(`Memória ${k.name} (${k.n} jogos): total médio de ${k.avg} pontos com desvio de ${k.sd}; ${pct(k.within10)} dos jogos terminaram a até 10 pontos da média, ${pct(k.ot)} tiveram prorrogação.`);
    const t = K.teams[slug];
    if (t?.over?.length) notes.push(`${k.name}: jogos com totais mais altos envolvem ${t.over.slice(0, 3).map((x) => `${x.name} (${x.avg})`).join(', ')}; mais baixos, ${t.under.slice(0, 3).map((x) => `${x.name} (${x.avg})`).join(', ')}.`);
  }
  return notes;
}

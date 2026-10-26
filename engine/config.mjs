// Ligas monitoradas (slugs da API pública da ESPN: site.api.espn.com/apis/site/v2/sports/<sport>/<slug>/scoreboard)
// `from`: início do histórico que a IA baixa e guarda na memória permanente (docs/data/history/)
export const LEAGUES = [
  { sport: 'soccer', slug: 'bra.1', name: 'Brasileirão Série A', country: 'BR', from: '2025-03-25' },
  { sport: 'soccer', slug: 'bra.2', name: 'Brasileirão Série B', country: 'BR', from: '2025-04-01' },
  { sport: 'soccer', slug: 'conmebol.libertadores', name: 'Libertadores', country: 'SA', from: '2025-02-15' },
  { sport: 'soccer', slug: 'conmebol.sudamericana', name: 'Sul-Americana', country: 'SA', from: '2025-03-01' },
  { sport: 'soccer', slug: 'eng.1', name: 'Premier League', country: 'EN', from: '2025-08-10' },
  { sport: 'soccer', slug: 'esp.1', name: 'La Liga', country: 'ES', from: '2025-08-10' },
  { sport: 'soccer', slug: 'ita.1', name: 'Serie A', country: 'IT', from: '2025-08-17' },
  { sport: 'soccer', slug: 'ger.1', name: 'Bundesliga', country: 'DE', from: '2025-08-17' },
  { sport: 'soccer', slug: 'fra.1', name: 'Ligue 1', country: 'FR', from: '2025-08-10' },
  { sport: 'soccer', slug: 'por.1', name: 'Liga Portugal', country: 'PT', from: '2025-08-03' },
  { sport: 'soccer', slug: 'ned.1', name: 'Eredivisie', country: 'NL', from: '2025-08-03' },
  { sport: 'soccer', slug: 'arg.1', name: 'Liga Profesional', country: 'AR', from: '2025-01-20' },
  { sport: 'soccer', slug: 'usa.1', name: 'MLS', country: 'US', from: '2025-02-20' },
  { sport: 'soccer', slug: 'uefa.champions', name: 'Champions League', country: 'EU', from: '2025-09-14' },
  { sport: 'soccer', slug: 'uefa.europa', name: 'Europa League', country: 'EU', from: '2025-09-21' },
  { sport: 'basketball', slug: 'nba', name: 'NBA', country: 'US', from: '2025-10-20' },
  { sport: 'basketball', slug: 'wnba', name: 'WNBA', country: 'US', from: '2025-05-15' },
  { sport: 'hockey', slug: 'nhl', name: 'NHL', country: 'US', from: '2025-10-06' },
];

// Só estes mercados geram sinal. Os demais continuam calculados e visíveis na análise de cada jogo.
export const SIGNAL_MARKETS = ['soccer:ou', 'basketball:total', 'hockey:total'];

export const MODEL_VERSION = 2;          // mudar força um retreino completo a partir da memória histórica
export const HISTORY_BUDGET = 420;       // requisições de histórico por ciclo (coleta gradual e educada)
export const WINDOW_BACK = 2;            // dias para trás coletados em cada ciclo
export const WINDOW_AHEAD = 3;           // dias para frente coletados em cada ciclo

// Conhecimento prévio (priors) por liga: média de gols/pontos por jogo e fatia do mandante.
// É só o ponto de partida: a IA substitui esses números pelo que mede nos dados.
export const PRIORS = {
  'bra.1': { total: 2.40, home: 0.58 }, 'bra.2': { total: 2.20, home: 0.59 },
  'conmebol.libertadores': { total: 2.55, home: 0.60 }, 'conmebol.sudamericana': { total: 2.45, home: 0.60 },
  'eng.1': { total: 2.85, home: 0.54 }, 'esp.1': { total: 2.60, home: 0.56 }, 'ita.1': { total: 2.60, home: 0.55 },
  'ger.1': { total: 3.15, home: 0.54 }, 'fra.1': { total: 2.80, home: 0.55 }, 'por.1': { total: 2.60, home: 0.56 },
  'ned.1': { total: 3.10, home: 0.56 }, 'arg.1': { total: 2.15, home: 0.58 }, 'usa.1': { total: 3.00, home: 0.57 },
  'uefa.champions': { total: 3.05, home: 0.55 }, 'uefa.europa': { total: 2.85, home: 0.55 },
  nba: { total: 228, hca: 2.3, sigM: 13, sigT: 18.5 },
  wnba: { total: 164, hca: 2.3, sigM: 12, sigT: 16.5 },
  nhl: { total: 6.1, home: 0.52 }, // total final, inclui o gol de prorrogação/shootout
};

// Parâmetros iniciais. Todos os que estão em `learned` são ajustados pela IA a cada ciclo.
export const DEFAULTS = {
  signal: {
    minProb: 0.18,
    minOdd: 1.40,
    maxOdd: 3.2,             // totais raramente pagam mais que isso; acima é ruído
    kellyFraction: 0.25,
    maxStake: 3,             // % da banca
  },
  learned: {
    // peso do modelo próprio vs. probabilidade justa do mercado (o resto vem do mercado)
    blend: { 'soccer:1x2': 0.35, 'soccer:ou': 0.35, 'basketball:ml': 0.3, 'basketball:spread': 0.3, 'basketball:total': 0.3, 'hockey:ml': 0.3, 'hockey:total': 0.35 },
    // valor esperado mínimo para emitir sinal, por mercado
    minEV: { 'soccer:1x2': 0.04, 'soccer:ou': 0.035, 'basketball:ml': 0.035, 'basketball:spread': 0.03, 'basketball:total': 0.03, 'hockey:ml': 0.04, 'hockey:total': 0.035 },
    dcRho: -0.06,            // correção Dixon-Coles para placares baixos
  },
};

export const MARKET_LABEL = {
  'soccer:1x2': 'Resultado (1X2)',
  'soccer:ou': 'Gols Over/Under',
  'basketball:ml': 'Vencedor (ML)',
  'basketball:spread': 'Handicap (Spread)',
  'basketball:total': 'Pontos Over/Under',
  'hockey:ml': 'Vencedor (ML)',
  'hockey:total': 'Gols Over/Under',
};

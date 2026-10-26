// Ligas monitoradas (slugs da API pública da ESPN: site.api.espn.com/apis/site/v2/sports/<sport>/<slug>/scoreboard)
export const LEAGUES = [
  { sport: 'soccer', slug: 'bra.1', name: 'Brasileirão Série A', country: 'BR' },
  { sport: 'soccer', slug: 'bra.2', name: 'Brasileirão Série B', country: 'BR' },
  { sport: 'soccer', slug: 'conmebol.libertadores', name: 'Libertadores', country: 'SA' },
  { sport: 'soccer', slug: 'conmebol.sudamericana', name: 'Sul-Americana', country: 'SA' },
  { sport: 'soccer', slug: 'eng.1', name: 'Premier League', country: 'EN' },
  { sport: 'soccer', slug: 'esp.1', name: 'La Liga', country: 'ES' },
  { sport: 'soccer', slug: 'ita.1', name: 'Serie A', country: 'IT' },
  { sport: 'soccer', slug: 'ger.1', name: 'Bundesliga', country: 'DE' },
  { sport: 'soccer', slug: 'fra.1', name: 'Ligue 1', country: 'FR' },
  { sport: 'soccer', slug: 'por.1', name: 'Liga Portugal', country: 'PT' },
  { sport: 'soccer', slug: 'ned.1', name: 'Eredivisie', country: 'NL' },
  { sport: 'soccer', slug: 'arg.1', name: 'Liga Profesional', country: 'AR' },
  { sport: 'soccer', slug: 'usa.1', name: 'MLS', country: 'US' },
  { sport: 'soccer', slug: 'uefa.champions', name: 'Champions League', country: 'EU' },
  { sport: 'soccer', slug: 'uefa.europa', name: 'Europa League', country: 'EU' },
  { sport: 'basketball', slug: 'nba', name: 'NBA', country: 'US' },
  { sport: 'basketball', slug: 'wnba', name: 'WNBA', country: 'US' },
];

// Janelas extras de histórico usadas só na primeira execução (treino inicial)
export const SEED_RANGES = {
  nba: [['2026-01-15', '2026-04-14']],
  wnba: [['2026-06-01', '2026-09-20']],
};

export const BOOTSTRAP_DAYS = 100;      // dias de histórico para treinar no primeiro ciclo
export const WINDOW_BACK = 2;           // dias para trás coletados em cada ciclo
export const WINDOW_AHEAD = 3;          // dias para frente coletados em cada ciclo

// Parâmetros iniciais. Todos os que estão em `learned` são ajustados pela IA a cada ciclo.
export const DEFAULTS = {
  signal: {
    minProb: 0.18,
    minOdd: 1.35,
    maxOdd: 6.5,
    kellyFraction: 0.25,
    maxStake: 3,             // % da banca
  },
  learned: {
    // peso do modelo próprio vs. probabilidade justa do mercado (o resto vem do mercado)
    blend: { 'soccer:1x2': 0.35, 'soccer:ou': 0.35, 'basketball:ml': 0.3, 'basketball:spread': 0.3, 'basketball:total': 0.3 },
    // valor esperado mínimo para emitir sinal, por mercado
    minEV: { 'soccer:1x2': 0.04, 'soccer:ou': 0.035, 'basketball:ml': 0.035, 'basketball:spread': 0.03, 'basketball:total': 0.03 },
    dcRho: -0.06,            // correção Dixon-Coles para placares baixos
  },
};

export const MARKET_LABEL = {
  'soccer:1x2': 'Resultado (1X2)',
  'soccer:ou': 'Gols Over/Under',
  'basketball:ml': 'Vencedor (ML)',
  'basketball:spread': 'Handicap (Spread)',
  'basketball:total': 'Pontos Over/Under',
};

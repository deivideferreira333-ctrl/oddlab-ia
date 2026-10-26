/* OddLab IA — front-end. Lê o cérebro salvo em data/*.json (atualizado a cada 10 min pelo motor)
   e acompanha placares ao vivo direto da API pública da ESPN no navegador. */
(() => {
  'use strict';

  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
  const TZ = 'America/Sao_Paulo';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
  const odd = (x) => (x ? Number(x).toFixed(2) : '—');
  const sgn = (x, d = 2) => (x > 0 ? '+' : '') + Number(x).toFixed(d);
  const store = {
    get(k, fb) { try { const v = localStorage.getItem('oddlab:' + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem('oddlab:' + k, JSON.stringify(v)); } catch {} },
  };

  const TABS = [
    { id: 'painel', label: 'Painel', sub: 'Visão geral da IA, sinais em destaque e o que ela aprendeu agora', icon: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>' },
    { id: 'sinais', label: 'Sinais', sub: 'Entradas com valor esperado positivo, atualizadas até o início do jogo', icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
    { id: 'aovivo', label: 'Ao vivo', sub: 'Placar em tempo real da ESPN cruzado com as projeções da IA', icon: '<circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a4.5 4.5 0 0 0 0 7M15.5 8.5a4.5 4.5 0 0 1 0 7"/>' },
    { id: 'jogos', label: 'Jogos e análise', sub: 'Estudo completo de cada partida: probabilidades, odds justas e leitura da IA', icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>' },
    { id: 'desempenho', label: 'Desempenho', sub: 'Resultado real e auditável de cada sinal emitido', icon: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>' },
    { id: 'aprendizado', label: 'Aprendizado', sub: 'Tudo o que a IA aprende a cada ciclo de 10 minutos, sem limite', icon: '<path d="M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3zM9 21h6"/>' },
    { id: 'ratings', label: 'Ratings', sub: 'Força de cada equipe calculada pelo modelo', icon: '<path d="M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21.1l1.5-7L2 9.3l7-.8z"/>' },
    { id: 'banca', label: 'Gestão de banca', sub: 'Stake sugerida por Kelly fracionado e simulação da sua banca', icon: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20M6 15h4"/>' },
    { id: 'metodo', label: 'Metodologia', sub: 'Como a IA funciona, de onde vêm os dados e seus limites', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>' },
  ];
  const MARKETS = {
    'soccer:1x2': 'Resultado (1X2)', 'soccer:ou': 'Gols Over/Under',
    'basketball:ml': 'Vencedor (ML)', 'basketball:spread': 'Handicap (Spread)', 'basketball:total': 'Pontos Over/Under',
    'hockey:ml': 'Vencedor (ML)', 'hockey:total': 'Gols Over/Under',
  };
  const SIGNAL_MARKETS = ['soccer:ou', 'basketball:total', 'hockey:total'];
  const SPORTS = { soccer: 'Futebol', basketball: 'Basquete', hockey: 'Hóquei' };
  const isTotal = (k) => k.endsWith(':ou') || k.endsWith(':total');
  const mLabel = (k) => `${MARKETS[k] || k} · ${SPORTS[k.split(':')[0]]}`;
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  // probabilidade de over em várias linhas (normal no basquete; Poisson já calculado no futebol e no hóquei)
  function totalLines(ev) {
    const p = ev.analysis?.pred; if (!p) return [];
    if (ev.sport === 'basketball') {
      const c = Math.floor(p.total) + 0.5;
      return [-10, -7, -5, -3, 0, 3, 5, 7, 10].map((d) => ({ line: c + d, over: 1 - normCdf((c + d - p.total) / p.sigT) }));
    }
    return Object.entries(p.over || {}).map(([l, v]) => ({ line: +l, over: v }));
  }
  const STATUS = { aberto: 'Aberto', travado: 'Em jogo', green: 'Green', red: 'Red', void: 'Devolvido', cancelado: 'Retirado' };

  const D = { meta: null, feed: [], signals: [], learning: { insights: [], params: [] }, ratings: null };
  const live = new Map();
  const ui = {
    tab: TABS.some((t) => t.id === location.hash.slice(1)) ? location.hash.slice(1) : store.get('tab', 'painel'),
    sport: store.get('sport', 'all'),
    sigStatus: 'ativos', sigMarket: 'all', insType: 'all', insQ: '', ratSport: 'soccer', ratLg: 'all', perfScope: 'real',
  };
  const charts = {};

  // ---------- util ----------
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const dt = (iso, opt) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opt }).format(new Date(iso));
  const hm = (iso) => dt(iso, { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (iso) => {
    const k = dt(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = dt(new Date().toISOString(), { year: 'numeric', month: '2-digit', day: '2-digit' });
    const tom = dt(new Date(Date.now() + 864e5).toISOString(), { year: 'numeric', month: '2-digit', day: '2-digit' });
    const yes = dt(new Date(Date.now() - 864e5).toISOString(), { year: 'numeric', month: '2-digit', day: '2-digit' });
    if (k === today) return 'Hoje';
    if (k === tom) return 'Amanhã';
    if (k === yes) return 'Ontem';
    return dt(iso, { weekday: 'long', day: '2-digit', month: 'short' });
  };
  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'agora';
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
    return `há ${Math.floor(s / 86400)} d`;
  };
  const crest = (logo, name) => (logo ? `<img src="${esc(logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'crest',textContent:'${esc((name || '?').slice(0, 2).toUpperCase())}'}))">` : `<span class="crest">${esc((name || '?').slice(0, 2).toUpperCase())}</span>`);
  const sportOk = (s) => ui.sport === 'all' || s === ui.sport;
  const toast = (msg) => {
    const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
    document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  };
  const withLive = (ev) => {
    const l = live.get(ev.id);
    return l ? { ...ev, ...l, home: { ...ev.home, score: l.hs }, away: { ...ev.away, score: l.as } } : ev;
  };

  // ---------- dados ----------
  async function getData(f, fb) {
    try { const r = await fetch(`data/${f}?t=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw 0; return await r.json(); } catch { return fb; }
  }
  async function loadAll() {
    const [meta, feed, signals, learning, ratings] = await Promise.all([
      getData('meta.json', null), getData('feed.json', []), getData('signals.json', []),
      getData('learning.json', { insights: [], params: [] }), getData('ratings.json', null),
    ]);
    const newCycle = D.meta && meta && meta.cycle !== D.meta.cycle;
    Object.assign(D, { meta, feed, signals, learning, ratings });
    render(true);
    if (newCycle) toast(`Ciclo #${meta.cycle} concluído: a IA aprendeu algo novo`);
  }

  // placar ao vivo direto da ESPN (CORS liberado) para ligas com jogos acontecendo agora ou em breve
  async function pollLive() {
    const soon = D.feed.filter((e) => !e.completed && Date.parse(e.date) < Date.now() + 15 * 6e4);
    const leagues = [...new Map(soon.map((e) => [e.league, { sport: e.sport, league: e.league }])).values()];
    await Promise.all(leagues.map(async (lg) => {
      try {
        const r = await fetch(`${ESPN}/${lg.sport}/${lg.league}/scoreboard`);
        if (!r.ok) return;
        const j = await r.json();
        for (const ev of j.events || []) {
          const c = ev.competitions?.[0]; if (!c) continue;
          const h = c.competitors.find((x) => x.homeAway === 'home'), a = c.competitors.find((x) => x.homeAway === 'away');
          const st = c.status?.type || {};
          live.set(`${lg.league}:${ev.id}`, {
            state: st.state, completed: !!st.completed, detail: st.shortDetail || st.detail,
            clock: c.status?.displayClock, period: c.status?.period,
            hs: h?.score !== '' ? Number(h?.score) : null, as: a?.score !== '' ? Number(a?.score) : null, liveAt: Date.now(),
          });
        }
      } catch {}
    }));
    if (['aovivo', 'painel', 'sinais', 'jogos'].includes(ui.tab)) render(true);
  }

  // ---------- métricas ----------
  function perf(list) {
    const settled = list.filter((s) => ['green', 'red', 'void'].includes(s.status)).sort((a, b) => (a.settledAt || a.date).localeCompare(b.settledAt || b.date));
    const gr = settled.filter((s) => s.status === 'green').length, rd = settled.filter((s) => s.status === 'red').length;
    const staked = settled.reduce((a, s) => a + (s.status === 'void' ? 0 : s.stake), 0);
    const profit = settled.reduce((a, s) => a + (s.profit || 0), 0);
    let cum = 0, peak = 0, dd = 0;
    const series = settled.map((s) => { cum += s.profit || 0; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); return { x: s.settledAt || s.date, y: +cum.toFixed(3) }; });
    return {
      n: settled.length, gr, rd, vd: settled.length - gr - rd, hit: gr + rd ? gr / (gr + rd) : null,
      staked, profit, roi: staked ? profit / staked : null, series, dd,
      avgOdd: settled.length ? settled.reduce((a, s) => a + s.odd, 0) / settled.length : null,
      avgEV: settled.length ? settled.reduce((a, s) => a + s.ev, 0) / settled.length : null, settled,
      clv: (() => { const c = settled.filter((s) => s.clv != null); return c.length ? c.reduce((a, s) => a + s.clv, 0) / c.length : null; })(),
    };
  }
  const groupBy = (arr, f) => arr.reduce((m, x) => ((m[f(x)] ??= []).push(x), m), {});

  // ---------- componentes ----------
  function liveSigState(sig, ev) {
    if (!ev || ev.home.score == null) return '';
    const gh = ev.home.score, ga = ev.away.score;
    let ok = null;
    if (sig.marketKey.endsWith('1x2') || sig.marketKey.endsWith(':ml')) ok = (gh > ga ? 'home' : gh < ga ? 'away' : 'draw') === sig.side;
    else if (sig.marketKey.endsWith(':ou') || sig.marketKey.endsWith(':total')) ok = sig.side === 'over' ? gh + ga > sig.line : gh + ga < sig.line;
    else if (sig.marketKey.endsWith(':spread')) ok = (sig.side === 'home' ? gh - ga : ga - gh) + sig.line > 0;
    if (ok == null) return '';
    return `<span class="chip" style="color:var(${ok ? '--good' : '--bad'})">${ok ? 'Batendo agora' : 'Precisa virar'}</span>`;
  }

  function sigCard(s) {
    const ev = D.feed.find((e) => e.id === s.eventId);
    const e = ev ? withLive(ev) : null;
    const showScore = e && e.state !== 'pre' && e.home.score != null;
    const scoreHtml = showScore ? `<div class="sc">${e.home.score} – ${e.away.score}</div><div>${esc(e.detail || '')}</div>` : (s.result ? `<div class="sc">${esc(s.result)}</div><div>final</div>` : `<div>${hm(s.date)}</div><div>${esc(dayLabel(s.date))}</div>`);
    return `<article class="sig" data-sport="${s.sport}">
      <div class="sig-top"><span class="lg"><i></i><span>${esc(s.leagueName)}</span></span><span class="status st-${s.status}">${STATUS[s.status] || s.status}</span></div>
      <div class="match">
        <div class="tm">${crest(s.homeLogo, s.home)}<span>${esc(s.home)}</span></div>
        <div class="vs">${scoreHtml}</div>
        <div class="tm r">${crest(s.awayLogo, s.away)}<span>${esc(s.away)}</span></div>
      </div>
      <div class="pick">
        <div><div class="mk">${esc(s.market)}</div><div class="sel">${esc(s.label)}</div></div>
        <div class="odd">${odd(s.odd)}<small>${esc(s.provider || 'ODD')}</small></div>
      </div>
      <div class="probs">
        <div class="pbar"><span>IA</span><div class="track"><div class="fill" style="width:${(s.p * 100).toFixed(1)}%"></div></div><span class="v">${pct(s.p)}</span></div>
        <div class="pbar"><span>Mercado</span><div class="track"><div class="fill mk" style="width:${(s.pMarket * 100).toFixed(1)}%"></div></div><span class="v">${pct(s.pMarket)}</span></div>
      </div>
      <div class="sig-foot">
        <div class="chips">
          <span class="chip ev">EV ${sgn(s.ev * 100, 1)}%</span>
          <span class="chip">Stake ${s.stake}%</span>
          <span class="chip">Justa ${odd(1 / s.p)}</span>
          ${s.status === 'travado' ? liveSigState(s, e) : ''}
          ${s.profit != null && s.status !== 'cancelado' ? `<span class="chip" style="color:var(${s.profit >= 0 ? '--good' : '--bad'})">${sgn(s.profit)}u</span>` : ''}
        </div>
        <div class="conf" title="Confiança da IA"><span class="conf-ring" style="--v:${s.confidence}"><b>${s.confidence}</b></span></div>
      </div>
      <div class="sig-foot">
        <button class="btn" data-copy="${esc(s.id)}">Copiar sinal</button>
        ${ev ? `<button class="btn" data-open="${esc(ev.id)}">Ver análise</button>` : ''}
      </div>
    </article>`;
  }

  function insightItem(i) {
    const T = { ajuste: 'Ajuste automático', contexto: 'Contexto', conhecimento: 'Conhecimento', treino: 'Treino', memoria: 'Memória', zebra: 'Total fora do esperado', sinal: 'Sinal', peso: 'Peso do modelo', limiar: 'Critério de valor', mercado: 'Mercado', estudo: 'Estudo', resultado: 'Resultados', cancelado: 'Sinal retirado', bootstrap: 'Treino', fonte: 'Fonte de dados' };
    return `<div class="ins" data-type="${esc(i.type)}"><span class="nd"></span><div><div class="tx">${esc(i.text)}</div>
      <div class="when"><span class="tag">${esc(T[i.type] || i.type)}</span><span>ciclo #${i.cycle}</span><span>${dt(i.t, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div></div></div>`;
  }

  function gameRow(ev0) {
    const ev = withLive(ev0);
    const a = ev.analysis;
    const isLive = ev.state === 'in';
    const hasSig = D.signals.some((s) => s.eventId === ev.id && ['aberto', 'travado'].includes(s.status));
    const ctxTag = ev.feat?.miss && (ev.feat.miss.home + ev.feat.miss.away) >= 8 ? '<span style="color:var(--warn)">● desfalques</span>' : ev.feat?.gk ? `<span style="color:var(--hockey)">● goleiros ${Object.values(ev.feat.gk).every((g) => /conf/i.test(g.status)) ? 'confirmados' : 'prováveis'}</span>` : '';
    let tri = '';
    if (a) {
      const p = a.pred;
      const ov = a.markets.find((m) => isTotal(m.marketKey) && m.side === 'over');
      const proj = p.total ?? (p.xgHome + p.xgAway);
      const o = ov ? ov.p : null;
      tri = `<div class="tri"><div><small>PROJ.</small>${proj.toFixed(ev.sport === 'basketball' ? 1 : 2)}</div>${ov ? `<div class="${o >= 0.5 ? 'hot' : ''}"><small>O ${ov.line}</small>${pct(o, 0)}</div><div class="${o < 0.5 ? 'hot' : ''}"><small>U ${ov.line}</small>${pct(1 - o, 0)}</div>` : ''}</div>`;
    } else tri = '<div class="tri"><div><small>IA</small>—</div></div>';
    const when = isLive ? `<span class="live-tag">AO VIVO</span><b>${esc(ev.detail || '')}</b>` : ev.completed ? `<span>Encerrado</span><b>${hm(ev.date)}</b>` : `<span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ev.leagueName)}</span><b>${hm(ev.date)}</b>`;
    const sc = (t) => (ev.state !== 'pre' && t.score != null ? `<span class="s">${t.score}</span>` : '');
    return `<button class="game" data-open="${esc(ev.id)}">
      <div class="when">${when}${hasSig ? '<span style="color:var(--accent)">● sinal</span>' : ''}${ctxTag}</div>
      <div class="teams">
        <div class="row">${crest(ev.home.logo, ev.home.name)}<span>${esc(ev.home.name)}</span>${sc(ev.home)}</div>
        <div class="row">${crest(ev.away.logo, ev.away.name)}<span>${esc(ev.away.name)}</span>${sc(ev.away)}</div>
      </div>${tri}</button>`;
  }

  // ---------- leitura da IA ----------
  function aiRead(ev) {
    const a = ev.analysis; if (!a) return 'Sem projeção salva para este jogo.';
    const p = a.pred, out = [];
    const best = (a.markets || []).filter((m) => SIGNAL_MARKETS.includes(m.marketKey) && m.ev != null && m.pMarket != null).sort((x, y) => y.ev - x.ev)[0];
    if (ev.sport === 'soccer') {
      out.push(`O modelo projeta ${p.xgHome.toFixed(2)} × ${p.xgAway.toFixed(2)} em gols esperados, com ${ev.home.name} vencendo em ${pct(p.home)}, empate em ${pct(p.draw)} e ${ev.away.name} em ${pct(p.away)}.`);
      out.push(`Placar mais provável: ${p.scores?.[0]?.score} (${pct(p.scores?.[0]?.p)}). Ambos marcam: ${pct(p.btts)}. Over 2.5: ${pct(p.over?.['2.5'])}.`);
    } else if (ev.sport === 'hockey') {
      out.push(`Gols esperados no tempo normal: ${p.xgHome.toFixed(2)} × ${p.xgAway.toFixed(2)}. Chance de empate no tempo normal (prorrogação, +1 gol no total): ${pct(p.regDraw)}. Total projetado: ${p.total.toFixed(2)} gols.`);
      out.push(`Over 5.5 em ${pct(p.over?.['5.5'])}, over 6.5 em ${pct(p.over?.['6.5'])}.${p.b2bHome || p.b2bAway ? ` ${p.b2bHome ? ev.home.name : ev.away.name} joga em back-to-back, e a IA considera isso no total.` : ''}`);
    } else {
      const fav = p.margin >= 0 ? ev.home.name : ev.away.name;
      out.push(`Placar projetado ${p.ptsHome.toFixed(0)} – ${p.ptsAway.toFixed(0)}: ${fav} favorito por ${Math.abs(p.margin).toFixed(1)} pontos, total estimado de ${p.total.toFixed(1)}.`);
      out.push(`Desvio típico do total nessa liga: ±${p.sigT.toFixed(1)} pts.${p.b2bHome || p.b2bAway ? ` Back-to-back: ${[p.b2bHome && ev.home.name, p.b2bAway && ev.away.name].filter(Boolean).join(' e ')}.` : ''}`);
    }
    if (best) {
      const diff = best.pModel - best.pMarket;
      out.push(best.ev > 0
        ? `Melhor leitura de total: ${best.label}. O mercado precifica ${pct(best.pMarket)}, a IA estima ${pct(best.p)} (modelo puro ${pct(best.pModel)}). Odd ${odd(best.odd)} contra justa ${odd(best.fair)}: EV ${sgn(best.ev * 100, 1)}%.`
        + (best.ev > 0 && (best.odd > 3.2 || best.odd < 1.4) ? ' Essa odd fica fora da faixa aceita para sinal (1,40 a 3,20), então não vira entrada.' : '')
        : `Total sem valor: o mercado está alinhado com a IA (diferença ${sgn(diff * 100, 1)} p.p.). Sem entrada também é uma decisão.`);
    } else out.push('O provedor ainda não publicou odds para este jogo; a IA mostra apenas as odds justas.');
    if (ev.feat?.miss && (ev.feat.miss.home + ev.feat.miss.away) >= 5) out.push(`Desfalques somam ${(ev.feat.miss.home + ev.feat.miss.away).toFixed(1)} pts por jogo ponderados; total ajustado em ${sgn(p.injTotal, 1)} pts.`);
    if (ev.feat?.gk) out.push(`Goleiros: ${['home', 'away'].filter((sd) => ev.feat.gk[sd]).map((sd) => `${ev.feat.gk[sd].name} (${/conf/i.test(ev.feat.gk[sd].status) ? 'confirmado' : 'provável'})`).join(' × ')}.`);
    if (p.sample < 6) out.push(`Atenção: uma das equipes tem só ${p.sample} jogos na base, então a confiança é menor.`);
    const o = ev.odds;
    if (o?.homeOpen && o?.home && Math.abs(1 / o.homeOpen - 1 / o.home) >= 0.03) out.push(`A linha do mandante se moveu de ${odd(o.homeOpen)} para ${odd(o.home)} desde a abertura.`);
    return out.join(' ');
  }

  function openAnalysis(id) {
    const ev0 = D.feed.find((e) => e.id === id); if (!ev0) return;
    const ev = withLive(ev0), a = ev.analysis, p = a?.pred;
    const sigs = D.signals.filter((s) => s.eventId === id && s.status !== 'cancelado');
    const team = (t) => `<div>${t.logo ? `<img src="${esc(t.logo)}" alt="">` : `<span class="crest" style="width:54px;height:54px;margin:auto">${esc(t.abbr || '')}</span>`}<div class="nm">${esc(t.name)}</div><div class="note">${esc(t.record || '')}</div></div>`;
    const mid = ev.state !== 'pre' && ev.home.score != null ? `<div class="big">${ev.home.score} – ${ev.away.score}</div><div class="note">${esc(ev.detail)}</div>` : `<div class="big" style="font-size:20px">${hm(ev.date)}</div><div class="note">${esc(dayLabel(ev.date))}</div>`;
    let body = '';
    if (p) {
      const c1 = cssVar('--soccer'), c2 = cssVar('--faint'), c3 = cssVar('--bball');
      const split = ev.sport === 'soccer'
        ? `<div class="split"><div style="width:${p.home * 100}%;background:${c1}">${pct(p.home, 0)}</div><div style="width:${p.draw * 100}%;background:${c2}">${pct(p.draw, 0)}</div><div style="width:${p.away * 100}%;background:${c3}">${pct(p.away, 0)}</div></div>`
        : `<div class="split"><div style="width:${p.home * 100}%;background:${c1}">${pct(p.home, 0)}</div><div style="width:${p.away * 100}%;background:${c3}">${pct(p.away, 0)}</div></div>`;
      const minis = ev.sport === 'soccer'
        ? [['xG casa', p.xgHome.toFixed(2)], ['xG fora', p.xgAway.toFixed(2)], ['Gols proj.', (p.xgHome + p.xgAway).toFixed(2)], ['Ambos marcam', pct(p.btts, 0)], ['Over 2.5', pct(p.over['2.5'], 0)], ['Under 2.5', pct(1 - p.over['2.5'], 0)]]
        : ev.sport === 'hockey'
        ? [['xG casa', p.xgHome.toFixed(2)], ['xG fora', p.xgAway.toFixed(2)], ['Gols proj.', p.total.toFixed(2)], ['Prorrogação', pct(p.regDraw, 0)], ['Over 5.5', pct(p.over['5.5'], 0)], ['Over 6.5', pct(p.over['6.5'], 0)]]
        : [['Pontos casa', p.ptsHome.toFixed(1)], ['Pontos fora', p.ptsAway.toFixed(1)], ['Margem', sgn(p.margin, 1)], ['Total', p.total.toFixed(1)], ['Desvio margem', p.sigM.toFixed(1)], ['Desvio total', p.sigT.toFixed(1)]];
      body += `<div class="panel section-gap"><div class="panel-h"><h3>Probabilidades da IA</h3><span class="meta">${ev.sport === 'soccer' ? 'Casa · Empate · Fora' : 'Casa · Fora'}</span></div>${split}
        <div class="mini-grid section-gap">${minis.map(([l, v]) => `<div class="mini"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('')}</div></div>`;
      const tl = totalLines(ev), ln = ev.odds?.totalLine;
      if (tl.length) body += `<div class="panel section-gap"><div class="panel-h"><h3>Linhas de total</h3><span class="meta">modelo puro e odd justa${ln != null ? ` · linha da casa ${ln}` : ''}</span></div><div class="table-wrap"><table>
        <thead><tr><th>Linha</th><th class="n">Over</th><th class="n">Justa over</th><th class="n">Under</th><th class="n">Justa under</th></tr></thead><tbody>
        ${tl.map((r) => `<tr${r.line === ln ? ' style="color:var(--accent)"' : ''}><td class="mono">${r.line}</td><td class="n">${pct(r.over)}</td><td class="n">${odd(1 / r.over)}</td><td class="n">${pct(1 - r.over)}</td><td class="n">${odd(1 / (1 - r.over))}</td></tr>`).join('')}
        </tbody></table></div><p class="note">Compare a odd justa com a da sua casa: só há valor quando a casa paga mais do que a justa.</p></div>`;
      if (p.scores) body += `<div class="panel section-gap"><div class="panel-h"><h3>Placares mais prováveis</h3></div><div class="mini-grid">${p.scores.map((s) => `<div class="mini"><div class="lbl">${s.score}</div><div class="val">${pct(s.p)}</div></div>`).join('')}</div></div>`;
      body += `<div class="panel section-gap"><div class="panel-h"><h3>Mercados: IA × casa</h3><span class="meta">${esc(ev.odds?.provider || 'sem odds publicadas')}</span></div><div class="table-wrap"><table class="mtable">
        <thead><tr><th>Opção</th><th class="n">Modelo</th><th class="n">Mercado</th><th class="n">IA final</th><th class="n">Justa</th><th class="n">Odd</th><th class="n">EV</th></tr></thead><tbody>
        ${a.markets.map((m) => `<tr><td>${esc(m.label)}<div class="note">${esc(m.market)}</div></td><td class="n">${pct(m.pModel)}</td><td class="n">${pct(m.pMarket)}</td><td class="n">${pct(m.p)}</td><td class="n">${odd(m.fair)}</td><td class="n">${odd(m.odd)}</td><td class="n ${m.ev > 0 ? 'pos' : m.ev < 0 ? 'neg' : ''}">${m.ev == null ? '—' : sgn(m.ev * 100, 1) + '%'}</td></tr>`).join('')}
        </tbody></table></div><p class="note">“IA final” combina o modelo próprio com a probabilidade justa do mercado (sem a margem da casa), com pesos que a IA recalibra a cada resultado.</p></div>`;
    }
    const form = (t) => (t.form ? `<span class="form">${[...t.form].map((f) => `<i class="${f}">${f === 'W' ? 'V' : f === 'L' ? 'D' : 'E'}</i>`).join('')}</span>` : '<span class="note">—</span>');
    body += `<div class="panel section-gap"><div class="panel-h"><h3>Forma recente</h3><span class="meta">últimos 5, ESPN</span></div>
      <div style="display:grid;gap:10px"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(ev.home.name)}</b>${form(ev.home)}</div><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(ev.away.name)}</b>${form(ev.away)}</div></div></div>`;
    const f = ev.feat;
    if (f?.inj) {
      const col = (sd) => `<div><b>${esc(ev[sd].name)}</b>${(f.inj[sd] || []).length ? `<div class="table-wrap"><table><tbody>${f.inj[sd].map((x) => `<tr><td>${esc(x.name)}<div class="note">${x.status === 'Out' ? 'Fora' : x.status === 'Day-To-Day' ? 'Dúvida (dia a dia)' : esc(x.status)}</div></td><td class="n">${x.pts.toFixed(1)} pts</td><td class="n" title="peso no ajuste">${Math.round(x.w * 100)}%</td></tr>`).join('')}</tbody></table></div>` : '<div class="note">Sem desfalques relevantes.</div>'}</div>`;
      body += `<div class="panel section-gap"><div class="panel-h"><h3>Desfalques</h3><span class="meta">ajuste no total: ${p?.injTotal != null ? sgn(p.injTotal, 1) + ' pts' : '—'}</span></div><div class="cols-2e">${col('home')}${col('away')}</div>
        <p class="note">Peso = status (fora ou dúvida) × quanto o rating do time ainda não absorveu a ausência. Depois de ~15 jogos sem o jogador, o próprio rating já reflete a falta dele.</p></div>`;
    }
    if (f?.gk) {
      const g = (sd) => { const x = f.gk[sd]; return x ? `<div class="mini"><div class="lbl">${esc(ev[sd].short || ev[sd].name)} · ${/conf/i.test(x.status) ? 'confirmado' : 'provável'}</div><div class="val" style="font-size:15px">${esc(x.name)}</div><div class="note">SV% ajustado ${x.sv ? (x.sv * 100).toFixed(1) : '—'}</div></div>` : ''; };
      body += `<div class="panel section-gap"><div class="panel-h"><h3>Goleiros titulares</h3><span class="meta">efeito nos gols: ${p?.gkEffect != null ? sgn(p.gkEffect * 100, 1) + '%' : '—'}</span></div><div class="mini-grid">${g('home')}${g('away')}</div>
        <p class="note">SV% da temporada combinado com o da carreira, para não superestimar goleiros com poucos jogos. Goleiro pior que a média aumenta os gols esperados do adversário.</p></div>`;
    }
    if (sigs.length) body += `<div class="section-gap"><div class="signals">${sigs.map(sigCard).join('')}</div></div>`;
    $('#drawer-root').innerHTML = `<div class="drawer-back" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Análise da partida">
      <button class="icon-btn close" data-close aria-label="Fechar">✕</button>
      <div class="note">${esc(ev.leagueName)}${ev.venue ? ' · ' + esc(ev.venue) : ''}</div>
      <h2>${esc(ev.home.name)} × ${esc(ev.away.name)}</h2>
      <div class="ana-head">${team(ev.home)}<div>${mid}</div>${team(ev.away)}</div>
      <div class="read"><div class="tag" style="margin-bottom:6px;color:var(--accent)">Leitura da IA</div>${esc(aiRead(ev))}</div>${body}</aside>`;
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() { $('#drawer-root').innerHTML = ''; document.body.style.overflow = ''; }

  // ---------- views ----------
  const V = {};

  V.painel = () => {
    const real = D.signals.filter((s) => sportOk(s.sport));
    const P = perf(real);
    const open = real.filter((s) => s.status === 'aberto').sort((a, b) => b.ev - a.ev);
    const liveNow = D.feed.map(withLive).filter((e) => e.state === 'in' && sportOk(e.sport));
    const ins = D.learning.insights.slice(-8).reverse();
    const mem = D.meta?.memory ? Object.values(D.meta.memory) : [];
    const memPct = mem.length ? mem.reduce((a, c) => a + c.pct, 0) / mem.length : 0;
    return `<div class="kpis">
      <div class="kpi"><div class="lbl">Sinais abertos</div><div class="val">${open.length}</div><div class="hint">${real.filter((s) => s.status === 'travado').length} em andamento</div></div>
      <div class="kpi"><div class="lbl">Taxa de acerto</div><div class="val">${pct(P.hit)}</div><div class="hint">${P.gr} green · ${P.rd} red</div></div>
      <div class="kpi"><div class="lbl">ROI</div><div class="val ${P.roi > 0 ? 'pos' : P.roi < 0 ? 'neg' : ''}">${P.roi == null ? '—' : sgn(P.roi * 100, 1) + '%'}</div><div class="hint">${P.n} sinais liquidados</div></div>
      <div class="kpi"><div class="lbl">Lucro</div><div class="val ${P.profit > 0 ? 'pos' : P.profit < 0 ? 'neg' : ''}">${sgn(P.profit)}u</div><div class="hint">1u = 1% da banca</div></div>
      <div class="kpi"><div class="lbl">Memória histórica</div><div class="val">${(D.meta?.memoryGames ?? 0).toLocaleString('pt-BR')}</div><div class="hint">${D.meta?.fullyTrained ? 'treino completo' : `coletando · ${pct(memPct, 0)}`} · ${D.meta?.teamsKnown ?? 0} equipes</div></div>
      <div class="kpi"><div class="lbl">Lições aprendidas</div><div class="val">${D.learning.insights.length.toLocaleString('pt-BR')}</div><div class="hint">ciclo #${D.meta?.cycle ?? '—'}</div></div>
    </div>
    <div class="cols-2">
      <div class="panel"><div class="panel-h"><h2>Melhores sinais agora</h2><button class="btn" data-tab="sinais">Ver todos</button></div>
        ${open.length ? `<div class="signals">${open.slice(0, 4).map(sigCard).join('')}</div>` : `<div class="empty"><b>Nenhum sinal aberto neste momento</b>A IA só emite sinal quando a odd paga mais do que a probabilidade real. Próxima varredura em <span class="mono" data-countdown>—</span>.</div>`}
      </div>
      <div class="grid">
        <div class="panel"><div class="panel-h"><h2>Ao vivo</h2><span class="meta">${liveNow.length} jogo(s)</span></div>
          ${liveNow.length ? `<div class="games">${liveNow.slice(0, 5).map(gameRow).join('')}</div>` : '<div class="note">Nenhum jogo monitorado em andamento agora.</div>'}</div>
        <div class="panel"><div class="panel-h"><h2>Aprendeu agora</h2><button class="btn" data-tab="aprendizado">Linha do tempo</button></div>
          <div class="timeline">${ins.map(insightItem).join('') || '<div class="note">Aguardando o primeiro ciclo.</div>'}</div></div>
      </div>
    </div>`;
  };

  V.sinais = () => {
    const groups = { ativos: ['aberto', 'travado'], encerrados: ['green', 'red', 'void'], retirados: ['cancelado'], todos: null };
    let list = D.signals.filter((s) => sportOk(s.sport) && (!groups[ui.sigStatus] || groups[ui.sigStatus].includes(s.status)) && (ui.sigMarket === 'all' || s.marketKey === ui.sigMarket));
    list = ui.sigStatus === 'ativos' ? list.sort((a, b) => a.date.localeCompare(b.date)) : list.sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="filters">
      <div class="seg" id="sig-status">${Object.keys(groups).map((k) => `<button data-v="${k}" aria-pressed="${ui.sigStatus === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <select id="sig-market" aria-label="Mercado"><option value="all">Todos os mercados</option>${SIGNAL_MARKETS.map((k) => `<option value="${k}" ${ui.sigMarket === k ? 'selected' : ''}>${mLabel(k)}</option>`).join('')}</select>
      <span class="note">Sinais só em totais (mais/menos). EV mínimo atual: ${SIGNAL_MARKETS.map((k) => `${SPORTS[k.split(':')[0]]} ${pct(D.ratings?.learned?.minEV?.[k], 1)}`).join(' · ')}</span>
    </div>
    ${list.length ? `<div class="signals">${list.slice(0, 120).map(sigCard).join('')}</div>` : `<div class="empty"><b>Nenhum sinal nesta lista</b>Sinais aparecem quando a probabilidade da IA supera a probabilidade implícita na odd por uma margem segura. A IA verifica de novo em <span class="mono" data-countdown>—</span>.</div>`}`;
  };

  V.aovivo = () => {
    const evs = D.feed.map(withLive).filter((e) => sportOk(e.sport));
    const now = evs.filter((e) => e.state === 'in');
    const next = evs.filter((e) => e.state === 'pre' && Date.parse(e.date) < Date.now() + 6 * 36e5).sort((a, b) => a.date.localeCompare(b.date));
    const done = evs.filter((e) => e.state === 'post').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
    const lastPoll = Math.max(0, ...[...live.values()].map((l) => l.liveAt || 0));
    return `<div class="note" style="margin-bottom:12px">Placar consultado na ESPN a cada 30 s ${lastPoll ? '· última leitura ' + ago(new Date(lastPoll).toISOString()) : ''}</div>
      <div class="panel"><div class="panel-h"><h2>Em andamento</h2><span class="meta">${now.length}</span></div>${now.length ? `<div class="games">${now.map(gameRow).join('')}</div>` : '<div class="note">Nenhum jogo das ligas monitoradas em andamento.</div>'}</div>
      <div class="cols-2e section-gap">
        <div class="panel"><div class="panel-h"><h2>Próximas 6 horas</h2></div>${next.length ? `<div class="games">${next.map(gameRow).join('')}</div>` : '<div class="note">Sem jogos nas próximas horas.</div>'}</div>
        <div class="panel"><div class="panel-h"><h2>Encerrados recentes</h2></div>${done.length ? `<div class="games">${done.map(gameRow).join('')}</div>` : '<div class="note">Nada encerrado nas últimas 36 h.</div>'}</div>
      </div>`;
  };

  V.jogos = () => {
    const evs = D.feed.map(withLive).filter((e) => sportOk(e.sport) && e.state !== 'post').sort((a, b) => a.date.localeCompare(b.date));
    if (!evs.length) return '<div class="empty"><b>Sem jogos na janela atual</b>A IA coleta os próximos 3 dias das ligas monitoradas a cada ciclo.</div>';
    const byDay = groupBy(evs, (e) => dayLabel(e.date));
    return Object.entries(byDay).map(([d, list]) => `<div class="day-h">${esc(d)} · ${list.length} jogos</div><div class="games">${list.map(gameRow).join('')}</div>`).join('');
  };

  V.desempenho = () => {
    const base = ui.perfScope === 'real' ? D.signals : (D.backtest || []);
    const list = base.filter((s) => sportOk(s.sport));
    const P = perf(list);
    const table = (groups, labelFn) => `<div class="table-wrap"><table><thead><tr><th></th><th class="n">Sinais</th><th class="n">Acerto</th><th class="n">Odd méd.</th><th class="n">Lucro</th><th class="n">ROI</th></tr></thead><tbody>
      ${Object.entries(groups).map(([k, arr]) => { const q = perf(arr); return q.n ? `<tr><td>${esc(labelFn(k))}</td><td class="n">${q.n}</td><td class="n">${pct(q.hit)}</td><td class="n">${odd(q.avgOdd)}</td><td class="n ${q.profit >= 0 ? 'pos' : 'neg'}">${sgn(q.profit)}u</td><td class="n ${q.roi >= 0 ? 'pos' : 'neg'}">${q.roi == null ? '—' : sgn(q.roi * 100, 1) + '%'}</td></tr>` : ''; }).join('') || '<tr><td colspan="6" class="note">Sem sinais liquidados ainda.</td></tr>'}
      </tbody></table></div>`;
    const confB = (s) => (s.confidence >= 75 ? 'Alta (75+)' : s.confidence >= 55 ? 'Média (55–74)' : 'Baixa (<55)');
    return `<div class="filters"><div class="seg" id="perf-scope"><button data-v="real" aria-pressed="${ui.perfScope === 'real'}">Sinais reais</button><button data-v="bt" aria-pressed="${ui.perfScope === 'bt'}">Backtest</button></div>
      <span class="note">Cada sinal é registrado com a odd do momento e liquidado automaticamente pelo placar oficial.</span></div>
      <div class="kpis">
        <div class="kpi"><div class="lbl">Liquidados</div><div class="val">${P.n}</div><div class="hint">${P.vd} devolvidos</div></div>
        <div class="kpi"><div class="lbl">Acerto</div><div class="val">${pct(P.hit)}</div><div class="hint">${P.gr} G · ${P.rd} R</div></div>
        <div class="kpi"><div class="lbl">Lucro</div><div class="val ${P.profit >= 0 ? 'pos' : 'neg'}">${sgn(P.profit)}u</div><div class="hint">${P.staked.toFixed(1)}u apostadas</div></div>
        <div class="kpi"><div class="lbl">ROI</div><div class="val ${P.roi >= 0 ? 'pos' : 'neg'}">${P.roi == null ? '—' : sgn(P.roi * 100, 1) + '%'}</div><div class="hint">odd média ${odd(P.avgOdd)}</div></div>
        <div class="kpi"><div class="lbl">CLV médio</div><div class="val ${P.clv > 0 ? 'pos' : P.clv < 0 ? 'neg' : ''}">${P.clv == null ? '—' : sgn(P.clv * 100, 1) + '%'}</div><div class="hint">odd do sinal × fechamento</div></div>
        <div class="kpi"><div class="lbl">Rebaixamento máx.</div><div class="val neg">${P.dd.toFixed(2)}u</div><div class="hint">pior sequência</div></div>
      </div>
      <div class="panel"><div class="panel-h"><h2>Lucro acumulado (unidades)</h2></div>${P.series.length ? '<div class="chart-box"><canvas id="ch-profit"></canvas></div>' : '<div class="empty"><b>O gráfico aparece com o primeiro sinal liquidado</b>Os sinais abertos são encerrados automaticamente quando o jogo termina.</div>'}</div>
      <div class="cols-2e section-gap">
        <div class="panel"><div class="panel-h"><h3>Por mercado</h3></div>${table(groupBy(list, (s) => s.marketKey), (k) => mLabel(k))}</div>
        <div class="panel"><div class="panel-h"><h3>Por confiança</h3></div>${table(groupBy(list, confB), (k) => k)}</div>
      </div>
      <div class="panel section-gap"><div class="panel-h"><h3>Por liga</h3></div>${table(groupBy(list, (s) => s.leagueName), (k) => k)}</div>
      <div class="panel section-gap"><div class="panel-h"><h3>Calibração do modelo</h3><span class="meta">previsto × ocorrido, todos os mercados</span></div><div class="chart-box"><canvas id="ch-calib"></canvas></div></div>
      <div class="panel section-gap"><div class="panel-h"><h3>Histórico</h3><span class="meta">${P.settled.length} registros</span></div><div class="table-wrap"><table><thead><tr><th>Data</th><th>Jogo</th><th>Entrada</th><th class="n">Odd</th><th class="n">Stake</th><th>Placar</th><th>Status</th><th class="n">Resultado</th></tr></thead><tbody>
        ${P.settled.slice(-200).reverse().map((s) => `<tr><td class="mono">${dt(s.date, { day: '2-digit', month: '2-digit' })}</td><td>${esc(s.home)} × ${esc(s.away)}<div class="note">${esc(s.leagueName)}</div></td><td>${esc(s.label)}<div class="note">${esc(s.market)}</div></td><td class="n">${odd(s.odd)}</td><td class="n">${s.stake}%</td><td class="mono">${esc(s.result || '')}</td><td><span class="status st-${s.status}">${STATUS[s.status]}</span></td><td class="n ${s.profit >= 0 ? 'pos' : 'neg'}">${sgn(s.profit)}u</td></tr>`).join('') || '<tr><td colspan="8" class="note">Ainda sem histórico.</td></tr>'}
      </tbody></table></div></div>`;
  };

  V.aprendizado = () => {
    const types = ['all', 'ajuste', 'contexto', 'conhecimento', 'treino', 'memoria', 'estudo', 'resultado', 'zebra', 'peso', 'limiar', 'mercado', 'sinal'];
    const L = { all: 'Tudo', ajuste: 'Ajuste automático', contexto: 'Desfalques e goleiros', conhecimento: 'Conhecimento', treino: 'Treinos', memoria: 'Memória', estudo: 'Estudos', resultado: 'Resultados', zebra: 'Totais fora do esperado', peso: 'Pesos', limiar: 'Critérios', mercado: 'Mercado', sinal: 'Sinais' };
    const q = ui.insQ.toLowerCase();
    const list = D.learning.insights.filter((i) => (ui.insType === 'all' || i.type === ui.insType) && (!q || i.text.toLowerCase().includes(q))).slice().reverse();
    const st = D.ratings?.stats || {};
    return `<div class="kpis">
        <div class="kpi"><div class="lbl">Lições registradas</div><div class="val">${D.learning.insights.length.toLocaleString('pt-BR')}</div><div class="hint">${(D.learning.archived || []).length} arquivo(s) históricos</div></div>
        <div class="kpi"><div class="lbl">Ciclos de aprendizado</div><div class="val">${D.meta?.cycle ?? 0}</div><div class="hint">1 a cada 10 min</div></div>
        <div class="kpi"><div class="lbl">Próximo ciclo</div><div class="val" data-countdown>—</div><div class="hint">${D.meta?.lastCycle ? 'último ' + ago(D.meta.lastCycle) : ''}</div></div>
        <div class="kpi"><div class="lbl">Jogos na memória</div><div class="val">${(D.meta?.gamesLearned ?? 0).toLocaleString('pt-BR')}</div><div class="hint">resultados incorporados</div></div>
      </div>
      <div class="cols-2">
        <div class="panel"><div class="panel-h"><h2>Linha do tempo</h2><span class="meta">${list.length} itens</span></div>
          <div class="filters"><select id="ins-type" aria-label="Tipo">${types.map((t) => `<option value="${t}" ${ui.insType === t ? 'selected' : ''}>${L[t]}</option>`).join('')}</select>
          <input type="search" id="ins-q" placeholder="Buscar time, liga, mercado…" value="${esc(ui.insQ)}"></div>
          <div class="timeline">${list.slice(0, 300).map(insightItem).join('') || '<div class="note">Nada encontrado.</div>'}</div></div>
        <div class="grid" style="align-content:start">
          ${tuningPanel()}
          ${knowledgePanel()}
          <div class="panel"><div class="panel-h"><h3>Peso do modelo próprio</h3><span class="meta">o restante vem do mercado</span></div><div class="chart-box" style="height:220px"><canvas id="ch-blend"></canvas></div></div>
          <div class="panel"><div class="panel-h"><h3>Parâmetros atuais</h3></div><div class="table-wrap"><table><thead><tr><th>Mercado</th><th class="n">Peso IA</th><th class="n">EV mín.</th><th class="n">Jogos</th></tr></thead><tbody>
            ${SIGNAL_MARKETS.map((k) => `<tr><td>${mLabel(k)}</td><td class="n">${pct(D.ratings?.learned?.blend?.[k])}</td><td class="n">${pct(D.ratings?.learned?.minEV?.[k])}</td><td class="n">${st[k]?.n ?? 0}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="note">Peso e EV mínimo mudam sozinhos: o peso por gradiente de log-loss a cada resultado, o EV mínimo pelo ROI real das últimas entradas.</p></div>
        </div>
      </div>`;
  };

  function tuningPanel() {
    const T = D.meta?.tuning || {}, H = D.meta?.hyper || {};
    const NAME = { lrMul: 'Velocidade de aprendizado', kMul: 'Velocidade de aprendizado', wGoal: 'Peso do gol real', wLuck: 'Sorte no arremesso mantida' };
    const rows = Object.entries(SPORTS).filter(([sp]) => sportOk(sp)).map(([sp, nm]) => {
      const t = T[sp];
      if (!t) return `<tr><td>${nm}</td><td colspan="4" class="note">Aguardando a memória completa deste esporte.</td></tr>`;
      const gain = (t.base.ll - t.best.ll) / t.base.ll;
      const hp = H[sp] || t.best.hp;
      return `<tr><td>${nm}<div class="note">${t.games.toLocaleString('pt-BR')} jogos · ${t.withStats.toLocaleString('pt-BR')} com estatísticas</div></td>
        <td>${Object.entries(hp).map(([k, v]) => `${NAME[k]}: <b class="mono">${v}</b>`).join('<br>')}</td>
        <td class="n">${t.best.mae.toFixed(2)}</td><td class="n ${gain > 0 ? 'pos' : ''}">${gain > 0 ? '−' + (gain * 100).toFixed(2) + '%' : '0%'}</td><td class="mono" style="font-size:12px">${ago(t.at)}</td></tr>`;
    }).join('');
    return `<div class="panel"><div class="panel-h"><h3>Ajuste automático</h3><span class="meta">melhor combinação de parâmetros na memória</span></div>
      <div class="table-wrap"><table><thead><tr><th>Esporte</th><th>Parâmetros escolhidos</th><th class="n">Erro médio do total</th><th class="n">vs padrão</th><th>Quando</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="note">A IA reaprende a memória com várias combinações e mede o erro do total só nos 40% de jogos mais recentes, que ela ainda não tinha visto. Fica com a combinação que erra menos e repete o teste 1 vez por dia.${D.meta?.statsPendingDays ? ` Ainda faltam estatísticas de ${D.meta.statsPendingDays} dias antigos; até lá o peso das finalizações é testado só nos jogos recentes.` : ''}</p></div>`;
  }

  function knowledgePanel() {
    const K = D.ratings?.knowledge?.leagues || {}, M = D.meta?.memory || {};
    const lgs = (D.meta?.leagues || []).filter((l) => sportOk(l.sport));
    const cell = (k) => !k ? '—' : k.sport === 'soccer' ? `O2.5 ${pct(k.o25, 0)} · O3.5 ${pct(k.o35, 0)}` : k.sport === 'hockey' ? `O5.5 ${pct(k.o55, 0)} · O6.5 ${pct(k.o65, 0)}` : `±10 de ${k.avg}: ${pct(k.within10, 0)}`;
    return `<div class="panel"><div class="panel-h"><h3>Base de conhecimento</h3><span class="meta">${D.meta?.fullyTrained ? 'memória completa' : 'memória sendo coletada'}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Liga</th><th class="n">Jogos</th><th class="n">Média</th><th>Totais</th><th style="min-width:70px">Memória</th></tr></thead><tbody>
      ${lgs.map((l) => { const k = K[l.slug], m = M[l.slug]; return `<tr><td>${esc(l.name)}</td><td class="n">${m?.games ?? 0}</td><td class="n">${k ? k.avg : '—'}</td><td class="mono" style="font-size:12px">${cell(k)}</td><td><div class="meter" title="${pct(m?.pct ?? 0, 0)}"><i style="width:${((m?.pct ?? 0) * 100).toFixed(0)}%"></i></div></td></tr>`; }).join('')}
      </tbody></table></div><p class="note">${(D.meta?.memoryWithOdds ?? 0).toLocaleString('pt-BR')} jogos já têm odds de fechamento guardadas, base do backtest real na aba Desempenho. Estatísticas medidas em todos os jogos guardados de cada liga. A memória é baixada aos poucos da ESPN e, quando completa, a IA se retreina inteira em ordem cronológica.</p></div>`;
  }

  V.ratings = () => {
    const R = D.ratings; if (!R) return '<div class="empty"><b>Ratings indisponíveis</b></div>';
    const sp = ui.sport === 'all' ? ui.ratSport : ui.sport;
    const lgs = (D.meta?.leagues || []).filter((l) => l.sport === sp && !/uefa|conmebol/.test(l.slug));
    const form = (f) => (f?.length ? `<span class="form">${f.map((x) => `<i class="${x}">${x === 'W' ? 'V' : x === 'L' ? 'D' : 'E'}</i>`).join('')}</span>` : '');
    const seg = ui.sport === 'all' ? `<div class="seg" id="rat-sport">${Object.entries(SPORTS).map(([k, v]) => `<button data-v="${k}" aria-pressed="${sp === k}">${v}</button>`).join('')}</div>` : '';
    const sel = `<select id="rat-lg" aria-label="Liga"><option value="all">Todas as ligas</option>${lgs.map((l) => `<option value="${l.slug}" ${ui.ratLg === l.slug ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
    if (sp === 'soccer' || sp === 'hockey') {
      const rows = (R[sp] || []).filter((t) => ui.ratLg === 'all' || t.lg === ui.ratLg);
      return `<div class="filters">${seg}${sel}<span class="note">Ataque e defesa em % relativo à média da liga · Poder = ataque − defesa</span></div>
        <div class="panel"><div class="table-wrap"><table><thead><tr><th>#</th><th>Equipe</th><th class="n">Poder</th><th class="n">Ataque</th><th class="n">Defesa (gols sofridos)</th><th class="n">Total médio</th><th class="n">Jogos</th><th>Forma</th></tr></thead><tbody>
        ${rows.map((t, i) => `<tr><td class="mono">${i + 1}</td><td><b>${esc(t.name)}</b></td><td class="n">${sgn(t.power, 3)}</td><td class="n ${t.att >= 0 ? 'pos' : 'neg'}">${sgn((Math.exp(t.att) - 1) * 100, 0)}%</td><td class="n ${t.def <= 0 ? 'pos' : 'neg'}">${sgn((Math.exp(t.def) - 1) * 100, 0)}%</td><td class="n">${t.tot ?? '—'}</td><td class="n">${t.n}</td><td>${form(t.form)}</td></tr>`).join('') || '<tr><td colspan="8" class="note">Sem equipes com jogos suficientes nesta liga.</td></tr>'}
        </tbody></table></div></div>`;
    }
    const rows = R.basketball.filter((t) => ui.ratLg === 'all' || t.lg === ui.ratLg);
    return `<div class="filters">${seg}${sel}<span class="note">Rating líquido em pontos contra um time médio em quadra neutra · Ritmo = efeito no total de pontos</span></div>
      <div class="panel"><div class="table-wrap"><table><thead><tr><th>#</th><th>Equipe</th><th>Liga</th><th class="n">Rating</th><th class="n">Ritmo</th><th class="n">Total médio</th><th class="n">Jogos</th><th>Forma</th></tr></thead><tbody>
      ${rows.map((t, i) => `<tr><td class="mono">${i + 1}</td><td><b>${esc(t.name)}</b></td><td>${esc((t.lg || '').toUpperCase())}</td><td class="n ${t.r >= 0 ? 'pos' : 'neg'}">${sgn(t.r, 1)}</td><td class="n">${sgn(t.t, 1)}</td><td class="n">${t.tot ?? '—'}</td><td class="n">${t.n}</td><td>${form(t.form)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  };

  V.banca = () => {
    const bank = Number(store.get('bank', 1000));
    const open = D.signals.filter((s) => s.status === 'aberto' && sportOk(s.sport));
    const P = perf(D.signals);
    let b = bank; const sim = P.settled.map((s) => { b += b * (s.profit / 100); return b; });
    const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    return `<div class="cols-2">
      <div class="panel"><div class="panel-h"><h2>Stakes para os sinais abertos</h2></div>
        <div class="filters field"><label for="bank" class="note">Sua banca (R$)</label><input id="bank" type="number" min="0" step="50" value="${bank}" inputmode="decimal" style="max-width:180px"></div>
        <div class="table-wrap"><table><thead><tr><th>Jogo</th><th>Entrada</th><th class="n">Odd</th><th class="n">Stake</th><th class="n">Valor</th><th class="n">Retorno</th></tr></thead><tbody>
        ${open.map((s) => `<tr><td>${esc(s.home)} × ${esc(s.away)}<div class="note">${hm(s.date)} · ${esc(dayLabel(s.date))}</div></td><td>${esc(s.label)}</td><td class="n">${odd(s.odd)}</td><td class="n">${s.stake}%</td><td class="n">${brl(bank * s.stake / 100)}</td><td class="n">${brl(bank * s.stake / 100 * s.odd)}</td></tr>`).join('') || '<tr><td colspan="6" class="note">Nenhum sinal aberto agora.</td></tr>'}
        </tbody></table></div>
        <p class="note">Stake = ¼ do critério de Kelly, limitada a 3% da banca por entrada. Exposição total aberta: ${open.reduce((a, s) => a + s.stake, 0).toFixed(2)}% (${brl(bank * open.reduce((a, s) => a + s.stake, 0) / 100)}).</p></div>
      <div class="grid" style="align-content:start">
        <div class="panel"><div class="panel-h"><h3>Simulação</h3><span class="meta">seguindo todos os sinais liquidados</span></div>
          <div class="mini-grid"><div class="mini"><div class="lbl">Banca inicial</div><div class="val">${brl(bank)}</div></div><div class="mini"><div class="lbl">Banca hoje</div><div class="val ${(sim.at(-1) ?? bank) >= bank ? 'pos' : 'neg'}">${brl(sim.at(-1) ?? bank)}</div></div></div></div>
        <div class="warn-box"><b>Regras de proteção</b><br>Nunca aposte dinheiro que vai fazer falta. Defina um limite de perda por semana e pare ao atingi-lo. Nenhum modelo acerta sempre; sequências de reds acontecem mesmo com valor esperado positivo. Proibido para menores de 18 anos.</div>
      </div></div>`;
  };

  V.metodo = () => `<div class="cols-2"><div class="panel prose">
      <h3 style="margin-top:0">De onde vêm os dados</h3>
      <p>Jogos, placares, forma e odds de referência vêm da API pública da ESPN (<code>site.api.espn.com</code>), a mesma usada pelo site da ESPN. As odds exibidas são do provedor que a ESPN mostra em cada jogo (normalmente DraftKings). O placar ao vivo é lido direto da ESPN pelo seu navegador a cada 30 segundos.</p>
      <h3>Como a IA calcula</h3>
      <p><b>Foco em totais:</b> os sinais saem só em mais/menos (over/under) do total da partida, nos três esportes. Vencedor e handicap continuam calculados na análise de cada jogo, mas não geram sinal.</p>
      <p><b>Futebol:</b> modelo de Poisson bivariado com correção Dixon-Coles. Cada time tem força de ataque e de defesa; cada liga tem média de gols de mandante e visitante. Daí saem gols esperados, matriz de placares, 1X2, over/under e ambos marcam.</p>
      <p><b>Basquete:</b> rating de margem e de ritmo por time, vantagem de mando por liga e desvio-padrão aprendido. Margem e total projetados viram probabilidades pela distribuição normal, para vencedor, spread e total.</p>
      <p><b>Hóquei (NHL):</b> Poisson para os gols do tempo normal de cada time. Empate no tempo normal leva a prorrogação/shootout e soma exatamente 1 gol ao total, como as casas contam. A IA também mede quanto um back-to-back muda os gols sofridos.</p>
      <p><b>Memória e conhecimento:</b> todos os jogos encerrados desde a temporada passada ficam guardados em <code>docs/data/history/</code>. A IA começa com princípios de mercado e médias conhecidas de cada liga, substitui tudo pelo que mede nos dados e se retreina do zero quando a memória completa.</p>
      <p><b>Finalizações e sorte:</b> gol é raro e tem muita sorte; quem cria chances continua criando. Por isso os ratings aprendem com uma mistura do placar com os gols esperados pelas finalizações (chutes e chutes no gol no futebol, chutes a gol no hóquei). No basquete, a IA desconta a sorte no aproveitamento de 3 pontos e de lances livres.</p>
      <p><b>Ajuste automático:</b> 1 vez por dia, a IA testa várias combinações de parâmetros reaprendendo toda a memória e mede o erro do total nos jogos mais recentes, que ela não tinha visto. Fica com a combinação que erra menos.</p>
      <p><b>Mercado:</b> a probabilidade justa da casa é obtida removendo a margem. A probabilidade final mistura modelo e mercado com um peso que a própria IA ajusta.</p>
      <h3>Quando sai um sinal</h3>
      <p>Valor esperado = probabilidade × odd − 1. O sinal sai em linhas .5 quando o EV passa do mínimo do mercado e a odd está entre 1,40 e 3,20. A stake é ¼ de Kelly, com teto de 3%. A odd do sinal fica registrada no momento da emissão e todo sinal emitido conta no desempenho. A IA acompanha a odd até o início do jogo para medir o CLV (se você pegou preço melhor que o de fechamento). O sinal é liquidado automaticamente pelo placar final.</p>
      <h3>Aprendizado a cada 10 minutos</h3>
      <p>Em cada ciclo a IA: coleta a janela de jogos; incorpora resultados novos aos ratings; compara a precisão do modelo com a do mercado (log-loss) e ajusta o peso de cada um; revisa o EV mínimo de cada mercado pelo ROI real; mede a calibração; e registra as lições na linha do tempo. O histórico de lições não tem limite: quando cresce, é arquivado por mês.</p>
      <h3>Onde fica salvo</h3>
      <p>O cérebro (ratings, pesos, calibração), os sinais e as lições ficam em arquivos JSON versionados no repositório do GitHub. O GitHub Actions roda o ciclo e salva cada versão, então nada se perde e todo o histórico pode ser auditado.</p>
    </div>
    <div class="grid" style="align-content:start">
      <div class="warn-box"><b>Limites honestos</b><br>Nenhuma IA garante acerto. O mercado de apostas é eficiente: o objetivo é achar desvios pequenos e repetidos, e o resultado só aparece no longo prazo. Use a aba Desempenho, que mostra todo sinal emitido, para julgar a IA por números reais.</div>
      <div class="panel"><div class="panel-h"><h3>Ligas monitoradas</h3></div><div class="chips">${(D.meta?.leagues || []).map((l) => `<span class="chip">${esc(l.name)}</span>`).join('')}</div></div>
      <div class="warn-box">Aposte apenas em casas licenciadas no seu país. No Brasil, a lista de operadoras autorizadas é publicada pelo Ministério da Fazenda (SPA). Jogo responsável: proibido para menores de 18 anos.</div>
    </div></div>`;

  // ---------- gráficos ----------
  function drawCharts() {
    if (!window.Chart) return;
    for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
    const fg = cssVar('--muted'), grid = cssVar('--line'), acc = cssVar('--accent');
    Chart.defaults.color = fg; Chart.defaults.font.family = cssVar('--f-body'); Chart.defaults.borderColor = grid;
    const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: grid } }, y: { grid: { color: grid } } } };
    const cp = $('#ch-profit');
    if (cp) {
      const list = (ui.perfScope === 'real' ? D.signals : D.backtest || []).filter((s) => sportOk(s.sport));
      const s = perf(list).series;
      charts.p = new Chart(cp, { type: 'line', data: { labels: s.map((p) => dt(p.x, { day: '2-digit', month: '2-digit' })), datasets: [{ data: s.map((p) => p.y), borderColor: acc, backgroundColor: acc + '22', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 }] }, options: base });
    }
    const cc = $('#ch-calib');
    if (cc && D.ratings?.calib) {
      const sets = Object.entries(D.ratings.calib).filter(([sp]) => sportOk(sp)).map(([sp, b]) => ({
        label: SPORTS[sp], borderColor: cssVar({ soccer: '--soccer', basketball: '--bball', hockey: '--hockey' }[sp]), backgroundColor: cssVar({ soccer: '--soccer', basketball: '--bball', hockey: '--hockey' }[sp]),
        data: b.filter((x) => x.n >= 15).map((x) => ({ x: +(x.sumP / x.n * 100).toFixed(1), y: +(x.hits / x.n * 100).toFixed(1) })), showLine: true, tension: .2, pointRadius: 3,
      }));
      sets.push({ label: 'Perfeito', data: [{ x: 0, y: 0 }, { x: 100, y: 100 }], borderColor: grid, borderDash: [4, 4], pointRadius: 0, showLine: true });
      charts.c = new Chart(cc, { type: 'scatter', data: { datasets: sets }, options: { ...base, plugins: { legend: { display: true } }, scales: { x: { min: 0, max: 100, title: { display: true, text: 'Previsto (%)' }, grid: { color: grid } }, y: { min: 0, max: 100, title: { display: true, text: 'Ocorreu (%)' }, grid: { color: grid } } } } });
    }
    const cb = $('#ch-blend');
    if (cb) {
      const ps = (D.learning.params || []).slice(-300);
      const cols = [cssVar('--soccer'), cssVar('--good'), cssVar('--bball'), acc, cssVar('--bad')];
      charts.b = new Chart(cb, { type: 'line', data: { labels: ps.map((p) => '#' + p.cycle), datasets: SIGNAL_MARKETS.map((k, i) => ({ label: mLabel(k), data: ps.map((p) => (p.blend[k] == null ? null : +(p.blend[k] * 100).toFixed(2))), borderColor: cols[i], pointRadius: 0, borderWidth: 2, tension: .2 })) },
        options: { ...base, plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { x: { display: false }, y: { grid: { color: grid }, ticks: { callback: (v) => v + '%' } } } } });
    }
  }

  // ---------- render ----------
  function renderNav() {
    const open = D.signals.filter((s) => s.status === 'aberto').length;
    $('#nav').innerHTML = TABS.map((t) => `<button role="tab" data-tab="${t.id}" aria-selected="${ui.tab === t.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${t.icon}</svg>${t.label}${t.id === 'sinais' && open ? `<span class="count">${open}</span>` : ''}</button>`).join('');
  }
  let lastHTML = '';
  function render(soft = false) {
    renderNav();
    const t = TABS.find((x) => x.id === ui.tab) || TABS[0];
    $('#page-title').textContent = t.label;
    $('#page-sub').textContent = t.sub;
    document.querySelectorAll('#sport-seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sport === ui.sport));
    if (!D.meta) { $('#view').innerHTML = '<div class="empty"><b>Aguardando o primeiro ciclo da IA</b>Rode <code>npm run cycle</code> ou aguarde o GitHub Actions.</div>'; return; }
    const html = V[t.id]();
    if (soft && html === lastHTML) return;
    const focusId = document.activeElement?.id, selStart = document.activeElement?.selectionStart;
    lastHTML = html;
    $('#view').innerHTML = html;
    if (focusId && $('#' + focusId)) { const el = $('#' + focusId); el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch {} }
    drawCharts();
    tick();
  }

  function tick() {
    const m = D.meta;
    if (!m) return;
    const left = Date.parse(m.nextCycle) - Date.now();
    const txt = left > 0 ? `${String(Math.floor(left / 6e4)).padStart(2, '0')}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : 'processando';
    document.querySelectorAll('[data-countdown]').forEach((el) => (el.textContent = txt));
    const stale = Date.now() - Date.parse(m.lastCycle) > 40 * 6e4;
    $('#pulse-dot').classList.toggle('off', stale || m.sourceLimited);
    $('#pulse-text').innerHTML = stale ? `último ciclo <b>${ago(m.lastCycle)}</b>` : `IA ativa · ciclo <b>#${m.cycle}</b> · próximo <b>${txt}</b>`;
    $('#foot-cycle').textContent = `Atualizado ${ago(m.lastCycle)}`;
  }

  // ---------- eventos ----------
  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { ui.tab = tab.dataset.tab; store.set('tab', ui.tab); history.replaceState(null, '', '#' + ui.tab); render(); window.scrollTo({ top: 0 }); return; }
    const sp = e.target.closest('#sport-seg button');
    if (sp) { ui.sport = sp.dataset.sport; store.set('sport', ui.sport); ui.ratLg = 'all'; render(); return; }
    const open = e.target.closest('[data-open]');
    if (open) { openAnalysis(open.dataset.open); return; }
    if (e.target.closest('[data-close]')) { closeDrawer(); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const s = D.signals.find((x) => x.id === cp.dataset.copy); if (!s) return;
      const txt = `OddLab IA · ${s.leagueName}\n${s.home} × ${s.away} (${dt(s.date, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})\n${s.market}: ${s.label} @ ${odd(s.odd)}\nProb. IA ${pct(s.p)} · EV ${sgn(s.ev * 100, 1)}% · Stake ${s.stake}%`;
      try { await navigator.clipboard.writeText(txt); toast('Sinal copiado'); } catch { toast('Não foi possível copiar'); }
      return;
    }
    const segBtn = e.target.closest('#sig-status button, #perf-scope button, #rat-sport button');
    if (segBtn) {
      const id = segBtn.parentElement.id;
      if (id === 'sig-status') ui.sigStatus = segBtn.dataset.v;
      if (id === 'perf-scope') ui.perfScope = segBtn.dataset.v;
      if (id === 'rat-sport') { ui.ratSport = segBtn.dataset.v; ui.ratLg = 'all'; }
      render();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'sig-market') { ui.sigMarket = e.target.value; render(); }
    if (e.target.id === 'ins-type') { ui.insType = e.target.value; render(); }
    if (e.target.id === 'rat-lg') { ui.ratLg = e.target.value; render(); }
    if (e.target.id === 'bank') { store.set('bank', Math.max(0, Number(e.target.value) || 0)); render(); }
  });
  let qT;
  document.addEventListener('input', (e) => {
    if (e.target.id === 'ins-q') { clearTimeout(qT); qT = setTimeout(() => { ui.insQ = e.target.value; render(); }, 250); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.some((t) => t.id === h) && h !== ui.tab) { ui.tab = h; store.set('tab', h); render(); } });
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('theme', next); drawCharts();
  });
  const th = store.get('theme', null); if (th) document.documentElement.dataset.theme = th;

  // backtest só é carregado quando necessário
  getData('backtest.json', []).then((b) => { D.backtest = b; });
  loadAll().then(pollLive);
  setInterval(loadAll, 60e3);
  setInterval(pollLive, 30e3);
  setInterval(tick, 1000);
})();

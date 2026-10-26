# OddLab IA

IA de análise e sinais para **futebol e basquete**. Coleta jogos, placares e odds de referência da API pública da ESPN, calcula probabilidades com modelos estatísticos, emite sinais de valor esperado positivo, liquida cada sinal pelo placar oficial e aprende com os resultados a cada 10 minutos.

## Abas do site

| Aba | O que mostra |
|---|---|
| Painel | KPIs, melhores sinais, jogos ao vivo e as lições mais recentes |
| Sinais | Sinais abertos, em jogo, encerrados e retirados, com odd, probabilidade IA × mercado, EV, stake e confiança |
| Ao vivo | Placar em tempo real (ESPN, a cada 30 s) cruzado com as projeções |
| Jogos e análise | Estudo completo de cada jogo: xG, matriz de placares, odds justas, mercados IA × casa e leitura em texto |
| Desempenho | Acerto, ROI, lucro em unidades, rebaixamento, gráfico acumulado, cortes por mercado, liga e confiança, calibração |
| Aprendizado | Linha do tempo de tudo que a IA aprendeu, evolução dos pesos e critérios |
| Ratings | Força de ataque/defesa (futebol) e rating líquido/ritmo (basquete) |
| Gestão de banca | Stake em R$ para cada sinal (¼ Kelly, teto 3%) e simulação |
| Metodologia | Como tudo funciona e os limites do modelo |

## Rodar no seu computador

Precisa do Node 20 ou mais novo.

```bash
npm start
```

Abra http://localhost:8787. O servidor entrega o site e roda o ciclo da IA a cada 10 minutos.

Para rodar só um ciclo manualmente: `npm run cycle`.

## Colocar online (grátis, automático, salvo na nuvem)

O projeto já vem pronto para **GitHub Pages + GitHub Actions**:

1. Crie um repositório no GitHub e envie esta pasta (`git push`).
2. Em **Settings → Pages**, escolha *Deploy from a branch*, branch `main`, pasta `/docs`.
3. Em **Settings → Actions → General → Workflow permissions**, marque *Read and write permissions*.
4. Pronto. O workflow `.github/workflows/ia-ciclo.yml` roda a cada 10 minutos, executa o ciclo e faz commit do cérebro em `docs/data/`. O site em `https://<seu-usuario>.github.io/<repo>/` se atualiza sozinho.

O GitHub pode atrasar execuções agendadas em alguns minutos nos horários de pico. O placar ao vivo não depende disso: é lido direto da ESPN pelo navegador.

## Onde fica salvo

| Arquivo | Conteúdo |
|---|---|
| `docs/data/brain.json` | Ratings de todos os times, parâmetros por liga, pesos aprendidos, calibração |
| `docs/data/signals.json` | Todo sinal emitido, com odd, stake, status e resultado |
| `docs/data/learning.json` | Lições de cada ciclo e histórico de parâmetros (arquivado por mês em `archive/` quando cresce) |
| `docs/data/feed.json` | Jogos da janela atual com a análise completa |
| `docs/data/ratings.json`, `meta.json` | Tabelas para o site e status do ciclo |

Cada ciclo vira um commit, então todo o histórico fica auditável.

## Estrutura

```
engine/config.mjs   ligas monitoradas e parâmetros iniciais
engine/espn.mjs     coleta e normalização da ESPN (requisições espaçadas, para em caso de limite)
engine/model.mjs    Poisson + Dixon-Coles (futebol) e rating de margem/total (basquete)
engine/brain.mjs    mercados, sinais, liquidação e aprendizado
engine/cycle.mjs    o ciclo de 10 minutos
server.mjs          servidor local
docs/               o site (HTML, CSS, JS) e os dados
```

## Limites

- Nenhum modelo garante acerto. Julgue a IA pela aba Desempenho, que registra todos os sinais.
- As odds vêm do provedor exibido pela ESPN (normalmente DraftKings) e servem como referência de mercado. Confira a odd na sua casa antes de entrar.
- Aposte só em casas licenciadas. No Brasil, a lista de operadoras autorizadas é publicada pela Secretaria de Prêmios e Apostas do Ministério da Fazenda. Proibido para menores de 18 anos.

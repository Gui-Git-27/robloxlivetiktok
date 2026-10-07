const express = require("express");

const app = express();

const PORTA = process.env.PORT || 3000;
const CHAVE = process.env.CHAVE || "troque-esta-chave";
const USUARIO_TIKTOK = process.env.TIKTOK_USER; // seu @ do TikTok, sem o @
const LIMITE_SEGUNDOS = 60; // máximo de tempo acumulado na fila
const ESPERA_MINIMA_MS = 30000;
const ESPERA_MAXIMA_MS = 120000;
let espera = ESPERA_MINIMA_MS; // aumenta se cair várias vezes seguidas

// Tabela presente -> ação (nomes em minúsculo, como o TikTok manda).
// Faça uma live de teste e veja nos logs do Render o nome exato de cada presente.
const MAPA = {
  rose: { acao: "frente", segundos: 2 },
  heart: { acao: "pular", segundos: 1 },
  gg: { acao: "esquerda", segundos: 2 },
  finger: { acao: "direita", segundos: 2 },
};

let fila = []; // [{ acao, segundos }]

function segundosNaFila() {
  return fila.reduce((total, item) => total + item.segundos, 0);
}

function adicionarPresente(nome, qtd) {
  const regra = MAPA[String(nome).toLowerCase().trim()];
  if (!regra) return { ok: false, motivo: "presente sem ação: " + nome };

  const segundos = regra.segundos * qtd;
  const espaco = LIMITE_SEGUNDOS - segundosNaFila();
  if (espaco <= 0) return { ok: false, motivo: "fila cheia" };

  fila.push({ acao: regra.acao, segundos: Math.min(segundos, espaco) });
  return { ok: true };
}

// ---------- TikTok ----------
async function conectarTikTok() {
  if (!USUARIO_TIKTOK) {
    console.log("TIKTOK_USER não definido: rodando só em modo teste.");
    return;
  }

  let agendou = false;
  let conexao = null;
  let conectouEm = 0;

  const tentarDeNovo = (motivo) => {
    if (agendou) return;
    agendou = true;
    // Se a conexão durou pouco, espera mais antes de tentar (evita bloqueio por excesso de tentativas).
    if (!conectouEm || Date.now() - conectouEm > 60000) espera = ESPERA_MINIMA_MS;
    else espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
    console.log(motivo + " Nova tentativa em " + Math.round(espera / 1000) + "s.");
    try { if (conexao) conexao.disconnect(); } catch (e) {}
    setTimeout(conectarTikTok, espera);
  };

  try {
    const lib = await import("tiktok-live-connector");
    const Conexao =
      lib.TikTokLiveConnection ||
      (lib.default && lib.default.TikTokLiveConnection) ||
      lib.WebcastPushConnection ||
      (lib.default && lib.default.WebcastPushConnection);

    if (!Conexao) {
      console.log("Biblioteca carregou, mas não achei a classe de conexão. Exports:", Object.keys(lib));
      return;
    }

    // Chave gratuita do Euler Stream (serviço que assina a conexão). Opcional, mas ajuda na estabilidade.
    const opcoes = process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {};
    console.log("Conectando" + (opcoes.signApiKey ? " com chave de API" : " sem chave de API") + "...");
    conexao = new Conexao(USUARIO_TIKTOK, opcoes);

    conexao.on("error", (e) => {
      console.log("Erro do TikTok:", (e && e.info) || "", (e && e.exception && e.exception.message) || (e && e.message) || "");
    });

    conexao.on("disconnected", (info) => {
      const codigo = info && info.code;
      const razao = info && info.reason;
      tentarDeNovo("Desconectado da live (código: " + codigo + ", motivo: " + (razao || "nenhum") + ").");
    });

    conexao.on("streamEnd", (info) => console.log("Live encerrada:", JSON.stringify(info)));

    conexao.on("gift", (data) => {
      const g = data.gift || data.giftDetails || {};
      const nome = data.giftName || g.name || g.giftName;
      const tipo = data.giftType !== undefined ? data.giftType : (g.type !== undefined ? g.type : g.giftType);
      const qtd = data.repeatCount || 1;
      const u = data.user || {};
      const quem = u.uniqueId || u.displayId || u.nickname || data.uniqueId || "?";

      // Formato desconhecido: mostra o conteúdo cru no log pra eu ajustar.
      if (!nome) {
        const cru = JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v));
        console.log("Presente em formato desconhecido:", (cru || "").slice(0, 700));
        return;
      }

      // Presente em sequência: só conta quando a sequência termina.
      if (tipo === 1 && !data.repeatEnd) return;

      console.log("Presente:", nome, "x" + qtd, "de", quem);
      const r = adicionarPresente(nome, qtd);
      if (!r.ok) console.log("Ignorado:", r.motivo);
    });

    await conexao.connect();
    conectouEm = Date.now();
    console.log("Conectado à live de @" + USUARIO_TIKTOK);
  } catch (e) {
    console.log("Falha ao conectar:", (e && e.stack) || e);
    tentarDeNovo("Não consegui conectar (a live precisa estar ligada).");
  }
}

// ---------- Rotas ----------
// O Roblox chama esta rota a cada ~1s (com ?chave=SUA_CHAVE). Devolve os comandos pendentes e limpa a fila.
app.get("/fila", (req, res) => {
  if (req.query.chave !== CHAVE) return res.status(401).json({ erro: "chave inválida" });
  const pendentes = fila;
  fila = [];
  res.json(pendentes);
});

// Simula um presente: /teste?presente=rose&qtd=3&chave=SUA_CHAVE
app.get("/teste", (req, res) => {
  if (req.query.chave !== CHAVE) return res.status(401).json({ erro: "chave inválida" });
  const qtd = Math.max(1, parseInt(req.query.qtd, 10) || 1);
  res.json(adicionarPresente(req.query.presente, qtd));
});

app.get("/", (req, res) => res.send("Servidor da live no ar."));

process.on("unhandledRejection", (e) => console.log("Erro:", (e && e.stack) || e));
process.on("uncaughtException", (e) => console.log("Erro:", (e && e.stack) || e));

app.listen(PORTA, () => {
  console.log("Rodando na porta " + PORTA);
  conectarTikTok();
});

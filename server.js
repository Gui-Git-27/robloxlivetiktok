const express = require("express");

const app = express();

const PORTA = process.env.PORT || 3000;
const CHAVE = process.env.CHAVE || "troque-esta-chave";
const USUARIO_TIKTOK = process.env.TIKTOK_USER; // seu @ do TikTok, sem o @
const LIMITE_SEGUNDOS = 60; // máximo de tempo acumulado na fila
const ESPERA_RECONEXAO_MS = 30000;

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
  const regra = MAPA[String(nome).toLowerCase()];
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

  const tentarDeNovo = (motivo) => {
    if (agendou) return;
    agendou = true;
    console.log(motivo + " Nova tentativa em " + ESPERA_RECONEXAO_MS / 1000 + "s.");
    try { if (conexao) conexao.disconnect(); } catch (e) {}
    setTimeout(conectarTikTok, ESPERA_RECONEXAO_MS);
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

    conexao = new Conexao(USUARIO_TIKTOK, {});

    conexao.on("error", (e) => {
      console.log("Erro do TikTok:", (e && (e.info || e.message)) || e);
    });

    conexao.on("disconnected", () => tentarDeNovo("Desconectado da live."));

    conexao.on("gift", (data) => {
      const detalhes = data.giftDetails || {};
      const nome = data.giftName || detalhes.giftName;
      const tipo = data.giftType !== undefined ? data.giftType : detalhes.giftType;
      const qtd = data.repeatCount || 1;
      const quem = (data.user && data.user.uniqueId) || data.uniqueId;

      // Presente em sequência: só conta quando a sequência termina.
      if (tipo === 1 && !data.repeatEnd) return;

      console.log("Presente:", nome, "x" + qtd, "de", quem);
      const r = adicionarPresente(nome, qtd);
      if (!r.ok) console.log("Ignorado:", r.motivo);
    });

    await conexao.connect();
    console.log("Conectado à live de @" + USUARIO_TIKTOK);
  } catch (e) {
    console.log("Falha ao conectar:", (e && e.stack) || e);
    tentarDeNovo("Não consegui conectar (a live precisa estar ligada).");
  }
}

// ---------- Rotas ----------
// O Roblox chama esta rota a cada ~1s. Devolve os comandos pendentes e limpa a fila.
app.get("/fila", (req, res) => {
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

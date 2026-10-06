const express = require("express");
const lib = require("tiktok-live-connector");
const Conexao = lib.WebcastPushConnection || lib.TikTokLiveConnection;

const app = express();

const PORTA = process.env.PORT || 3000;
const CHAVE = process.env.CHAVE || "troque-esta-chave";
const USUARIO_TIKTOK = process.env.TIKTOK_USER; // seu @ do TikTok, sem o @
const LIMITE_SEGUNDOS = 60; // máximo de tempo acumulado na fila

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
function conectarTikTok() {
  if (!USUARIO_TIKTOK) {
    console.log("TIKTOK_USER não definido: rodando só em modo teste.");
    return;
  }

  const conexao = new Conexao(USUARIO_TIKTOK);
  let jaAgendou = false;

  const tentarDeNovo = () => {
    if (jaAgendou) return;
    jaAgendou = true;
    try { conexao.disconnect(); } catch (e) {}
    setTimeout(conectarTikTok, 15000);
  };

  conexao
    .connect()
    .then(() => console.log("Conectado à live de @" + USUARIO_TIKTOK))
    .catch(() => {
      console.log("Live de @" + USUARIO_TIKTOK + " não encontrada. Nova tentativa em 15s.");
      tentarDeNovo();
    });

  conexao.on("disconnected", () => {
    console.log("Desconectado da live.");
    tentarDeNovo();
  });

  conexao.on("gift", (data) => {
    const detalhes = data.giftDetails || {};
    const nome = data.giftName || detalhes.giftName;
    const tipo = data.giftType !== undefined ? data.giftType : detalhes.giftType;
    const qtd = data.repeatCount || 1;

    // Presente em sequência: só conta quando a sequência termina.
    if (tipo === 1 && !data.repeatEnd) return;

    console.log("Presente:", nome, "x" + qtd, "de", data.uniqueId);
    const r = adicionarPresente(nome, qtd);
    if (!r.ok) console.log("Ignorado:", r.motivo);
  });
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

process.on("unhandledRejection", (e) => console.log("Erro:", e && e.message));
process.on("uncaughtException", (e) => console.log("Erro:", e && e.message));

app.listen(PORTA, () => {
  console.log("Rodando na porta " + PORTA);
  conectarTikTok();
});

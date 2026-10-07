const express = require("express");

const app = express();

const PORTA = process.env.PORT || 3000;
const CHAVE = process.env.CHAVE || "troque-esta-chave";
const USUARIO_TIKTOK = process.env.TIKTOK_USER; // seu @ do TikTok, sem o @
const ESPERA_MINIMA_MS = 30000;
const ESPERA_MAXIMA_MS = 120000;
const MAX_EVENTOS = 300;

let espera = ESPERA_MINIMA_MS;
let fila = []; // eventos esperando o Roblox buscar
let curtidasPendentes = 0; // curtidas acumuladas desde a última busca
const catalogo = new Map(); // nome do presente -> { moedas, vistos }

// ---------- Eventos ----------
function empurrar(evento) {
  fila.push(evento);
  if (fila.length > MAX_EVENTOS) fila.shift();
}

function registrarPresente(nome, moedasPorUnidade, qtd, quem) {
  const unidade = moedasPorUnidade > 0 ? moedasPorUnidade : 1;
  const total = Math.max(1, Math.round(unidade * qtd));

  const atual = catalogo.get(nome) || { moedas: unidade, vistos: 0 };
  atual.moedas = unidade;
  atual.vistos += qtd;
  catalogo.set(nome, atual);

  empurrar({ tipo: "presente", nome, moedas: total, qtd, quem });
  return total;
}

function tratarPresente(data) {
  const g = data.gift || data.giftDetails || {};
  const nome = data.giftName || g.name || g.giftName;
  const tipo = data.giftType !== undefined ? data.giftType : g.type !== undefined ? g.type : g.giftType;
  const qtd = data.repeatCount || 1;
  const moedasPorUnidade = g.diamondCount !== undefined ? g.diamondCount : g.diamond_count;
  const u = data.user || {};
  const quem = u.uniqueId || u.displayId || u.nickname || data.uniqueId || "alguém";

  if (!nome) {
    const cru = JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log("Presente em formato desconhecido:", (cru || "").slice(0, 700));
    return null;
  }

  // Presente em sequência: só conta quando a sequência termina.
  if (tipo === 1 && !data.repeatEnd) return null;

  const total = registrarPresente(nome, moedasPorUnidade, qtd, quem);
  console.log("Presente:", nome, "x" + qtd, "=", total, "moedas, de", quem);
  return total;
}

function tratarCurtida(data) {
  const qtd = data.count || data.likeCount || 1;
  curtidasPendentes += qtd;
  return qtd;
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
    conexao.on("gift", (data) => tratarPresente(data));
    conexao.on("like", (data) => tratarCurtida(data));

    await conexao.connect();
    conectouEm = Date.now();
    console.log("Conectado à live de @" + USUARIO_TIKTOK);
  } catch (e) {
    console.log("Falha ao conectar:", (e && e.stack) || e);
    tentarDeNovo("Não consegui conectar (a live precisa estar ligada).");
  }
}

// ---------- Rotas ----------
function exigirChave(req, res) {
  if (req.query.chave !== CHAVE) {
    res.status(401).json({ erro: "chave inválida" });
    return false;
  }
  return true;
}

// O Roblox chama esta rota a cada ~1s (com ?chave=SUA_CHAVE).
app.get("/fila", (req, res) => {
  if (!exigirChave(req, res)) return;
  const eventos = fila;
  fila = [];
  if (curtidasPendentes > 0) {
    eventos.push({ tipo: "curtidas", qtd: curtidasPendentes });
    curtidasPendentes = 0;
  }
  res.json(eventos);
});

// Simula eventos:
//   /teste?presente=Rose&moedas=1&qtd=3&chave=SUA_CHAVE
//   /teste?curtidas=30&chave=SUA_CHAVE
app.get("/teste", (req, res) => {
  if (!exigirChave(req, res)) return;

  if (req.query.curtidas) {
    const qtd = Math.max(1, parseInt(req.query.curtidas, 10) || 1);
    tratarCurtida({ count: qtd });
    return res.json({ ok: true, curtidas: qtd });
  }

  const nome = req.query.presente || "Rose";
  const moedas = Math.max(1, parseInt(req.query.moedas, 10) || 1);
  const qtd = Math.max(1, parseInt(req.query.qtd, 10) || 1);
  const total = registrarPresente(nome, moedas, qtd, "teste");
  res.json({ ok: true, presente: nome, moedas: total });
});

// Tabela de presentes vistos nas lives (nome e valor em moedas).
app.get("/presentes", (req, res) => {
  if (!exigirChave(req, res)) return;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const linhas = [...catalogo.entries()]
    .sort((a, b) => a[1].moedas - b[1].moedas || a[0].localeCompare(b[0]))
    .map(([nome, v]) => `<tr><td>${esc(nome)}</td><td>${v.moedas}</td><td>${v.vistos}</td></tr>`)
    .join("");
  res.send(
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:sans-serif;padding:12px"><h3>Presentes vistos</h3>` +
      `<table border="1" cellpadding="8" style="border-collapse:collapse"><tr><th>Presente</th><th>Moedas</th><th>Vezes</th></tr>` +
      (linhas || `<tr><td colspan="3">Nenhum presente visto ainda.</td></tr>`) +
      `</table><p>Some quando o servidor reinicia.</p></body>`
  );
});

app.get("/", (req, res) => res.send("Servidor da live no ar."));

process.on("unhandledRejection", (e) => console.log("Erro:", (e && e.stack) || e));
process.on("uncaughtException", (e) => console.log("Erro:", (e && e.stack) || e));

module.exports = { tratarPresente, tratarCurtida, app, getFila: () => fila };

if (require.main === module) {
  app.listen(PORTA, () => {
    console.log("Rodando na porta " + PORTA);
    conectarTikTok();
  });
}

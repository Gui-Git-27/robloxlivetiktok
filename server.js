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
const curtidasPorUsuario = new Map(); // quem -> curtidas acumuladas desde a última busca
const catalogo = new Map(); // nome do presente -> { moedas, vistos }
let totalComentarios = 0;

// ---------- Diagnóstico ----------
const eventosVistos = new Map(); // nome do evento -> quantas vezes chegou do TikTok
let estadoConexao = "ainda não conectou";
let conectadaDesde = 0;

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Consulta de nicks do Roblox (em lote) ----------
// O servidor descobre o userId dos nicks dos comentários e manda junto com o comentário.
// Assim o jogo quase não precisa consultar o Roblox (que bloqueia consultas em excesso).
const cacheNicks = new Map(); // nick minúsculo -> { id } ou { naoExiste: true, ate }
const lote = new Map(); // nick minúsculo -> { nick, esperas: [] }
let loteTimer = null;
let bloqueadoAte = 0;

function resolverNick(nick) {
  const k = nick.toLowerCase();
  const c = cacheNicks.get(k);
  if (c) {
    if (c.id) return Promise.resolve(c.id);
    if (Date.now() < c.ate) return Promise.resolve(null);
  }
  if (typeof fetch !== "function" || Date.now() < bloqueadoAte) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let item = lote.get(k);
    if (!item) {
      item = { nick, esperas: [] };
      lote.set(k, item);
    }
    item.esperas.push(resolve);
    if (!loteTimer) loteTimer = setTimeout(enviarLote, 300);
  });
}

async function enviarLote() {
  loteTimer = null;
  const itens = [...lote.values()].slice(0, 100);
  for (const it of itens) lote.delete(it.nick.toLowerCase());
  if (lote.size) loteTimer = setTimeout(enviarLote, 300);
  if (!itens.length) return;
  try {
    const r = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: itens.map((i) => i.nick), excludeBannedUsers: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const json = await r.json();
    const achados = new Map();
    for (const u of json.data || []) achados.set(String(u.requestedUsername).toLowerCase(), u.id);
    if (cacheNicks.size > 5000) cacheNicks.clear();
    for (const it of itens) {
      const k = it.nick.toLowerCase();
      const id = achados.get(k);
      if (id) {
        cacheNicks.set(k, { id });
        it.esperas.forEach((f) => f(id));
      } else {
        cacheNicks.set(k, { naoExiste: true, ate: Date.now() + 60000 });
        it.esperas.forEach((f) => f(null));
      }
    }
  } catch (e) {
    console.log("Não consegui consultar nicks no Roblox (o jogo tenta por conta própria):", e && e.message);
    bloqueadoAte = Date.now() + 5000;
    for (const it of itens) it.esperas.forEach((f) => f(undefined));
  }
}

// Palavras do comentário que podem ser um nick: @nick, ou (sem @) uma palavra única com letra e número/_
function candidatosDeNick(texto) {
  const achados = new Set();
  for (const m of texto.matchAll(/@([A-Za-z0-9_]{3,20})/g)) achados.add(m[1]);
  if (!achados.size) {
    const s = texto.trim();
    if (/^[A-Za-z0-9_]{3,20}$/.test(s) && /[A-Za-z]/.test(s) && /[0-9_]/.test(s)) achados.add(s);
  }
  return [...achados].slice(0, 3);
}

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

function nomeDoUsuario(u, data) {
  u = u || {};
  return u.displayId || u.uniqueId || u.nickname || (data && data.uniqueId) || "alguém";
}

function tratarPresente(data) {
  const g = data.gift || data.giftDetails || {};
  const nome = data.giftName || g.name || g.giftName;
  const tipo = data.giftType !== undefined ? data.giftType : g.type !== undefined ? g.type : g.giftType;
  const qtd = data.repeatCount || 1;
  const moedasPorUnidade = g.diamondCount !== undefined ? g.diamondCount : g.diamond_count;
  const quem = nomeDoUsuario(data.user, data);

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

// Agora as curtidas ficam separadas por pessoa (cada Sonic ganha velocidade das próprias curtidas).
function tratarCurtida(data) {
  const qtd = data.likeCount || data.count || 1;
  const quem = nomeDoUsuario(data.user, data);
  curtidasPorUsuario.set(quem, (curtidasPorUsuario.get(quem) || 0) + qtd);
  return qtd;
}

function tratarComentario(data) {
  // Nas versões novas da biblioteca o texto vem em "content"; nas antigas, em "comment".
  const bruto = data.comment !== undefined && data.comment !== "" ? data.comment : data.content;
  const texto = String(bruto || "").trim().slice(0, 80);
  if (!texto) {
    // O evento chegou, mas sem o texto onde esperávamos: mostra o que veio para a gente ajustar.
    console.log("Comentário sem texto. Campos recebidos:", Object.keys(data || {}).join(", "));
    return null;
  }
  const quem = nomeDoUsuario(data.user, data);
  totalComentarios++;
  console.log("Comentário:", quem + ":", texto);
  const candidatos = candidatosDeNick(texto);
  if (!candidatos.length) {
    empurrar({ tipo: "comentario", quem, texto });
    return texto;
  }
  Promise.all(candidatos.map(resolverNick))
    .then((resultados) => {
      const ids = {};
      const nao = {};
      candidatos.forEach((n, i) => {
        if (resultados[i]) ids[n.toLowerCase()] = resultados[i];
        else if (resultados[i] === null) nao[n.toLowerCase()] = true;
      });
      empurrar({ tipo: "comentario", quem, texto, ids, nao });
    })
    .catch(() => empurrar({ tipo: "comentario", quem, texto }));
  return texto;
}

function tratarSeguiu(data) {
  const quem = nomeDoUsuario(data.user, data);
  empurrar({ tipo: "seguiu", quem });
  return quem;
}

// ---------- TikTok ----------
async function conectarTikTok() {
  if (!USUARIO_TIKTOK) {
    console.log("TIKTOK_USER não definido: rodando só em modo teste.");
    estadoConexao = "TIKTOK_USER não definido";
    return;
  }

  let agendou = false;
  let conexao = null;
  let conectouEm = 0;

  const tentarDeNovo = (motivo) => {
    if (agendou) return;
    agendou = true;
    estadoConexao = "desconectado, tentando de novo";
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

    const opcoes = {};
    if (process.env.EULER_API_KEY) opcoes.signApiKey = process.env.EULER_API_KEY;
    // Opcional: o TikTok às vezes só entrega TODOS os comentários para conexões com sessão de uma conta.
    // Use uma conta secundária (nunca a principal) e guarde o valor só nas variáveis de ambiente do Render.
    if (process.env.TIKTOK_SESSION_ID) opcoes.sessionId = process.env.TIKTOK_SESSION_ID;
    if (process.env.TIKTOK_TT_TARGET_IDC) opcoes.ttTargetIdc = process.env.TIKTOK_TT_TARGET_IDC;

    console.log(
      "Conectando" +
        (opcoes.signApiKey ? " com chave de API" : " sem chave de API") +
        (opcoes.sessionId ? " e com sessão de conta" : " e sem sessão de conta") +
        "..."
    );
    conexao = new Conexao(USUARIO_TIKTOK, opcoes);

    // Conta todos os eventos que chegam (veja em /diagnostico)
    const emitirOriginal = conexao.emit.bind(conexao);
    conexao.emit = (nome, ...args) => {
      const n = String(nome);
      eventosVistos.set(n, (eventosVistos.get(n) || 0) + 1);
      return emitirOriginal(nome, ...args);
    };

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
    conexao.on("chat", (data) => tratarComentario(data));
    conexao.on("follow", (data) => {
      const quem = tratarSeguiu(data);
      console.log("Novo seguidor:", quem);
    });
    // Só para diagnóstico: mostra eventos sociais (seguir, compartilhar) que chegam do TikTok.
    conexao.on("social", (data) => {
      console.log("Evento social:", (data && (data.displayType || data.label)) || "?");
    });

    await conexao.connect();
    conectouEm = Date.now();
    conectadaDesde = conectouEm;
    estadoConexao = "conectado à live de @" + USUARIO_TIKTOK;
    console.log("Conectado à live de @" + USUARIO_TIKTOK);
  } catch (e) {
    console.log("Falha ao conectar:", (e && e.stack) || e);
    tentarDeNovo("Não consegui conectar (a live precisa estar ligada).");
  }
}

// Resumo no log a cada minuto
setInterval(() => {
  if (!eventosVistos.size) return;
  const resumo = [...eventosVistos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, q]) => n + "=" + q).join(" ");
  console.log("Eventos recebidos até agora:", resumo, "| comentários repassados ao jogo:", totalComentarios);
}, 60000);

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
  for (const [quem, qtd] of curtidasPorUsuario) {
    eventos.push({ tipo: "curtidas", quem, qtd });
  }
  curtidasPorUsuario.clear();
  res.json(eventos);
});

// Simula eventos:
//   /teste?presente=Rose&moedas=1&qtd=3&quem=ana&chave=SUA_CHAVE
//   /teste?curtidas=30&quem=ana&chave=SUA_CHAVE
//   /teste?comentario=@nick&quem=ana&chave=SUA_CHAVE
//   /teste?seguiu=1&quem=ana&chave=SUA_CHAVE
app.get("/teste", (req, res) => {
  if (!exigirChave(req, res)) return;
  const quem = req.query.quem || "teste";

  if (req.query.comentario) {
    tratarComentario({ comment: req.query.comentario, user: { displayId: quem } });
    return res.json({ ok: true, comentario: req.query.comentario });
  }

  if (req.query.seguiu) {
    tratarSeguiu({ user: { displayId: quem } });
    return res.json({ ok: true, seguiu: true });
  }

  if (req.query.curtidas) {
    const qtd = Math.max(1, parseInt(req.query.curtidas, 10) || 1);
    tratarCurtida({ count: qtd, user: { displayId: quem } });
    return res.json({ ok: true, curtidas: qtd, quem });
  }

  const nome = req.query.presente || "Rose";
  const moedas = Math.max(1, parseInt(req.query.moedas, 10) || 1);
  const qtd = Math.max(1, parseInt(req.query.qtd, 10) || 1);
  const total = registrarPresente(nome, moedas, qtd, quem);
  res.json({ ok: true, presente: nome, moedas: total, quem });
});

// Diagnóstico: o que o servidor está recebendo do TikTok.
app.get("/diagnostico", (req, res) => {
  if (!exigirChave(req, res)) return;
  const linhas = [...eventosVistos.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([nome, q]) => `<tr><td>${esc(nome)}</td><td>${q}</td></tr>`)
    .join("");
  const desde = conectadaDesde ? Math.round((Date.now() - conectadaDesde) / 1000) + "s" : "-";
  res.send(
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:sans-serif;padding:12px"><h3>Diagnóstico</h3>` +
      `<p>Conexão: <b>${esc(estadoConexao)}</b> (conectada há ${desde})</p>` +
      `<p>Com sessão de conta: <b>${process.env.TIKTOK_SESSION_ID ? "sim" : "não"}</b> | Com chave Euler: <b>${process.env.EULER_API_KEY ? "sim" : "não"}</b></p>` +
      `<p>Comentários repassados ao jogo: <b>${totalComentarios}</b> | Eventos na fila agora: <b>${fila.length}</b></p>` +
      `<p>Veja a linha <b>chat</b> abaixo: se ela não aparece ou fica em 0 enquanto <b>like</b> e <b>gift</b> sobem, o TikTok não está entregando comentários para esta conexão.</p>` +
      `<table border="1" cellpadding="8" style="border-collapse:collapse"><tr><th>Evento</th><th>Vezes</th></tr>` +
      (linhas || `<tr><td colspan="2">Nenhum evento recebido ainda.</td></tr>`) +
      `</table><p>Zera quando o servidor reinicia.</p></body>`
  );
});

// Tabela de presentes vistos nas lives (nome e valor em moedas).
app.get("/presentes", (req, res) => {
  if (!exigirChave(req, res)) return;
  const linhas = [...catalogo.entries()]
    .sort((a, b) => a[1].moedas - b[1].moedas || a[0].localeCompare(b[0]))
    .map(([nome, v]) => `<tr><td>${esc(nome)}</td><td>${v.moedas}</td><td>${v.vistos}</td></tr>`)
    .join("");
  res.send(
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:sans-serif;padding:12px"><h3>Presentes vistos</h3>` +
      `<table border="1" cellpadding="8" style="border-collapse:collapse"><tr><th>Presente</th><th>Moedas</th><th>Vezes</th></tr>` +
      (linhas || `<tr><td colspan="3">Nenhum presente visto ainda.</td></tr>`) +
      `</table><p>Comentários recebidos desde que o servidor ligou: ${totalComentarios}</p>` +
      `<p>Some quando o servidor reinicia.</p></body>`
  );
});

app.get("/", (req, res) => res.send("Servidor da live no ar."));

process.on("unhandledRejection", (e) => console.log("Erro:", (e && e.stack) || e));
process.on("uncaughtException", (e) => console.log("Erro:", (e && e.stack) || e));

module.exports = { tratarPresente, tratarCurtida, tratarComentario, tratarSeguiu, app, getFila: () => fila };

if (require.main === module) {
  app.listen(PORTA, () => {
    console.log("Rodando na porta " + PORTA);
    conectarTikTok();
  });
}

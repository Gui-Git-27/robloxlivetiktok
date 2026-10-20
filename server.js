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
let estadoOk = false; // true enquanto está conectado à live
let ultimoEventoEm = 0; // quando chegou o último evento do TikTok
let ultimaBuscaJogo = 0; // quando o jogo buscou a fila pela última vez
let jogoEstado = null; // resumo que o jogo manda para o painel (vagas, meta, pódio...)
let jogoEstadoEm = 0;
let curtidasLive = null; // total de curtidas da live segundo o TikTok
let espectadores = null; // espectadores na live agora

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
  const totalLive = Number(data.totalLikeCount);
  if (Number.isFinite(totalLive) && totalLive > 0) curtidasLive = totalLive;
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
    estadoOk = false;
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
      ultimoEventoEm = Date.now();
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
    conexao.on("roomUser", (d) => {
      const v = Number(d && d.viewerCount);
      if (Number.isFinite(v)) espectadores = v;
    });
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
    estadoOk = true;
    ultimoEventoEm = Date.now();
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

// ---------- Painel de controle ----------
const PAINEL_HTML = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel da Live</title>
<style>
  body{font-family:system-ui,sans-serif;background:#12121c;color:#eee;margin:0;padding:14px;max-width:1000px}
  h1{font-size:20px;margin:0 0 10px}
  h2{font-size:14px;margin:18px 0 6px;color:#9ab;text-transform:uppercase;letter-spacing:.06em}
  .grade{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  button,select,input{font-size:15px;border-radius:8px;border:1px solid #445;background:#222236;color:#eee;padding:9px 12px}
  button{cursor:pointer} button:hover{background:#2e2e4a}
  button.ativo{background:#245b34;border-color:#4c9}
  button.perigo{border-color:#a44;background:#3a1c24}
  kbd{background:#000;border:1px solid #556;border-radius:4px;padding:0 5px;font-size:12px;margin-left:6px;color:#fc6}
  .estado{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
  .pill{padding:6px 12px;border-radius:99px;background:#222236;font-size:14px}
  .ok{background:#16401f}.ruim{background:#4a1c1c}
  label{font-size:14px;color:#bbc}
  #toast{position:fixed;right:14px;bottom:14px;background:#000c;padding:8px 14px;border-radius:8px;display:none}
</style></head><body>
<h1>Painel da Live</h1>
<div class="estado">
  <span class="pill" id="s-tiktok">TikTok: ...</span>
  <span class="pill" id="s-jogo">Jogo: ...</span>
  <span class="pill" id="s-esp">Espectadores: -</span>
  <span class="pill" id="s-live">Curtidas da live: -</span>
  <span class="pill" id="s-com">Comentários: -</span>
  <span class="pill" id="s-fila">Fila do servidor: -</span>
</div>
<div class="estado">
  <span class="pill" id="j-vagas">Vagas: -</span>
  <span class="pill" id="j-meta">Meta de curtidas: -</span>
  <span class="pill" id="j-podio">Pódio: -</span>
  <span class="pill" id="j-modo">Modo: -</span>
</div>
<label><input type="checkbox" id="alarme"> Alarme sonoro se o jogo ou o TikTok cair</label>

<h2>Câmera</h2>
<div class="grade">
  <button id="cam-auto" onclick="enviar('camera','auto')">Automática (geral e último)<kbd>1</kbd></button>
  <button id="cam-geral" onclick="enviar('camera','geral')">Sempre geral<kbd>2</kbd></button>
  <button id="cam-podio" onclick="enviar('camera','podio')">Sempre pódio<kbd>3</kbd></button>
  <button id="cam-dj" onclick="enviar('camera','dj')">Sempre 1º lugar / DJ<kbd>4</kbd></button>
  <button id="cam-vaga1" onclick="enviar('camera','vaga1')">Sempre vaga 1<kbd>5</kbd></button>
  <button id="cam-ultimo" onclick="enviar('camera','ultimo')">Sempre o último que entrou<kbd>6</kbd></button>
</div>

<h2>Intervalo (tela preta com contagem)</h2>
<div class="grade">
  <input id="int-txt" type="text" value="Já volto!" style="min-width:200px">
  <input id="int-seg" type="number" value="60" style="width:90px"> <label>segundos</label>
  <button onclick="intervalo()">Iniciar intervalo<kbd>I</kbd></button>
  <button onclick="intervalo(30)">30 s</button>
  <button onclick="intervalo(60)">1 min</button>
  <button onclick="intervalo(180)">3 min</button>
  <button onclick="intervalo(300)">5 min</button>
  <button onclick="enviar('intervalo_fim')">Voltar agora<kbd>V</kbd></button>
</div>

<h2>Vagas e pódio</h2>
<div class="grade">
  <button onclick="enviar('limpar')">Limpar vagas<kbd>L</kbd></button>
  <button onclick="enviar('pausar')">Pausar entradas<kbd>P</kbd></button>
  <button onclick="enviar('retomar')">Retomar entradas<kbd>R</kbd></button>
  <button onclick="enviar('pular')">Esvaziar fila de espera<kbd>S</kbd></button>
  <button onclick="enviar('podio_limpar')">Limpar pódio<kbd>O</kbd></button>
  <button class="perigo" onclick="if(confirm('Limpar vagas, pódio e fila de espera?'))enviar('reset_geral')">Reset geral</button>
</div>

<h2>Ajustes na hora</h2>
<div class="grade">
  <label>Entrada
    <select id="sel-entrada" onchange="enviar('entrada',this.value)"><option value="ultimo">Último comentário</option><option value="fila">Fila (todos)</option></select></label>
  <label>Vagas por pessoa
    <select id="sel-limite" onchange="enviar('limite',this.value)"><option value="0">Sem limite</option><option>1</option><option>2</option><option>3</option><option>5</option></select></label>
  <label>Atraso entre bonecos
    <select id="sel-atraso" onchange="enviar('atraso',this.value)"><option>1</option><option>1.5</option><option>2</option><option>3</option><option>5</option></select></label>
  <label>Animação
    <select id="sel-animacao" onchange="enviar('animacao',this.value)"><option value="idle">Idle do avatar</option><option value="danca">Dança</option><option value="emotes">Emotes</option></select></label>
</div>

<h2>Música e meta de curtidas</h2>
<div class="grade">
  <button onclick="enviar('musica','proxima')">Próxima música<kbd>N</kbd></button>
  <button onclick="enviar('musica','pausar')">Pausar música<kbd>M</kbd></button>
  <button onclick="enviar('musica','tocar')">Tocar música<kbd>K</kbd></button>
  <button onclick="if(confirm('Zerar as curtidas e a meta?'))enviar('meta_zerar')">Zerar meta de curtidas</button>
  <input id="meta" type="number" placeholder="nova meta" style="width:120px">
  <button onclick="enviar('meta',document.getElementById('meta').value)">Definir meta</button>
</div>

<h2>Aviso rápido no meio da tela</h2>
<div class="grade">
  <input id="msg" type="text" placeholder="Ex.: Mande seu @!" style="min-width:240px">
  <button onclick="enviar('mensagem',document.getElementById('msg').value)">Mostrar</button>
  <button onclick="enviar('mensagem','')">Esconder<kbd>H</kbd></button>
</div>

<h2>Testar sem live (simulador)</h2>
<div class="grade">
  <label>Usuário do TikTok <input id="t-quem" type="text" value="teste1" style="width:110px"></label>
  <label>Nick do Roblox <input id="t-nick" type="text" value="Roblox" style="width:130px"></label>
  <label>Moedas <input id="t-moedas" type="number" value="100" style="width:90px"></label>
</div>
<div class="grade" style="margin-top:8px">
  <button onclick="sim('comentar')">Comentar @nick</button>
  <button onclick="sim('presente')">Mandar presente</button>
  <button onclick="sim('seguir')">Seguir</button>
  <button onclick="sim('curtir')">Curtir x50</button>
  <button onclick="enviar('depurar','alternar')">Painel de depuração no jogo<kbd>D</kbd></button>
</div>
<p style="font-size:13px;color:#99a">Para testar o pódio: primeiro "Comentar @nick" (o boneco entra), depois "Mandar presente" com o mesmo usuário.</p>

<div id="toast"></div>
<script>
var chave = new URLSearchParams(location.search).get("chave") || "";
var ATALHOS = {
  "1":["camera","auto"],"2":["camera","geral"],"3":["camera","podio"],"4":["camera","dj"],"5":["camera","vaga1"],"6":["camera","ultimo"],
  "l":["limpar",""],"p":["pausar",""],"r":["retomar",""],"s":["pular",""],"o":["podio_limpar",""],
  "n":["musica","proxima"],"m":["musica","pausar"],"k":["musica","tocar"],"h":["mensagem",""],"d":["depurar","alternar"],"v":["intervalo_fim",""]
};
function el(id){return document.getElementById(id)}
function aviso(t){var e=el("toast");e.textContent=t;e.style.display="block";clearTimeout(aviso.t);aviso.t=setTimeout(function(){e.style.display="none"},2200)}
function enviar(acao,valor){
  fetch("/comando?chave="+encodeURIComponent(chave)+"&acao="+encodeURIComponent(acao)+"&valor="+encodeURIComponent(valor||""))
    .then(function(r){return r.json()})
    .then(function(j){aviso(j.ok?"Enviado: "+acao+" "+(valor||""):"Erro: "+(j.erro||"?"))})
    .catch(function(){aviso("Falha ao enviar")});
}
function intervalo(seg){
  var s = (seg===undefined) ? (parseInt(el("int-seg").value,10)||0) : seg;
  var t = (el("int-txt").value||"Já volto!").replace("|"," ").slice(0,80);
  enviar("intervalo", s+"|"+t);
}
function teste(q){
  fetch("/teste?chave="+encodeURIComponent(chave)+"&"+q).then(function(r){return r.json()})
    .then(function(){aviso("Simulado")}).catch(function(){aviso("Falha ao simular")});
}
function sim(tipo){
  var quem=encodeURIComponent(el("t-quem").value||"teste1"), nick=el("t-nick").value||"Roblox", moedas=parseInt(el("t-moedas").value,10)||1;
  if(tipo==="comentar") teste("comentario="+encodeURIComponent("@"+nick)+"&quem="+quem);
  if(tipo==="presente") teste("presente=Rose&moedas="+moedas+"&quem="+quem);
  if(tipo==="seguir") teste("seguiu=1&quem="+quem);
  if(tipo==="curtir") teste("curtidas=50&quem="+quem);
}
document.addEventListener("keydown",function(e){
  var t=e.target.tagName; if(t==="INPUT"||t==="SELECT"||t==="TEXTAREA"||e.ctrlKey||e.metaKey||e.altKey)return;
  var k=e.key.toLowerCase();
  if(k==="i"){e.preventDefault();intervalo();return}
  var a=ATALHOS[k]; if(a){e.preventDefault();enviar(a[0],a[1])}
});
function pintar(id,ok,texto){var e=el(id);e.textContent=texto;e.className="pill "+(ok?"ok":"ruim")}
function sincronizar(id,valor){var e=el(id); if(e && document.activeElement!==e && valor!==undefined && valor!==null) e.value=String(valor)}

var ctx=null;
el("alarme").addEventListener("change",function(e){
  if(e.target.checked && !ctx){ try{ctx=new (window.AudioContext||window.webkitAudioContext)()}catch(x){} }
});
function bipar(){
  if(!ctx||!el("alarme").checked)return;
  var o=ctx.createOscillator(),g=ctx.createGain(); o.connect(g); g.connect(ctx.destination);
  o.frequency.value=880; g.gain.value=0.2; o.start(); setTimeout(function(){o.stop()},500);
}

var NOMES_CAMERA={auto:"Automática",geral:"Sempre geral",podio:"Sempre pódio",dj:"Sempre 1º/DJ",vaga1:"Sempre vaga 1",ultimo:"Sempre último"};
function atualizar(){
  fetch("/status?chave="+encodeURIComponent(chave)).then(function(r){return r.json()}).then(function(s){
    var sem=s.tiktok.semEventosSegundos;
    var tkOk=s.tiktok.conectado&&(sem===null||sem<120);
    pintar("s-tiktok",tkOk,"TikTok: "+(s.tiktok.conectado?"conectado":"desconectado")+(sem!==null?" ("+sem+"s sem eventos)":""));
    var uj=s.jogo.ultimaBuscaSegundos;
    pintar("s-jogo",s.jogo.conectado,"Jogo: "+(s.jogo.conectado?"conectado":"SEM RESPOSTA")+(uj!==null?" (busca há "+uj+"s)":""));
    el("s-esp").textContent="Espectadores: "+(s.espectadores===null||s.espectadores===undefined?"-":s.espectadores);
    el("s-live").textContent="Curtidas da live: "+(s.curtidasLive===null||s.curtidasLive===undefined?"-":s.curtidasLive);
    el("s-com").textContent="Comentários: "+s.comentarios;
    el("s-fila").textContent="Fila do servidor: "+s.filaPendente;
    if(!tkOk||!s.jogo.conectado) bipar();

    var e=s.jogoEstado;
    if(e){
      el("j-vagas").textContent="Vagas: "+e.vagas+"/"+e.totalVagas;
      el("j-meta").textContent="Meta de curtidas: "+e.curtidas+" / "+e.meta;
      var nomes=(e.podio||[]).map(function(p,i){return (i+1)+"º @"+p.nick+" ("+p.moedas+")"});
      el("j-podio").textContent="Pódio: "+(nomes.length?nomes.join("  "):"vazio");
      el("j-modo").textContent="Câmera: "+(NOMES_CAMERA[e.camera]||e.camera)+" | Entrada: "+(e.entrada==="fila"?"fila":"último")+(e.pausado?" | ENTRADAS PAUSADAS":"")+(e.intervalo?" | INTERVALO NO AR":"");
      ["auto","geral","podio","dj","vaga1","ultimo"].forEach(function(m){ el("cam-"+m).className=(e.camera===m?"ativo":"") });
      sincronizar("sel-entrada",e.entrada); sincronizar("sel-limite",e.limite); sincronizar("sel-atraso",e.atraso); sincronizar("sel-animacao",e.animacao);
    }
  }).catch(function(){pintar("s-tiktok",false,"Servidor sem resposta"); bipar()});
}
atualizar();setInterval(atualizar,3000);
</script></body></html>`;

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
  eventos.push({
    tipo: "status",
    conectado: estadoOk,
    semEventos: ultimoEventoEm ? Math.round((Date.now() - ultimoEventoEm) / 1000) : 0,
  });
  ultimaBuscaJogo = Date.now();
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

// Comandos do painel (computador) para o jogo.
app.get("/comando", (req, res) => {
  if (!exigirChave(req, res)) return;
  const acao = String(req.query.acao || "");
  const valor = String(req.query.valor || "").slice(0, 120);
  if (!/^[a-z_0-9]{1,30}$/.test(acao)) return res.status(400).json({ ok: false, erro: "ação inválida" });
  empurrar({ tipo: "comando", acao, valor });
  console.log("Comando do painel:", acao, valor);
  res.json({ ok: true });
});

// Situação geral (o painel consulta a cada poucos segundos).
app.get("/status", (req, res) => {
  if (!exigirChave(req, res)) return;
  const agora = Date.now();
  res.json({
    tiktok: {
      conectado: estadoOk,
      estado: estadoConexao,
      semEventosSegundos: ultimoEventoEm ? Math.round((agora - ultimoEventoEm) / 1000) : null,
    },
    jogo: {
      ultimaBuscaSegundos: ultimaBuscaJogo ? Math.round((agora - ultimaBuscaJogo) / 1000) : null,
      conectado: ultimaBuscaJogo > 0 && agora - ultimaBuscaJogo < 8000,
    },
    comentarios: totalComentarios,
    filaPendente: fila.length,
    espectadores,
    curtidasLive,
    jogoEstado,
    jogoEstadoSegundos: jogoEstadoEm ? Math.round((agora - jogoEstadoEm) / 1000) : null,
  });
});

// O jogo manda um resumo do estado dele (para o painel mostrar).
app.get("/estado", (req, res) => {
  if (!exigirChave(req, res)) return;
  try {
    const d = JSON.parse(String(req.query.d || "{}"));
    if (d && typeof d === "object") {
      jogoEstado = d;
      jogoEstadoEm = Date.now();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, erro: "dados inválidos" });
  }
});

// Painel de controle (abra no navegador do computador: /painel?chave=SUA_CHAVE)
app.get("/painel", (req, res) => {
  if (!exigirChave(req, res)) return;
  res.send(PAINEL_HTML);
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

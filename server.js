const express = require("express");
const app = express();

const PORTA = process.env.PORT || 3000;
const CHAVE = process.env.CHAVE || "troque-esta-chave";
const LIMITE_SEGUNDOS = 60; // máximo de tempo acumulado na fila

// Tabela presente -> ação (edite à vontade)
// segundos = duração da ação por 1 presente
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
  if (!regra) return { ok: false, motivo: "presente sem ação" };

  const segundos = regra.segundos * qtd;
  const espaco = LIMITE_SEGUNDOS - segundosNaFila();
  if (espaco <= 0) return { ok: false, motivo: "fila cheia" };

  fila.push({ acao: regra.acao, segundos: Math.min(segundos, espaco) });
  return { ok: true };
}

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

// Passo 6 (depois): aqui entra o leitor de presentes do TikTok,
// chamando adicionarPresente(nomeDoPresente, quantidade).

app.listen(PORTA, () => console.log("Rodando na porta " + PORTA));

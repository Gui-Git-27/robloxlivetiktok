// bridge.js
// Este é o servidor "ponte" entre a live da TikTok e o jogo no Roblox.
// Ele fica escutando a live 24h e guarda uma fila de eventos (comentários e doações).
// O Roblox vai consultar essa fila de tempos em tempos (Fase 2).

const express = require('express');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const PORT = process.env.PORT || 3000;

// Troque aqui pelo @ da conta da TikTok que vai estar ao vivo
const TIKTOK_USERNAME = 'guipmxz';

// Fila de eventos pendentes que o Roblox ainda não pegou
let eventQueue = [];

// Chave simples de segurança: só quem souber essa chave consegue ler os eventos.
// Troque por algo só seu antes de colocar no ar.
const SECRET_KEY = 'T7@KP4!XN9#M';

function connectToTikTok() {
  const connection = new WebcastPushConnection(TIKTOK_USERNAME);

  connection.connect().then(state => {
    console.log(`Conectado à live de @${TIKTOK_USERNAME} (roomId: ${state.roomId})`);
  }).catch(err => {
    console.error('Erro ao conectar na live:', err);
    console.log('Tentando reconectar em 10 segundos...');
    setTimeout(connectToTikTok, 10000);
  });

  // Alguém comentou
  connection.on('chat', data => {
    eventQueue.push({
      type: 'comment',
      nickname: data.nickname,
      uniqueId: data.uniqueId,
      comment: data.comment,
      timestamp: Date.now()
    });
  });

  // Alguém enviou um presente (gift)
  connection.on('gift', data => {
    // Só registra quando o combo do presente termina (evita duplicar durante o "streak")
    if (!data.giftType || data.giftType !== 1 || data.repeatEnd) {
      eventQueue.push({
        type: 'gift',
        nickname: data.nickname,
        uniqueId: data.uniqueId,
        giftName: data.giftName,
        repeatCount: data.repeatCount,
        timestamp: Date.now()
      });
    }
  });

  connection.on('disconnected', () => {
    console.log('Desconectado da live. Tentando reconectar...');
    setTimeout(connectToTikTok, 5000);
  });
}

// Rota que o Roblox vai chamar pra pegar os eventos novos
app.get('/events', (req, res) => {
  if (req.query.key !== SECRET_KEY) {
    return res.status(401).json({ error: 'chave inválida' });
  }

  // Devolve tudo que está na fila e limpa (o Roblox não vai receber repetido)
  const events = eventQueue;
  eventQueue = [];
  res.json({ events });
});

// Rota simples só pra saber se o servidor está de pé
app.get('/', (req, res) => {
  res.send('Bridge TikTok -> Roblox rodando.');
});

app.listen(PORT, () => {
  console.log(`Servidor ponte rodando na porta ${PORT}`);
  connectToTikTok();
});

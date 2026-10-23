// Serveur PvP Sports TCG Elite : npm i socket.io && node server.js
const { Server } = require('socket.io');
const PORT = process.env.PORT || 3000;
const io = new Server(PORT, { cors: { origin: '*' } });
const rooms = {}, code = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const clean = (id, d = {}) => ({ id, name: String(d.name || 'Joueur').slice(0, 20), ovr: +d.ovr || 0, bonus: Math.max(0, +d.bonus || 0), stake: Math.max(0, Math.min(5000, +d.stake || 0)),
  cards: (Array.isArray(d.cards) ? d.cards : []).slice(0, 5).map(c => ({ n: String(c.n).slice(0, 40), sl: String(c.sl || ''), sp: String(c.sp || ''), c: String(c.c || ''), s: Math.max(1, Math.min(150, +c.s || 90)) })) });
io.on('connection', s => {
  s.on('create_room', d => { const rc = code(); rooms[rc] = { players: [clean(s.id, d)] }; s.join(rc); s.data.room = rc; s.emit('room_created', { roomCode: rc }); });
  s.on('join_room', ({ roomCode, playerData } = {}) => {
    const r = rooms[roomCode]; if (!r || r.players.length !== 1) return s.emit('error_message', 'Salon introuvable ou complet.');
    r.players.push(clean(s.id, playerData)); s.join(roomCode); s.data.room = roomCode;
    io.to(roomCode).emit('match_start', { players: r.players });
  });
  s.on('decline_match', rc => { io.to(rc).emit('opponent_left'); delete rooms[rc]; });
  s.on('start_battle', rc => {
    const r = rooms[rc]; if (!r || r.players.length !== 2 || r.players[0].id !== s.id) return;
    // 5 duels : score de la carte ±10 % (aléatoire) + bonus d'équipe
    const side = p => { const base = p.cards.length === 5 ? p.cards.map(c => c.s) : Array(5).fill(p.ovr - p.bonus);
      const rounds = base.map(v => Math.round(v * (0.9 + Math.random() * 0.2)) + p.bonus); return { id: p.id, name: p.name, rounds, total: rounds.reduce((a, b) => a + b, 0) }; };
    const a = side(r.players[0]), b = side(r.players[1]);
    io.to(rc).emit('battle_result', { winnerId: a.total === b.total ? null : a.total > b.total ? a.id : b.id, p1: a, p2: b, stake: r.players[0].stake });
    delete rooms[rc];
  });
  s.on('disconnect', () => { const rc = s.data.room; if (rc && rooms[rc]) { io.to(rc).emit('opponent_left'); delete rooms[rc]; } });
});
console.log('Serveur PvP démarré sur le port ' + PORT);
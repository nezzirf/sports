// server.js — Sports TCG Elite (PvP)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};              // code du salon -> { id, stake, players: [...] }
const socketRoom = new Map();  // id du socket -> code du salon
const ALLOWED_STAKES = [0, 50, 100, 250, 500]; // mêmes mises que dans le jeu

// ---------- Utilitaires ----------
function generateRoomCode() {
    let code;
    do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
    while (code.length < 6 || rooms[code]);
    return code;
}

const txt = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const num = (v, fallback = 0) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);

// Les cartes envoyées par le client : { n: nom, sl: slug Wikipédia, sp: sport, c: pays, s: score }
function cleanCards(cards) {
    if (!Array.isArray(cards)) return [];
    return cards.slice(0, 5).map(c => ({
        n: txt(c && c.n, 60),
        sl: txt(c && c.sl, 120),
        sp: txt(c && c.sp, 40),
        c: txt(c && c.c, 10),
        s: num(c && c.s, 95)
    }));
}

function buildPlayer(socket, data, fallbackName) {
    data = data && typeof data === 'object' ? data : {};
    const stake = num(data.stake, 0);
    return {
        id: socket.id,
        name: txt(data.name, 30) || fallbackName,
        ovr: num(data.ovr, 0),
        bonus: num(data.bonus, 0),
        stake: ALLOWED_STAKES.includes(stake) ? stake : 0,
        cards: cleanCards(data.cards),
        deck: Array.isArray(data.deck) ? data.deck.slice(0, 5) : [],
        equipments: data.equipments && typeof data.equipments === 'object' ? data.equipments : {}
    };
}

// Quitte le salon du joueur (annulation, refus de mise, déconnexion...) et prévient l'adversaire.
function leaveRoom(socket) {
    const code = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    delete rooms[code];
    room.players.forEach(p => { if (p.id !== socket.id) socketRoom.delete(p.id); });
    socket.to(code).emit('opponent_left');
    socket.leave(code);
}

// ---------- Événements ----------
io.on('connection', (socket) => {
    console.log('Joueur connecté :', socket.id);

    // 1. Créer un salon
    socket.on('create_room', (playerData) => {
        leaveRoom(socket); // un joueur ne peut avoir qu'un seul salon à la fois
        const roomCode = generateRoomCode();
        const host = buildPlayer(socket, playerData, 'Joueur 1');
        rooms[roomCode] = { id: roomCode, stake: host.stake, players: [host], finished: false, rematch: new Set() };
        socketRoom.set(socket.id, roomCode);

        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
        console.log(`Salon créé : ${roomCode} par ${socket.id} (mise ${host.stake} SP)`);
    });

    // 2. Rejoindre un salon
    socket.on('join_room', (payload) => {
        const { roomCode, playerData } = payload || {};
        const code = txt(roomCode, 12).toUpperCase();
        const room = rooms[code];

        if (!room) { socket.emit('error_message', 'Salon introuvable.'); return; }
        if (room.players.some(p => p.id === socket.id)) { socket.emit('error_message', 'Tu ne peux pas rejoindre ton propre salon.'); return; }
        if (room.players.length >= 2) { socket.emit('error_message', 'Le salon est complet.'); return; }

        leaveRoom(socket); // quitte un éventuel autre salon

        const guest = buildPlayer(socket, playerData, 'Joueur 2');
        guest.stake = room.stake; // la mise est celle fixée par le créateur du salon
        room.players.push(guest);
        socketRoom.set(socket.id, code);
        socket.join(code);

        // Les deux joueurs reçoivent le deck complet (noms, photos, scores, bonus, mise)
        io.to(code).emit('match_start', { players: room.players });
        console.log(`Joueur ${socket.id} a rejoint le salon : ${code}`);
    });

    // 3. Un joueur refuse le match (ex. pas assez de SP pour la mise)
    socket.on('decline_match', () => {
        leaveRoom(socket);
    });

    // 4. Lancement du combat (réservé au créateur du salon)
    socket.on('start_battle', () => {
        const code = socketRoom.get(socket.id);
        const room = code && rooms[code];
        if (!room || room.players.length < 2) return;
        if (room.players[0].id !== socket.id) return;
        if (room.finished) return; // ce combat a déjà été joué

        const [p1, p2] = room.players;

        // Combat basé sur l'OVR + un facteur aléatoire
        const roll1 = Math.floor(Math.random() * 10);
        const roll2 = Math.floor(Math.random() * 10);
        const score1 = p1.ovr + roll1;
        const score2 = p2.ovr + roll2;

        let winnerId = null;
        if (score1 > score2) winnerId = p1.id;
        else if (score2 > score1) winnerId = p2.id;

        // Le salon reste ouvert pour permettre de rejouer
        room.finished = true;
        room.rematch = new Set();

        io.to(code).emit('battle_result', {
            p1: { name: p1.name, ovr: p1.ovr, roll: roll1, total: score1 },
            p2: { name: p2.name, ovr: p2.ovr, roll: roll2, total: score2 },
            winnerId
        });

    });

    // 5. Rejouer : quand les deux joueurs cliquent, un nouveau match démarre dans le même salon
    socket.on('rematch', () => {
        const code = socketRoom.get(socket.id);
        const room = code && rooms[code];
        if (!room || room.players.length < 2 || !room.finished) return;

        socket.emit('rematch_ack');
        room.rematch.add(socket.id);

        if (room.rematch.size >= 2) {
            room.finished = false;
            room.rematch = new Set();
            io.to(code).emit('match_start', { players: room.players });
        } else {
            socket.to(code).emit('rematch_waiting');
        }
    });

    // 6. Un joueur quitte volontairement le salon (bouton « Retour à l'arène »)
    socket.on('leave_room', () => {
        leaveRoom(socket);
    });

    socket.on('disconnect', () => {
        console.log('Joueur déconnecté :', socket.id);
        leaveRoom(socket);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur PvP démarré sur le port ${PORT}`);
});

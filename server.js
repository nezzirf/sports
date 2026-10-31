// server.js — Sports TCG Elite (PvP)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e5 // une équipe pèse quelques Ko : inutile d'accepter le 1 Mo par défaut
});

const rooms = {};              // code du salon -> { id, stake, players: [...] }
const socketRoom = new Map();  // id du socket -> code du salon
const ALLOWED_STAKES = [0, 50, 100, 250, 500]; // mêmes mises que dans le jeu
const MODES = ['classic', 'nation', 'sport'];   // classique / même nationalité / même sport
const INVALID_TEAM = 'Équipe invalide : il faut 5 athlètes différents respectant le mode de combat.';
const ROLL_MAX = 4;          // chaque duel ajoute un tirage aléatoire de 0 à 4
const TEAM_DUEL_POINTS = 2;  // le duel d'équipe (note générale, bonus compris) compte double
const MAX_CARD_SCORE = 110;  // note maximale d'une carte : 100 + 2 équipements à +5
const MAX_TEAM_BONUS = 18;   // 4 (pays) + 4 (sport) + 10 (albums)
const roll = () => Math.floor(Math.random() * (ROLL_MAX + 1));

// 5 duels d'athlètes (note de base, sans bonus d'équipe) + 1 duel d'équipe (2 points) = 7 points en jeu
function resolveBattle(p1, p2) {
    const base = (p, i) => (p.cards[i] && Number.isFinite(p.cards[i].s) ? p.cards[i].s : Math.round(p.ovr - p.bonus));
    const side = p => ({ name: p.name, ovr: p.ovr, bonus: p.bonus, rounds: [], rolls: [], points: 0 });
    const s1 = side(p1), s2 = side(p2);

    for (let i = 0; i < 5; i++) {
        const r1 = roll(), r2 = roll();
        const a = base(p1, i) + r1, b = base(p2, i) + r2;
        s1.rounds.push(a); s1.rolls.push(r1);
        s2.rounds.push(b); s2.rolls.push(r2);
        if (a > b) s1.points += 1;
        else if (b > a) s2.points += 1;
    }

    s1.teamRoll = roll(); s2.teamRoll = roll();
    s1.team = p1.ovr + s1.teamRoll;
    s2.team = p2.ovr + s2.teamRoll;
    if (s1.team > s2.team) s1.points += TEAM_DUEL_POINTS;
    else if (s2.team > s1.team) s2.points += TEAM_DUEL_POINTS;

    let winnerId = null;
    if (s1.points > s2.points) winnerId = p1.id;
    else if (s2.points > s1.points) winnerId = p2.id;

    return { version: 2, p1: s1, p2: s2, winnerId };
}

// ---------- Utilitaires ----------
function generateRoomCode() {
    let code;
    do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
    while (code.length < 6 || rooms[code]);
    return code;
}

const txt = (v, max, fallback = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const num = (v, fallback = 0) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Les cartes envoyées par le client : { n: nom, sl: slug Wikipédia, sp: sport, c: pays, s: score }
function cleanCards(cards) {
    if (!Array.isArray(cards)) return [];
    return cards.slice(0, 5).map(c => ({
        n: txt(c && c.n, 60),
        sl: txt(c && c.sl, 120),
        sp: txt(c && c.sp, 40),
        c: txt(c && c.c, 10),
        s: clamp(Math.round(num(c && c.s, 95)), 0, MAX_CARD_SCORE)
    }));
}

const cleanMode = m => (MODES.includes(m) ? m : 'classic');

// Vérifie que l'équipe respecte le mode du salon (5 athlètes différents, même pays ou même sport)
function validTeam(mode, cards) {
    if (!Array.isArray(cards) || cards.length !== 5) return false;
    if (new Set(cards.map(c => c.sl || c.n)).size !== 5) return false;
    if (mode === 'classic') return true;
    const key = mode === 'nation' ? 'c' : 'sp';
    const first = cards[0][key];
    if (!first) return false;
    return cards.every(c => c[key] === first);
}

function buildPlayer(socket, data, fallbackName, mode) {
    data = data && typeof data === 'object' ? data : {};
    const stake = num(data.stake, 0);
    const cards = cleanCards(data.cards);
    const bonus = clamp(Math.round(num(data.bonus, 0)), 0, MAX_TEAM_BONUS);
    return {
        id: socket.id,
        name: txt(data.name, 30) || fallbackName,
        // La note d'équipe est recalculée ici : celle envoyée par le client n'est pas fiable
        ovr: Math.round(cards.reduce((t, c) => t + c.s, 0) / 5) + bonus,
        bonus,
        stake: ALLOWED_STAKES.includes(stake) ? stake : 0,
        cards,
        group: mode === 'nation' ? (cards[0] && cards[0].c) || '' : mode === 'sport' ? (cards[0] && cards[0].sp) || '' : ''
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
    io.in(code).socketsLeave(code); // le joueur restant ne doit pas rester abonné à un salon supprimé
}

// ---------- Événements ----------
io.on('connection', (socket) => {
    console.log('Joueur connecté :', socket.id);

    // 1. Créer un salon
    socket.on('create_room', (playerData) => {
        const mode = cleanMode(playerData && playerData.mode);
        const host = buildPlayer(socket, playerData, 'Joueur 1', mode);
        if (!validTeam(mode, host.cards)) { socket.emit('error_message', INVALID_TEAM); return; }

        leaveRoom(socket); // un joueur ne peut avoir qu'un seul salon à la fois
        const roomCode = generateRoomCode();
        rooms[roomCode] = { id: roomCode, stake: host.stake, mode, players: [host], finished: false, rematch: new Set() };
        socketRoom.set(socket.id, roomCode);

        socket.join(roomCode);
        socket.emit('room_created', { roomCode, mode });
        console.log(`Salon créé : ${roomCode} par ${socket.id} (mode ${mode}, mise ${host.stake} SP)`);
    });

    // 1b. Un joueur regarde un salon avant de le rejoindre (pour connaître son mode de combat)
    socket.on('peek_room', (roomCode) => {
        const code = txt(roomCode, 12).toUpperCase();
        const room = rooms[code];
        if (!room || room.players.length >= 2) { socket.emit('room_info', { ok: false, roomCode: code, full: !!room }); return; }
        socket.emit('room_info', { ok: true, roomCode: code, mode: room.mode, stake: room.stake, host: room.players[0].name });
    });

    // 2. Rejoindre un salon
    socket.on('join_room', (payload) => {
        const { roomCode, playerData } = payload || {};
        const code = txt(roomCode, 12).toUpperCase();
        const room = rooms[code];

        if (!room) { socket.emit('error_message', 'Salon introuvable.'); return; }
        if (room.players.some(p => p.id === socket.id)) { socket.emit('error_message', 'Tu ne peux pas rejoindre ton propre salon.'); return; }
        if (room.players.length >= 2) { socket.emit('error_message', 'Le salon est complet.'); return; }

        const guest = buildPlayer(socket, playerData, 'Joueur 2', room.mode);
        if (!validTeam(room.mode, guest.cards)) { socket.emit('error_message', INVALID_TEAM); return; }

        leaveRoom(socket); // quitte un éventuel autre salon
        guest.stake = room.stake; // la mise est celle fixée par le créateur du salon
        room.players.push(guest);
        socketRoom.set(socket.id, code);
        socket.join(code);

        // Les deux joueurs reçoivent le deck complet (noms, photos, scores, bonus, mise)
        io.to(code).emit('match_start', { players: room.players, mode: room.mode });
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

        const result = resolveBattle(p1, p2);

        // Le salon reste ouvert pour permettre de rejouer
        room.finished = true;
        room.rematch = new Set();

        io.to(code).emit('battle_result', result);

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
            io.to(code).emit('match_start', { players: room.players, mode: room.mode });
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

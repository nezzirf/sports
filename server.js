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
const TEAM_DUEL_FACTOR = 2;  // le duel d'équipe (note générale, bonus compris) compte double
const MAX_CARD_SCORE = 115;  // note maximale d'une carte : 100 + 2 équipements à +5 + 5 niveaux de fusion
const MAX_TEAM_BONUS = 18;   // 4 (pays) + 4 (sport) + 10 (albums)
const PLACE_SECONDS = Number(process.env.PVP_PLACE_SECONDS) || 40; // temps pour placer ses athlètes dans l'ordre des duels
const PLACE_GRACE_MS = 1500;   // marge de latence avant que le serveur ne lance le combat tout seul
const QUEUE_MAX_MS = 90 * 1000; // attente maximale dans la file du combat rapide
const IDENTITY = [0, 1, 2, 3, 4];

// Un ordre valide est une permutation de 0..4 : le duel n° i oppose la carte order1[i] à la carte order2[i].
function cleanOrder(o) {
    if (!Array.isArray(o) || o.length !== 5) return null;
    const v = o.map(Number);
    return v.every(Number.isInteger) && new Set(v).size === 5 && v.every(i => i >= 0 && i <= 4) ? v : null;
}

// 5 duels d'athlètes (note de base, sans bonus d'équipe) + 1 duel d'équipe (note générale).
// Le gagnant d'un duel marque l'écart entre les deux notes (l'écart du duel d'équipe compte double).
function resolveBattle(p1, p2, order1, order2) {
    const o1 = cleanOrder(order1) || IDENTITY, o2 = cleanOrder(order2) || IDENTITY;
    const base = (p, o, i) => { const c = p.cards[o[i]]; return c && Number.isFinite(c.s) ? c.s : Math.round(p.ovr - p.bonus); };
    const side = (p, o) => ({ name: p.name, ovr: p.ovr, bonus: p.bonus, order: o, rounds: [], points: 0 });
    const s1 = side(p1, o1), s2 = side(p2, o2);

    for (let i = 0; i < 5; i++) {
        const a = base(p1, o1, i), b = base(p2, o2, i);
        s1.rounds.push(a);
        s2.rounds.push(b);
        if (a > b) s1.points += a - b;
        else if (b > a) s2.points += b - a;
    }

    s1.team = p1.ovr;
    s2.team = p2.ovr;
    if (s1.team > s2.team) s1.points += (s1.team - s2.team) * TEAM_DUEL_FACTOR;
    else if (s2.team > s1.team) s2.points += (s2.team - s1.team) * TEAM_DUEL_FACTOR;

    let winnerId = null;
    if (s1.points > s2.points) winnerId = p1.id;
    else if (s2.points > s1.points) winnerId = p2.id;

    return { version: 3, p1: s1, p2: s2, winnerId };
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
        placement: data.placement === true, // le client sait placer ses athlètes (sinon : ancien déroulement)
        group: mode === 'nation' ? (cards[0] && cards[0].c) || '' : mode === 'sport' ? (cards[0] && cards[0].sp) || '' : ''
    };
}

// Quitte le salon du joueur (annulation, refus de mise, déconnexion...) et prévient l'adversaire.
function leaveRoom(socket) {
    queue.delete(socket.id); // quitter = aussi sortir de la file du combat rapide
    const code = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    clearTimeout(room.timer);
    delete rooms[code];
    room.players.forEach(p => { if (p.id !== socket.id) socketRoom.delete(p.id); });
    socket.to(code).emit('opponent_left');
    io.in(code).socketsLeave(code); // le joueur restant ne doit pas rester abonné à un salon supprimé
}

// ---------- Placement des athlètes, début et fin de combat ----------
function emitMatchStart(code, room) {
    room.placement = room.players.length === 2 && room.players.every(p => p.placement);
    room.orders = {};
    clearTimeout(room.timer);
    io.to(code).emit('match_start', { players: room.players, mode: room.mode, roomCode: code, placement: room.placement, placeSeconds: PLACE_SECONDS });
    // Si un joueur ne valide pas à temps, le combat part quand même avec l'ordre reçu (ou l'ordre de base)
    if (room.placement) room.timer = setTimeout(() => finishBattle(code), PLACE_SECONDS * 1000 + PLACE_GRACE_MS);
}

function finishBattle(code) {
    const room = rooms[code];
    if (!room || room.players.length < 2 || room.finished) return;
    clearTimeout(room.timer);
    const [p1, p2] = room.players;
    const result = resolveBattle(p1, p2, room.orders[p1.id], room.orders[p2.id]);
    // Le salon reste ouvert pour permettre de rejouer
    room.finished = true;
    room.rematch = new Set();
    io.to(code).emit('battle_result', result);
}

// ---------- Combat rapide : file d'attente ----------
// Deux joueurs sont appariés s'ils ont le même mode et la même mise, et des notes proches.
// L'écart toléré grandit avec le temps d'attente pour que personne ne reste bloqué.
const queue = new Map(); // id du socket -> { socket, player, mode, stake, since }
const tolerance = (e, now) => 4 + Math.floor((now - e.since) / 4000) * 4;

function startQueuedMatch(a, b) {
    queue.delete(a.socket.id); queue.delete(b.socket.id);
    const code = generateRoomCode();
    a.player.stake = b.player.stake = a.stake;
    rooms[code] = { id: code, stake: a.stake, mode: a.mode, players: [a.player, b.player], finished: false, rematch: new Set(), orders: {} };
    [a, b].forEach(e => { socketRoom.set(e.socket.id, code); e.socket.join(code); });
    console.log(`Combat rapide : salon ${code} (${a.mode}, mise ${a.stake} SP)`);
    emitMatchStart(code, rooms[code]);
}

function tryMatchmaking() {
    const now = Date.now(), list = [...queue.values()], used = new Set();
    list.forEach(e => { if (now - e.since > QUEUE_MAX_MS) { queue.delete(e.socket.id); used.add(e); e.socket.emit('queue_timeout'); } });
    for (const a of list) {
        if (used.has(a)) continue;
        let best = null, bestGap = Infinity;
        for (const b of list) {
            if (b === a || used.has(b) || b.mode !== a.mode || b.stake !== a.stake) continue;
            const gap = Math.abs(a.player.ovr - b.player.ovr);
            if (gap <= Math.max(tolerance(a, now), tolerance(b, now)) && gap < bestGap) { best = b; bestGap = gap; }
        }
        if (best) { used.add(a); used.add(best); startQueuedMatch(a, best); }
    }
}
setInterval(tryMatchmaking, 1500).unref();

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
        rooms[roomCode] = { id: roomCode, stake: host.stake, mode, players: [host], finished: false, rematch: new Set(), orders: {} };
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
        emitMatchStart(code, room);
        console.log(`Joueur ${socket.id} a rejoint le salon : ${code}`);
    });

    // 3. Un joueur refuse le match (ex. pas assez de SP pour la mise)
    socket.on('decline_match', () => {
        leaveRoom(socket);
    });

    // 4. Lancement du combat (ancien déroulement, réservé au créateur du salon).
    // Avec le placement des athlètes, le combat part tout seul quand les deux joueurs sont prêts.
    socket.on('start_battle', () => {
        const code = socketRoom.get(socket.id);
        const room = code && rooms[code];
        if (!room || room.players.length < 2 || room.placement) return;
        if (room.players[0].id !== socket.id) return;
        finishBattle(code);
    });

    // 4b. Un joueur valide l'ordre de ses athlètes (le combat part dès que les deux sont prêts)
    socket.on('ready', (payload) => {
        const code = socketRoom.get(socket.id);
        const room = code && rooms[code];
        if (!room || room.players.length < 2 || !room.placement || room.finished) return;
        if (room.orders[socket.id]) return; // ordre déjà verrouillé
        const order = cleanOrder(payload && payload.order);
        if (!order) { socket.emit('error_message', 'Ordre des athlètes invalide.'); return; }
        room.orders[socket.id] = order;
        socket.to(code).emit('opponent_ready');
        if (room.players.every(p => room.orders[p.id])) finishBattle(code);
    });

    // 4c. Combat rapide
    socket.on('find_match', (playerData) => {
        const mode = cleanMode(playerData && playerData.mode);
        const player = buildPlayer(socket, playerData, 'Joueur', mode);
        if (!validTeam(mode, player.cards)) { socket.emit('error_message', INVALID_TEAM); return; }
        player.placement = true; // le combat rapide passe toujours par le placement
        leaveRoom(socket); // un joueur ne peut être qu'à un seul endroit à la fois
        queue.set(socket.id, { socket, player, mode, stake: player.stake, since: Date.now() });
        socket.emit('queue_joined', { mode, stake: player.stake });
        tryMatchmaking();
    });

    socket.on('cancel_queue', () => {
        if (queue.delete(socket.id)) socket.emit('queue_left');
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
            emitMatchStart(code, room);
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

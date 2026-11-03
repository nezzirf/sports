// Tests du serveur PvP : lance le vrai server.js et joue avec de vrais clients Socket.IO.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3457, URL = `http://localhost:${PORT}`;
let server;
const clients = [];

before(async () => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, PVP_PLACE_SECONDS: '1' } });
    await new Promise((resolve, reject) => {
        server.stdout.once('data', resolve);
        server.once('exit', code => reject(new Error('serveur arrêté : ' + code)));
    });
});

after(() => {
    clients.forEach(c => c.close());
    server.removeAllListeners('exit');
    server.kill();
});

const connect = () => new Promise(resolve => {
    const c = io(URL, { transports: ['websocket'], forceNew: true });
    clients.push(c);
    c.once('connect', () => resolve(c));
});
const once = (c, ev, ms = 2000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pas de ' + ev)), ms);
    c.once(ev, data => { clearTimeout(t); resolve(data); });
});
const team = (s = 90, extra = {}) => ({
    name: 'Test', bonus: 0, stake: 0, mode: 'classic',
    cards: [0, 1, 2, 3, 4].map(i => ({ n: 'A' + i, sl: 'A_' + i, sp: 'Tennis', c: 'FR', s })),
    ...extra
});
async function match(a, b) {
    const host = await connect(), guest = await connect();
    host.emit('create_room', a);
    const { roomCode } = await once(host, 'room_created');
    const started = once(guest, 'match_start');
    guest.emit('join_room', { roomCode, playerData: b });
    return { host, guest, roomCode, start: await started };
}

test('GET /health répond', async () => {
    const res = await fetch(URL + '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).ok, true);
});

test('un combat est déterministe : chaque duel rapporte l\'écart des notes', async () => {
    const { host, guest, start } = await match(team(95), team(90));
    const result = once(guest, 'battle_result');
    host.emit('start_battle');
    const r = await result;
    assert.strictEqual(r.p1.rounds.length, 5);
    assert.deepStrictEqual(r.p1.rounds, [95, 95, 95, 95, 95]);
    assert.deepStrictEqual(r.p2.rounds, [90, 90, 90, 90, 90]);
    assert.strictEqual(r.p1.points, 5 * 5 + (r.p1.team - r.p2.team) * 2);
    assert.strictEqual(r.p2.points, 0);
    assert.strictEqual(r.winnerId, start.players[0].id);
});

test('la note d\'équipe envoyée par le client est ignorée', async () => {
    const { start } = await match(team(90, { ovr: 9999 }), team());
    assert.strictEqual(start.players[0].ovr, 90);
});

test('une note de carte ou un bonus truqués sont plafonnés', async () => {
    const { start } = await match(team(9999, { bonus: 9999 }), team());
    const p = start.players[0];
    assert.strictEqual(p.cards[0].s, 110);
    assert.strictEqual(p.bonus, 18);
    assert.strictEqual(p.ovr, 128);
});

test('les données inutiles ne sont pas renvoyées à l\'adversaire', async () => {
    const { start } = await match(team(90, { deck: ['x'], equipments: { a: 1 } }), team());
    assert.strictEqual(start.players[0].deck, undefined);
    assert.strictEqual(start.players[0].equipments, undefined);
});

test('une équipe incomplète ou avec doublons est refusée', async () => {
    const c = await connect();
    let err = once(c, 'error_message');
    c.emit('create_room', team(90, { cards: team().cards.slice(0, 4) }));
    assert.match(await err, /invalide/);
    err = once(c, 'error_message');
    c.emit('create_room', team(90, { cards: Array(5).fill(team().cards[0]) }));
    assert.match(await err, /invalide/);
});

test('le mode même sport refuse une équipe mélangée', async () => {
    const c = await connect(), cards = team().cards.map((x, i) => ({ ...x, sp: i ? 'Tennis' : 'Rugby' }));
    const err = once(c, 'error_message');
    c.emit('create_room', team(90, { mode: 'sport', cards }));
    assert.match(await err, /invalide/);
});

test('seul le créateur peut lancer le combat', async () => {
    const { host, guest } = await match(team(), team());
    let got = false;
    host.once('battle_result', () => { got = true; });
    guest.emit('start_battle');
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(got, false);
});

test('si un joueur part, l\'autre est prévenu et le salon disparaît', async () => {
    const { host, guest, roomCode } = await match(team(), team());
    const left = once(guest, 'opponent_left');
    host.emit('leave_room');
    await left;
    const info = once(guest, 'room_info');
    guest.emit('peek_room', roomCode);
    assert.strictEqual((await info).ok, false);
});

test('la revanche démarre quand les deux joueurs l\'acceptent', async () => {
    const { host, guest } = await match(team(), team());
    const result = once(host, 'battle_result');
    host.emit('start_battle');
    await result;
    const again = once(guest, 'match_start');
    host.emit('rematch');
    guest.emit('rematch');
    assert.strictEqual((await again).players.length, 2);
});

// ---------- Placement des athlètes ----------
const scored = (scores, extra = {}) => team(90, { placement: true, cards: scores.map((s, i) => ({ n: 'A' + i, sl: 'A_' + i, sp: 'Tennis', c: 'FR', s })), ...extra });

test('le placement est annoncé dans match_start', async () => {
    const { start } = await match(scored([90, 91, 92, 93, 94]), scored([90, 91, 92, 93, 94]));
    assert.strictEqual(start.placement, true);
    assert.strictEqual(start.placeSeconds, 1);
    assert.strictEqual(typeof start.roomCode, 'string');
});

test('le combat ne part que quand les deux joueurs ont placé leurs athlètes', async () => {
    const { host, guest } = await match(scored([90, 91, 92, 93, 94]), scored([80, 81, 82, 83, 84]));
    let early = false;
    guest.once('battle_result', () => { early = true; });
    host.emit('ready', { order: [0, 1, 2, 3, 4] });
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(early, false);
    const result = once(guest, 'battle_result');
    guest.emit('ready', { order: [0, 1, 2, 3, 4] });
    assert.strictEqual((await result).p1.rounds.length, 5);
});

test('l\'ordre choisi décide de l\'adversaire de chaque athlète', async () => {
    const { host, guest } = await match(scored([100, 90, 80, 70, 60]), scored([95, 85, 75, 65, 55]));
    const result = once(host, 'battle_result');
    host.emit('ready', { order: [4, 3, 2, 1, 0] });
    guest.emit('ready', { order: [0, 1, 2, 3, 4] });
    const r = await result;
    assert.deepStrictEqual(r.p1.rounds, [60, 70, 80, 90, 100]);
    assert.deepStrictEqual(r.p2.rounds, [95, 85, 75, 65, 55]);
    assert.deepStrictEqual(r.p1.order, [4, 3, 2, 1, 0]);
    // joueur 1 gagne 80>75 (+5), 90>65 (+25), 100>55 (+45) et le duel d'équipe (80 contre 75, écart 5 ×2)
    assert.strictEqual(r.p1.points, 5 + 25 + 45 + 10);
    // joueur 2 gagne 95>60 (+35) et 85>70 (+15)
    assert.strictEqual(r.p2.points, 35 + 15);
});

test('l\'ordre de l\'adversaire reste secret jusqu\'au résultat', async () => {
    const { host, guest } = await match(scored([90, 91, 92, 93, 94]), scored([90, 91, 92, 93, 94]));
    const seen = [];
    guest.on('opponent_ready', (...a) => seen.push(a));
    host.emit('ready', { order: [4, 3, 2, 1, 0] });
    await once(guest, 'opponent_ready');
    assert.deepStrictEqual(seen[0], []); // aucune donnée sur l'ordre
    guest.emit('ready', { order: [0, 1, 2, 3, 4] });
});

test('un ordre invalide est refusé puis le joueur peut en envoyer un bon', async () => {
    const { host, guest } = await match(scored([90, 91, 92, 93, 94]), scored([90, 91, 92, 93, 94]));
    const err = once(host, 'error_message');
    host.emit('ready', { order: [0, 0, 1, 2, 3] });
    assert.match(await err, /Ordre/);
    const result = once(host, 'battle_result');
    host.emit('ready', { order: [0, 1, 2, 3, 4] });
    guest.emit('ready', { order: [4, 3, 2, 1, 0] });
    await result;
});

test('un ordre ne peut plus être changé une fois verrouillé', async () => {
    const { host, guest } = await match(scored([100, 90, 80, 70, 60]), scored([100, 90, 80, 70, 60]));
    const result = once(host, 'battle_result');
    host.emit('ready', { order: [0, 1, 2, 3, 4] });
    host.emit('ready', { order: [4, 3, 2, 1, 0] });
    guest.emit('ready', { order: [0, 1, 2, 3, 4] });
    assert.deepStrictEqual((await result).p1.order, [0, 1, 2, 3, 4]);
});

test('si un joueur ne valide pas, le combat part quand même après le délai', async () => {
    const { host } = await match(scored([90, 91, 92, 93, 94]), scored([90, 91, 92, 93, 94]));
    const result = once(host, 'battle_result', 5000);
    host.emit('ready', { order: [4, 3, 2, 1, 0] });
    const r = await result;
    assert.deepStrictEqual(r.p1.order, [4, 3, 2, 1, 0]);
    assert.deepStrictEqual(r.p2.order, [0, 1, 2, 3, 4]); // ordre de base pour celui qui n'a rien envoyé
});

test('la revanche relance le placement', async () => {
    const { host, guest } = await match(scored([90, 91, 92, 93, 94]), scored([90, 91, 92, 93, 94]));
    const result = once(host, 'battle_result');
    host.emit('ready', { order: [0, 1, 2, 3, 4] });
    guest.emit('ready', { order: [0, 1, 2, 3, 4] });
    await result;
    const again = once(guest, 'match_start');
    host.emit('rematch');
    guest.emit('rematch');
    assert.strictEqual((await again).placement, true);
    const second = once(host, 'battle_result');
    host.emit('ready', { order: [0, 1, 2, 3, 4] });
    guest.emit('ready', { order: [0, 1, 2, 3, 4] });
    await second;
});

// ---------- Combat rapide ----------
const queued = async (data) => {
    const c = await connect();
    const joined = once(c, 'queue_joined');
    c.emit('find_match', data);
    await joined;
    return c;
};

test('le combat rapide apparie deux joueurs de niveau proche', async () => {
    const a = await connect(), b = await connect();
    const sa = once(a, 'match_start'), sb = once(b, 'match_start');
    a.emit('find_match', scored([90, 90, 90, 90, 90]));
    b.emit('find_match', scored([92, 92, 92, 92, 92]));
    const [ma, mb] = await Promise.all([sa, sb]);
    assert.strictEqual(ma.roomCode, mb.roomCode);
    assert.strictEqual(ma.placement, true);
    assert.strictEqual(ma.players.length, 2);
    // le salon créé fonctionne comme les autres
    const result = once(a, 'battle_result');
    a.emit('ready', { order: [0, 1, 2, 3, 4] });
    b.emit('ready', { order: [0, 1, 2, 3, 4] });
    assert.strictEqual((await result).p1.rounds.length, 5);
});

test('le combat rapide n\'apparie pas des mises ou des modes différents', async () => {
    const a = await queued(scored([90, 90, 90, 90, 90], { stake: 100 }));
    const b = await queued(scored([90, 90, 90, 90, 90], { stake: 50 }));
    const c = await queued(scored([90, 90, 90, 90, 90], { stake: 100, mode: 'sport' }));
    let started = false;
    [a, b, c].forEach(x => x.once('match_start', () => { started = true; }));
    await new Promise(r => setTimeout(r, 700));
    assert.strictEqual(started, false);
});

test('le combat rapide n\'apparie pas tout de suite des niveaux très éloignés', async () => {
    const a = await queued(scored([60, 60, 60, 60, 60]));
    const b = await queued(scored([100, 100, 100, 100, 100]));
    let started = false;
    [a, b].forEach(x => x.once('match_start', () => { started = true; }));
    await new Promise(r => setTimeout(r, 700));
    assert.strictEqual(started, false);
});

test('on peut annuler la recherche', async () => {
    const a = await queued(scored([90, 90, 90, 90, 90]));
    const left = once(a, 'queue_left');
    a.emit('cancel_queue');
    await left;
    const b = await connect();
    let started = false;
    a.once('match_start', () => { started = true; });
    b.once('match_start', () => { started = true; });
    b.emit('find_match', scored([90, 90, 90, 90, 90]));
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(started, false);
    b.emit('cancel_queue');
});

test('une équipe invalide est refusée dans la file', async () => {
    const c = await connect();
    const err = once(c, 'error_message');
    c.emit('find_match', scored([90, 90, 90, 90, 90], { cards: team().cards.slice(0, 3) }));
    assert.match(await err, /invalide/);
});

test('un joueur qui se déconnecte quitte la file', async () => {
    const a = await queued(scored([90, 90, 90, 90, 90]));
    a.close();
    await new Promise(r => setTimeout(r, 200));
    const b = await connect();
    let started = false;
    b.once('match_start', () => { started = true; });
    b.emit('find_match', scored([90, 90, 90, 90, 90]));
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(started, false);
    b.emit('cancel_queue');
});

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
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT } });
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
const once = (c, ev) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pas de ' + ev)), 2000);
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

test('un combat va au bout et distribue au plus 7 points', async () => {
    const { host, guest } = await match(team(), team());
    const result = once(guest, 'battle_result');
    host.emit('start_battle');
    const r = await result;
    assert.strictEqual(r.p1.rounds.length, 5);
    assert.ok(r.p1.points + r.p2.points <= 7);
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

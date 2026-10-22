// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

// Générer un code unique à 6 caractères
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('Joueur connecté :', socket.id);

    // 1. Créer un salon
    socket.on('create_room', (playerData) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            id: roomCode,
            players: [{ id: socket.id, name: playerData.name || 'Joueur 1', deck: playerData.deck, equipments: playerData.equipments, ovr: playerData.ovr }]
        };

        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
        console.log(`Salon créé : ${roomCode} par ${socket.id}`);
    });

    // 2. Rejoindre un salon
    socket.on('join_room', ({ roomCode, playerData }) => {
        const room = rooms[roomCode];

        if (!room) {
            socket.emit('error_message', 'Salon introuvable.');
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('error_message', 'Le salon est complet.');
            return;
        }

        room.players.push({
            id: socket.id,
            name: playerData.name || 'Joueur 2',
            deck: playerData.deck,
            equipments: playerData.equipments,
            ovr: playerData.ovr
        });

        socket.join(roomCode);
        
        // Informer les deux joueurs que le match commence
        io.to(roomCode).emit('match_start', {
            players: room.players
        });

        console.log(`Joueur ${socket.id} a rejoint le salon : ${roomCode}`);
    });

    // 3. Déclenchement / Simulation de combat PvP
    socket.on('start_battle', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.players.length < 2) return;

        const p1 = room.players[0];
        const p2 = room.players[1];

        // Exemple d'un combat rapide basé sur l'OVR et un facteur aléatoire (chance/stratégie)
        const roll1 = Math.floor(Math.random() * 10);
        const roll2 = Math.floor(Math.random() * 10);

        const score1 = p1.ovr + roll1;
        const score2 = p2.ovr + roll2;

        let winnerId = null;
        if (score1 > score2) winnerId = p1.id;
        else if (score2 > score1) winnerId = p2.id;

        io.to(roomCode).emit('battle_result', {
            p1: { name: p1.name, ovr: p1.ovr, roll: roll1, total: score1 },
            p2: { name: p2.name, ovr: p2.ovr, roll: roll2, total: score2 },
            winnerId
        });

        // Nettoyage du salon après le match
        delete rooms[roomCode];
    });

    socket.on('disconnect', () => {
        console.log('Joueur déconnecté :', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur PvP démarré sur le port ${PORT}`);
});
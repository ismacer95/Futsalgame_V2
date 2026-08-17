const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const WORLD_W = 500, WORLD_H = 900, GOAL_LIMIT = 3;
const CONFIG = { PLAYER_RAD: 22, BALL_RAD: 11, PLAYER_SPEED: 2.1, BALL_SPEED: 6.5, STEAL_DIST: 44, STEAL_PROB: 0.12, POST_L: 160, POST_R: 340, IMMUNE_TIME: 100 };

let rooms = {};
let clients = {};

function createGameState() {
    return {
        status: 'waiting', playersReady: { p1: false, p2: false },
        teamInfo: { p1: { name: 'AZUL', color: '#2563eb' }, p2: { name: 'ROJO', color: '#dc2626' } },
        players: [], ball: { x: 250, y: 450, vx: 0, vy: 0, lastTeam: 'p1' },
        score: { p1: 0, p2: 0 }, ballOwnerId: null, timeRemaining: 180, isOut: false, isGoal: false, turnToKick: null,
        outX: 0, outY: 0, pickupTimeRemaining: 5, kickTimeRemaining: 5, statusMsg: '', winner: null, lastTick: Date.now()
    };
}

function initMatch(state) {
    const c1 = state.teamInfo.p1.color; const c2 = state.teamInfo.p2.color;
    state.players = [
        { id: 0, x: 250, y: 845, team: 'p1', color: c1, target: null, immune: 0 }, { id: 1, x: 250, y: 680, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 2, x: 140, y: 520, team: 'p1', color: c1, target: null, immune: 0 }, { id: 3, x: 360, y: 520, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 4, x: 250, y: 470, team: 'p1', color: c1, target: null, immune: 0 }, { id: 5, x: 250, y: 55,  team: 'p2', color: c2, target: null, immune: 0 }, 
        { id: 6, x: 250, y: 220, team: 'p2', color: c2, target: null, immune: 0 }, { id: 7, x: 360, y: 380, team: 'p2', color: c2, target: null, immune: 0 }, 
        { id: 8, x: 140, y: 380, team: 'p2', color: c2, target: null, immune: 0 }, { id: 9, x: 250, y: 430, team: 'p2', color: c2, target: null, immune: 0 }
    ];
    state.ball = { x: 250, y: 450, vx: 0, vy: 0, lastTeam: 'p1' }; state.ballOwnerId = null; state.isGoal = false; state.isOut = false; state.turnToKick = null;
    state.pickupTimeRemaining = 5; state.kickTimeRemaining = 5; state.statusMsg = '';
}

function triggerOut(state, x, y, label, forcedTeam = null) {
    if (state.isOut || state.isGoal) return;
    state.isOut = true; state.turnToKick = forcedTeam || (state.ball.lastTeam === 'p1' ? 'p2' : 'p1');
    state.ball.vx = 0; state.ball.vy = 0; state.ballOwnerId = null; state.outX = x; state.outY = y;
    state.ball.x = x; state.ball.y = y; state.pickupTimeRemaining = 5; state.kickTimeRemaining = 5;
    state.statusMsg = `${label} - ${state.turnToKick === 'p1' ? state.teamInfo.p1.name : state.teamInfo.p2.name}`;
}

function goal(state, team) {
    if (state.isGoal) return;
    state.isGoal = true; team === 'p1' ? state.score.p1++ : state.score.p2++; state.statusMsg = '¡GOOOL!';
    if (state.score.p1 >= GOAL_LIMIT || state.score.p2 >= GOAL_LIMIT) {
        state.status = 'ended'; state.winner = state.score.p1 > state.score.p2 ? state.teamInfo.p1.name : state.teamInfo.p2.name;
    } else { setTimeout(() => { initMatch(state); triggerOut(state, 250, 450, "SAQUE", team === 'p1' ? 'p2' : 'p1'); }, 2500); }
}

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = createGameState();
        rooms[roomCode].teamInfo.p1 = { name: data.name.toUpperCase().substring(0, 10), color: data.color };
        initMatch(rooms[roomCode]); socket.join(roomCode); clients[socket.id] = { room: roomCode, team: 'p1' };
        socket.emit('init', { team: 'p1', roomCode: roomCode });
    });

    socket.on('joinRoom', (data) => {
        const roomCode = data.code.toUpperCase();
        if (!rooms[roomCode]) { socket.emit('joinError', 'Sala no encontrada'); return; }
        rooms[roomCode].teamInfo.p2 = { name: data.name.toUpperCase().substring(0, 10), color: data.color };
        initMatch(rooms[roomCode]); socket.join(roomCode); clients[socket.id] = { room: roomCode, team: 'p2' };
        socket.emit('init', { team: 'p2', roomCode: roomCode });
        io.to(roomCode).emit('stateUpdate', rooms[roomCode]);
    });

    socket.on('setReady', () => {
        const client = clients[socket.id];
        if (!client || !rooms[client.room]) return;
        const state = rooms[client.room];
        state.playersReady[client.team] = true;
        if (state.playersReady.p1 && state.playersReady.p2) {
            state.status = 'playing'; state.score = { p1: 0, p2: 0 }; state.timeRemaining = 180; state.lastTick = Date.now();
            initMatch(state); triggerOut(state, 250, 450, "SAQUE INICIO", 'p1');
        } else io.to(client.room).emit('stateUpdate', state);
    });

    socket.on('playerAction', (a) => {
        const client = clients[socket.id];
        if (!client || !rooms[client.room]) return;
        const state = rooms[client.room];
        const p = state.players.find(p => p.id === a.playerId);
        if (!p || p.team !== client.team) return;
        if (a.type === 'move') p.target = a.target;
        else if (a.type === 'shoot' && state.ballOwnerId === p.id) {
            state.ballOwnerId = null; state.ball.vx = a.vx; state.ball.vy = a.vy;
            if (state.isOut) state.isOut = false;
        }
    });

    socket.on('leaveRoom', () => {
        if(clients[socket.id]) { socket.leave(clients[socket.id].room); delete clients[socket.id]; }
    });
    socket.on('disconnect', () => { delete clients[socket.id]; });
});

setInterval(() => {
    for (const [roomCode, state] of Object.entries(rooms)) {
        if (state.status !== 'playing') { io.to(roomCode).emit('stateUpdate', state); continue; }
        if (!state.isGoal && !state.isOut) {
            if (Date.now() - state.lastTick >= 1000) { state.timeRemaining--; state.lastTick = Date.now(); if (state.timeRemaining <= 0) state.status = 'ended'; }
        } else state.lastTick = Date.now();
        io.to(roomCode).emit('stateUpdate', state);
    }
}, 1000/60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Servidor en puerto ${PORT}`));

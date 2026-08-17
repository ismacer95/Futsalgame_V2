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
        status: 'waiting', 
        playersReady: { p1: false, p2: false },
        teamInfo: { 
            p1: { name: 'AZUL', color: '#2563eb' }, 
            p2: { name: 'ROJO', color: '#dc2626' } 
        },
        players: [],
        ball: { x: 250, y: 450, vx: 0, vy: 0, lastTeam: 'p1' },
        score: { p1: 0, p2: 0 },
        ballOwnerId: null,
        timeRemaining: 180,
        isOut: false,
        isGoal: false,
        turnToKick: null,
        outX: 0, 
        outY: 0, 
        pickupTimeRemaining: 5, 
        kickTimeRemaining: 5,   
        statusMsg: '',
        winner: null,
        lastTick: Date.now()
    };
}

function initMatch(state, isKickoff = false) {
    const c1 = state.teamInfo.p1.color;
    const c2 = state.teamInfo.p2.color;
    
    state.players = [
        { id: 0, x: 250, y: 845, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 1, x: 250, y: 680, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 2, x: 140, y: 520, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 3, x: 360, y: 520, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 4, x: 250, y: 470, team: 'p1', color: c1, target: null, immune: 0 }, 
        { id: 5, x: 250, y: 55,  team: 'p2', color: c2, target: null, immune: 0 }, 
        { id: 6, x: 250, y: 220, team: 'p2', color: c2, target: null, immune: 0 }, 
        { id: 7, x: 360, y: 380, team: 'p2', color: c2, target: null, immune: 0 }, 
        { id: 8, x: 140, y: 380, team: 'p2', color: c2, target: null, immune: 0 }, 
        { id: 9, x: 250, y: 430, team: 'p2', color: c2, target: null, immune: 0 }  
    ];
    state.ball = { x: 250, y: 450, vx: 0, vy: 0, lastTeam: state.ball.lastTeam };
    state.ballOwnerId = null;
    state.isGoal = false;
    state.isOut = false;
    state.turnToKick = null;
    state.pickupTimeRemaining = 5;
    state.kickTimeRemaining = 5;
    state.statusMsg = '';

    if (isKickoff) {
        const receivingTeam = state.ball.lastTeam === 'p1' ? 'p2' : 'p1';
        triggerOut(state, 250, 450, "SAQUE INICIO", receivingTeam);
    }
}

function triggerOut(state, x, y, label, forcedTeam = null) {
    if (state.isOut || state.isGoal) return;
    state.isOut = true;
    state.turnToKick = forcedTeam || (state.ball.lastTeam === 'p1' ? 'p2' : 'p1');
    state.ball.vx = 0; state.ball.vy = 0;
    state.ballOwnerId = null;
    state.outX = x;
    state.outY = y;
    state.ball.x = x; 
    state.ball.y = y;
    state.pickupTimeRemaining = 5;
    state.kickTimeRemaining = 5;
    
    const teamName = state.turnToKick === 'p1' ? state.teamInfo.p1.name : state.teamInfo.p2.name;
    state.statusMsg = `${label} - ${teamName}`;
}

function handleEndLine(state, x, y, defendingTeam) {
    const isCorner = state.ball.lastTeam === defendingTeam;
    let type = isCorner ? "CORNER" : "SAQUE META";
    let kickX = x, kickY = y;
    if (isCorner) {
        kickX = x < WORLD_W/2 ? 35 : WORLD_W-35;
        kickY = (y < WORLD_H/2) ? 35 : WORLD_H-35;
    } else {
        kickX = 250;
        kickY = defendingTeam === 'p1' ? WORLD_H - 80 : 80;
    }
    triggerOut(state, kickX, kickY, type);
}

function goal(state, team) {
    if (state.isGoal) return;
    state.isGoal = true;
    team === 'p1' ? state.score.p1++ : state.score.p2++;
    state.statusMsg = '¡GOOOL!';
    state.ball.lastTeam = team;
    
    if (state.score.p1 >= GOAL_LIMIT || state.score.p2 >= GOAL_LIMIT) {
        state.status = 'ended';
        state.winner = state.score.p1 > state.score.p2 ? state.teamInfo.p1.name : state.teamInfo.p2.name;
        state.playersReady = { p1: false, p2: false }; 
    } else {
        setTimeout(() => initMatch(state, true), 2500);
    }
}

io.on('connection', (socket) => {
    
    socket.on('createRoom', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = createGameState();
        rooms[roomCode].teamInfo.p1 = { name: data.name.toUpperCase().substring(0, 10), color: data.color };
        initMatch(rooms[roomCode], false);
        
        socket.join(roomCode);
        clients[socket.id] = { room: roomCode, team: 'p1' };
        socket.emit('init', { team: 'p1', roomCode: roomCode });
    });

    socket.on('joinRoom', (data) => {
        const roomCode = data.code.toUpperCase();
        if (!rooms[roomCode]) {
            socket.emit('joinError', 'La sala no existe.');
            return;
        }
        
        const playersInRoom = Object.values(clients).filter(c => c.room === roomCode).length;
        if (playersInRoom >= 2) {
            socket.emit('joinError', 'La sala está llena.');
            return;
        }

        rooms[roomCode].teamInfo.p2 = { name: data.name.toUpperCase().substring(0, 10), color: data.color };
        initMatch(rooms[roomCode], false);

        socket.join(roomCode);
        clients[socket.id] = { room: roomCode, team: 'p2' };
        socket.emit('init', { team: 'p2', roomCode: roomCode });
        io.to(roomCode).emit('stateUpdate', rooms[roomCode]);
    });

    socket.on('setReady', () => {
        const client = clients[socket.id];
        if (!client || !rooms[client.room]) return;
        const state = rooms[client.room];

        state.playersReady[client.team] = true;
        if (state.playersReady.p1 && state.playersReady.p2 && state.status !== 'playing') {
            state.status = 'playing';
            state.score = { p1: 0, p2: 0 };
            state.timeRemaining = 180;
            state.lastTick = Date.now();
            initMatch(state, true);
        } else {
            io.to(client.room).emit('stateUpdate', state);
        }
    });

    socket.on('playerAction', (action) => {
        const client = clients[socket.id];
        if (!client || !rooms[client.room]) return;
        const state = rooms[client.room];

        if (state.status !== 'playing') return; 
        
        const player = state.players.find(p => p.id === action.playerId);
        if (!player || player.team !== client.team) return;

        if (action.type === 'move') {
            player.target = action.target;
        } else if (action.type === 'shoot' && state.ballOwnerId === player.id) {
            if (state.isOut && state.turnToKick !== player.team) return;

            state.ballOwnerId = null;
            state.ball.vx = action.vx;
            state.ball.vy = action.vy;
            state.ball.lastTeam = player.team;
            player.immune = 20;
            
            if (state.isOut) {
                state.isOut = false;
                state.statusMsg = '';
            }
        }
    });

    function handlePlayerLeave(socketId) {
        const client = clients[socketId];
        if (client) {
            const roomCode = client.room;
            delete clients[socketId]; 

            const playersLeft = Object.values(clients).filter(c => c.room === roomCode).length;
            if (playersLeft === 0) {
                delete rooms[roomCode];
            } else {
                const state = rooms[roomCode];
                if (state) {
                    state.playersReady[client.team] = false;
                    if (state.status === 'playing' || state.status === 'ended') {
                        state.status = 'waiting';
                        const disconnectedName = client.team === 'p1' ? state.teamInfo.p1.name : state.teamInfo.p2.name;
                        state.statusMsg = `SE DESCONECTÓ ${disconnectedName}`;
                    }
                    io.to(roomCode).emit('stateUpdate', state);
                }
            }
        }
    }

    socket.on('leaveRoom', () => {
        if (clients[socket.id]) {
            socket.leave(clients[socket.id].room);
            handlePlayerLeave(socket.id);
        }
    });

    socket.on('disconnect', () => {
        handlePlayerLeave(socket.id);
    });
});

setInterval(() => {
    for (const [roomCode, state] of Object.entries(rooms)) {
        if (state.status !== 'playing') {
            io.to(roomCode).emit('stateUpdate', state);
            continue; 
        }

        const now = Date.now();
        if (!state.isGoal && !state.isOut) {
            if (now - state.lastTick >= 1000) {
                state.timeRemaining--;
                state.lastTick = now;
                if (state.timeRemaining <= 0) {
                    state.status = 'ended';
                    if (state.score.p1 > state.score.p2) state.winner = state.teamInfo.p1.name;
                    else if (state.score.p2 > state.score.p1) state.winner = state.teamInfo.p2.name;
                    else state.winner = 'EMPATE';
                    
                    state.playersReady = { p1: false, p2: false };
                }
            }
        } else {
            state.lastTick = now;
        }

        state.players.forEach(p => {
            if (p.immune > 0) p.immune--;
            
            // Distancia mínima de 85px en saques
            if (state.isOut && p.team !== state.turnToKick) {
                const dist = Math.hypot(p.x - state.outX, p.y - state.outY);
                if (dist < 85) {
                    const angle = Math.atan2(p.y - state.outY, p.x - state.outX);
                    p.x = state.outX + Math.cos(angle) * 85;
                    p.y = state.outY + Math.sin(angle) * 85;
                    p.target = null;
                }
            }

            if (state.isOut && state.ballOwnerId === p.id) p.target = null;

            if (p.target) {
                const dx = p.target.x - p.x, dy = p.target.y - p.y, d = Math.hypot(dx, dy);
                if (d > 5) {
                    p.x += (dx/d) * CONFIG.PLAYER_SPEED;
                    p.y += (dy/d) * CONFIG.PLAYER_SPEED;
                } else {
                    p.target = null;
                }
            }
            p.x = Math.max(30, Math.min(WORLD_W-30, p.x));
            p.y = Math.max(30, Math.min(WORLD_H-30, p.y));
        });

        for (let i = 0; i < state.players.length; i++) {
            for (let j = i + 1; j < state.players.length; j++) {
                const p1 = state.players[i], p2 = state.players[j];
                const dx = p2.x - p1.x, dy = p2.y - p1.y, dist = Math.hypot(dx, dy);
                const minDist = CONFIG.PLAYER_RAD * 2;
                if (dist < minDist) {
                    const overlap = minDist - dist, nx = dx / dist, ny = dy / dist;
                    p1.x -= nx * (overlap / 2); p1.y -= ny * (overlap / 2);
                    p2.x += nx * (overlap / 2); p2.y += ny * (overlap / 2);
                }
            }
        }

        if (state.isOut || state.isGoal) {
            let ballOwner = state.players.find(p => p.id === state.ballOwnerId);
            
            if (!ballOwner && state.isOut) {
                state.pickupTimeRemaining -= 1/60;
                if (state.pickupTimeRemaining <= 0) {
                    state.turnToKick = state.turnToKick === 'p1' ? 'p2' : 'p1';
                    state.pickupTimeRemaining = 5;
                    state.kickTimeRemaining = 5;
                    const teamName = state.turnToKick === 'p1' ? state.teamInfo.p1.name : state.teamInfo.p2.name;
                    state.statusMsg = `FALTA DE TIEMPO - SACA ${teamName}`;
                } else {
                    state.players.forEach(p => {
                        if (p.team === state.turnToKick && Math.hypot(p.x - state.ball.x, p.y - state.ball.y) < 45) {
                            state.ballOwnerId = p.id;
                            state.kickTimeRemaining = 5; 
                            p.x = state.outX;
                            p.y = state.outY;
                            p.target = null;
                        }
                    });
                }
            }
            
            if (ballOwner = state.players.find(p => p.id === state.ballOwnerId)) {
                if (state.isOut) {
                    state.ball.x = state.outX;
                    state.ball.y = state.outY;
                    state.kickTimeRemaining -= 1/60; 
                    
                    if (state.kickTimeRemaining <= 0) {
                        state.turnToKick = state.turnToKick === 'p1' ? 'p2' : 'p1';
                        state.ballOwnerId = null;
                        state.pickupTimeRemaining = 5;
                        state.kickTimeRemaining = 5;
                        const teamName = state.turnToKick === 'p1' ? state.teamInfo.p1.name : state.teamInfo.p2.name;
                        state.statusMsg = `FALTA DE TIEMPO - SACA ${teamName}`;
                        ballOwner.immune = 120;
                    }
                } else {
                    state.ball.x = ballOwner.x;
                    state.ball.y = ballOwner.y;
                }
            }
        } else {
            let ballOwner = state.players.find(p => p.id === state.ballOwnerId);
            if (ballOwner) {
                state.ball.x = ballOwner.x;
                state.ball.y = ballOwner.y;
                state.ball.vx = 0;
                state.ball.vy = 0;
                
                state.players.forEach(p => {
                    if (p.team !== ballOwner.team && p.immune === 0 && ballOwner.immune === 0) {
                        if (Math.hypot(p.x - state.ball.x, p.y - state.ball.y) < CONFIG.STEAL_DIST && Math.random() < CONFIG.STEAL_PROB) {
                            state.ballOwnerId = p.id;
                            state.ball.lastTeam = p.team;
                            p.immune = CONFIG.IMMUNE_TIME;
                            ballOwner.immune = CONFIG.IMMUNE_TIME;
                        }
                    }
                });
            } else {
                state.ball.x += state.ball.vx;
                state.ball.y += state.ball.vy;
                state.ball.vx *= 0.99;
                state.ball.vy *= 0.99;

                const inGoalWidth = state.ball.x > CONFIG.POST_L && state.ball.x < CONFIG.POST_R;

                if (state.ball.y < 15) {
                    if (inGoalWidth) goal(state, 'p1'); else handleEndLine(state, state.ball.x, 35, 'p2');
                } else if (state.ball.y > WORLD_H - 15) {
                    if (inGoalWidth) goal(state, 'p2'); else handleEndLine(state, state.ball.x, WORLD_H - 35, 'p1');
                } else if (state.ball.x < 15) {
                    triggerOut(state, 35, state.ball.y, "BANDA");
                } else if (state.ball.x > WORLD_W - 15) {
                    triggerOut(state, WORLD_W - 35, state.ball.y, "BANDA");
                }

                state.players.forEach(p => {
                    const dist = Math.hypot(state.ball.x - p.x, state.ball.y - p.y);
                    if (dist < CONFIG.PLAYER_RAD + CONFIG.BALL_RAD && p.immune === 0) {
                        state.ballOwnerId = p.id;
                        state.ball.lastTeam = p.team;
                    }
                });
            }
        }
        io.to(roomCode).emit('stateUpdate', state);
    }
}, 1000 / 60);

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Futsal corriendo en el puerto ${PORT}`);
});
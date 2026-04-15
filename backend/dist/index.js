"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const crypto_1 = __importDefault(require("crypto"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const pino_1 = __importDefault(require("pino"));
const client_1 = require("@prisma/client");
const boardGenerator_1 = require("./boardGenerator");
const botCoordinator_1 = require("./botCoordinator");
const gameEngine_1 = require("./gameEngine");
const auth_1 = require("./auth");
dotenv_1.default.config();
const prisma = new client_1.PrismaClient();
const isDev = process.env.NODE_ENV !== 'production';
const logger = isDev
    ? (0, pino_1.default)({ transport: { target: 'pino-pretty', options: { colorize: true } } })
    : (0, pino_1.default)();
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const DISCONNECT_GRACE_MS = 2 * 60 * 1000;
const MATCH_HISTORY_PAGE_SIZE_DEFAULT = 10;
const MATCH_HISTORY_PAGE_SIZE_MAX = 25;
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, { cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] } });
app.use((0, cors_1.default)({ origin: FRONTEND_URL }));
app.use(express_1.default.json());
// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK (for Render)
// ═══════════════════════════════════════════════════════════
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// ═══════════════════════════════════════════════════════════
//  AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
    const result = await (0, auth_1.register)(prisma, req.body.username, req.body.password);
    res.json(result);
});
app.post('/api/login', async (req, res) => {
    const result = await (0, auth_1.login)(prisma, req.body.username, req.body.password);
    res.json(result);
});
app.get('/api/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).json({ error: 'No token' });
        return;
    }
    const decoded = (0, auth_1.verifyToken)(authHeader.replace('Bearer ', ''));
    if (!decoded) {
        res.status(401).json({ error: 'Invalid token' });
        return;
    }
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    res.json({ id: user.id, username: user.username, wins: user.wins, losses: user.losses, elo: user.elo });
});
app.get('/api/matches', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).json({ error: 'No token' });
        return;
    }
    const decoded = (0, auth_1.verifyToken)(authHeader.replace('Bearer ', ''));
    if (!decoded) {
        res.status(401).json({ error: 'Invalid token' });
        return;
    }
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(MATCH_HISTORY_PAGE_SIZE_MAX, Math.max(1, Number(req.query.pageSize || MATCH_HISTORY_PAGE_SIZE_DEFAULT)));
    const entries = await prisma.player.findMany({
        where: {
            userId: decoded.userId,
            game: { status: 'FINISHED' },
        },
        include: {
            game: true,
        },
        orderBy: { game: { updatedAt: 'desc' } },
        take: pageSize + 1,
        skip: (page - 1) * pageSize,
    });
    const hasMore = entries.length > pageSize;
    const pageEntries = hasMore ? entries.slice(0, pageSize) : entries;
    const matches = pageEntries.map((entry) => {
        const envelope = parsePersistedEnvelope(entry.game.gameState || {});
        const state = envelope.engine;
        const players = state.players || {};
        const playerOrder = state.playerOrder || [];
        const winnerId = state.winner || null;
        const standings = playerOrder
            .filter((playerId) => players[playerId] && !players[playerId].isBot)
            .map((playerId) => ({
            id: playerId,
            username: players[playerId].username,
            color: players[playerId].color,
            vp: calculateVictoryPoints({ ...state, players }, playerId),
        }))
            .sort((a, b) => b.vp - a.vp);
        return {
            gameId: entry.gameId,
            roomCode: entry.game.roomCode,
            finishedAt: state.finishedAt || entry.game.updatedAt,
            winner: winnerId ? {
                id: winnerId,
                username: players[winnerId]?.username || 'Unknown',
                color: players[winnerId]?.color || null,
            } : null,
            didWin: winnerId === decoded.userId,
            finalVp: standings.find((player) => player.id === decoded.userId)?.vp ?? entry.score,
            standings,
        };
    });
    res.json({ items: matches, page, pageSize, hasMore });
});
// ═══════════════════════════════════════════════════════════
//  IN-MEMORY GAME INSTANCES
// ═══════════════════════════════════════════════════════════
const activeEngines = new Map();
const gameBoards = new Map();
const playerSessions = new Map();
const gamePresence = new Map();
const gameSessionTokens = new Map();
const gameRuntimeMetadata = new Map();
const botCoordinator = new botCoordinator_1.BotCoordinator();
function calculateVictoryPoints(engine, playerId) {
    const player = engine.players[playerId];
    if (!player)
        return 0;
    let vp = player.score;
    if (engine.longestRoadHolder === playerId)
        vp += 2;
    if (engine.largestArmyHolder === playerId)
        vp += 2;
    vp += player.devCards.filter((c) => c.type === 'victoryPoint').length;
    return vp;
}
function makeSessionToken() {
    return crypto_1.default.randomBytes(24).toString('hex');
}
function ensureSessionGrant(gameId, userId) {
    let grants = gameSessionTokens.get(gameId);
    if (!grants) {
        grants = new Map();
        gameSessionTokens.set(gameId, grants);
    }
    let grant = grants.get(userId);
    if (!grant) {
        const now = new Date().toISOString();
        grant = {
            token: makeSessionToken(),
            issuedAt: now,
            lastSeenAt: now,
            disconnectedAt: null,
            disconnectGraceUntil: null,
        };
        grants.set(userId, grant);
    }
    return grant;
}
function serializeSessionGrants(gameId) {
    const grants = gameSessionTokens.get(gameId);
    if (!grants)
        return {};
    return Object.fromEntries(Array.from(grants.entries()));
}
function restoreSessionGrants(gameId, runtime) {
    const grants = new Map();
    if (runtime?.sessionTokens) {
        for (const [userId, grant] of Object.entries(runtime.sessionTokens)) {
            grants.set(userId, grant);
        }
    }
    gameSessionTokens.set(gameId, grants);
    gameRuntimeMetadata.set(gameId, {
        createdFromGameId: runtime?.createdFromGameId ?? null,
        rematchOfGameId: runtime?.rematchOfGameId ?? null,
    });
}
function buildPersistedEnvelope(gameId, engine, existing) {
    const metadata = gameRuntimeMetadata.get(gameId) || { createdFromGameId: null, rematchOfGameId: null };
    const nextMetadata = {
        createdFromGameId: existing?.createdFromGameId ?? metadata.createdFromGameId,
        rematchOfGameId: existing?.rematchOfGameId ?? metadata.rematchOfGameId,
    };
    gameRuntimeMetadata.set(gameId, nextMetadata);
    return {
        version: 2,
        engine: engine.getState(),
        runtime: {
            sessionTokens: serializeSessionGrants(gameId),
            createdFromGameId: nextMetadata.createdFromGameId,
            rematchOfGameId: nextMetadata.rematchOfGameId,
        },
    };
}
function parsePersistedEnvelope(gameState) {
    if (gameState?.version === 2 && gameState?.engine) {
        return gameState;
    }
    return {
        version: 2,
        engine: gameState,
        runtime: {
            sessionTokens: {},
            createdFromGameId: null,
            rematchOfGameId: null,
        },
    };
}
async function syncPersistentPlayers(gameId, engine) {
    await Promise.all(engine.playerOrder.map(async (playerId) => {
        const player = engine.players[playerId];
        if (!player)
            return;
        await prisma.player.upsert({
            where: { gameId_color: { gameId, color: player.color } },
            update: {
                userId: player.isBot ? null : player.id,
                isBot: player.isBot,
                score: calculateVictoryPoints(engine, playerId),
            },
            create: {
                gameId,
                userId: player.isBot ? null : player.id,
                color: player.color,
                score: calculateVictoryPoints(engine, playerId),
                isBot: player.isBot,
            }
        });
    }));
}
function ensurePresenceSlots(gameId, engine) {
    let presence = gamePresence.get(gameId);
    if (!presence) {
        presence = new Map();
        gamePresence.set(gameId, presence);
    }
    for (const playerId of engine.playerOrder) {
        if (engine.players[playerId]?.isBot)
            continue;
        if (!presence.has(playerId)) {
            presence.set(playerId, { socketIds: new Set(), connected: false, lastSeenAt: null });
        }
    }
    return presence;
}
function serializePresence(gameId) {
    const presence = gamePresence.get(gameId);
    if (!presence)
        return {};
    return Object.fromEntries(Array.from(presence.entries()).map(([playerId, entry]) => [
        playerId,
        { connected: entry.connected, lastSeenAt: entry.lastSeenAt }
    ]));
}
function emitPresence(gameId) {
    io.to(gameId).emit('presence_update', serializePresence(gameId));
}
async function attachPlayerSocket(socket, gameId, userId, engine) {
    detachPlayerSocket(socket.id);
    socket.join(gameId);
    if (!userId)
        return null;
    if (engine)
        ensurePresenceSlots(gameId, engine);
    const presence = gamePresence.get(gameId);
    const grant = ensureSessionGrant(gameId, userId);
    if (presence) {
        const current = presence.get(userId) || { socketIds: new Set(), connected: false, lastSeenAt: null };
        current.socketIds.add(socket.id);
        current.connected = true;
        current.lastSeenAt = new Date().toISOString();
        presence.set(userId, current);
    }
    grant.lastSeenAt = new Date().toISOString();
    grant.disconnectedAt = null;
    grant.disconnectGraceUntil = null;
    playerSessions.set(socket.id, { gameId, userId });
    emitPresence(gameId);
    return grant.token;
}
function detachPlayerSocket(socketId) {
    const session = playerSessions.get(socketId);
    if (!session)
        return;
    playerSessions.delete(socketId);
    const presence = gamePresence.get(session.gameId);
    const playerPresence = presence?.get(session.userId);
    if (!presence || !playerPresence)
        return;
    playerPresence.socketIds.delete(socketId);
    playerPresence.lastSeenAt = new Date().toISOString();
    playerPresence.connected = playerPresence.socketIds.size > 0;
    const grant = gameSessionTokens.get(session.gameId)?.get(session.userId);
    if (grant && playerPresence.socketIds.size === 0) {
        const disconnectedAt = new Date();
        grant.lastSeenAt = disconnectedAt.toISOString();
        grant.disconnectedAt = disconnectedAt.toISOString();
        grant.disconnectGraceUntil = new Date(disconnectedAt.getTime() + DISCONNECT_GRACE_MS).toISOString();
    }
    emitPresence(session.gameId);
}
async function getOrInitGame(gameId) {
    if (activeEngines.has(gameId)) {
        return { engine: activeEngines.get(gameId), board: gameBoards.get(gameId) };
    }
    const gameRecord = await prisma.game.findUnique({ where: { id: gameId } });
    if (!gameRecord)
        return null;
    const engine = new gameEngine_1.GameEngine();
    const boardData = gameRecord.boardState ? gameRecord.boardState : (0, boardGenerator_1.generateBoard)();
    const persisted = parsePersistedEnvelope(gameRecord.gameState || {});
    if (boardData.hexes) {
        engine.setBoard(boardData.hexes, boardData.ports);
    }
    else {
        // Fallback for old records that only had hexes
        engine.setBoard(boardData, []);
    }
    if (persisted.engine)
        engine.setState(persisted.engine);
    restoreSessionGrants(gameId, persisted.runtime);
    activeEngines.set(gameId, engine);
    gameBoards.set(gameId, boardData);
    return { engine, board: boardData };
}
async function saveCheckpoint(gameId, runtimeOverrides) {
    const engine = activeEngines.get(gameId);
    if (!engine)
        return;
    await syncPersistentPlayers(gameId, engine);
    await prisma.game.update({
        where: { id: gameId },
        data: { gameState: buildPersistedEnvelope(gameId, engine, runtimeOverrides) }
    });
}
async function handleGameOver(gameId, engine) {
    const winnerId = engine.winner;
    if (!winnerId || winnerId.startsWith('bot_')) {
        // Winner is a bot — just mark finished
        await prisma.game.update({ where: { id: gameId }, data: { status: 'FINISHED', gameState: buildPersistedEnvelope(gameId, engine) } });
        activeEngines.delete(gameId);
        gameBoards.delete(gameId);
        gamePresence.delete(gameId);
        gameSessionTokens.delete(gameId);
        gameRuntimeMetadata.delete(gameId);
        return;
    }
    // Determine real players (non-bot)
    const realPlayerIds = engine.playerOrder.filter(pid => !engine.players[pid]?.isBot);
    // Calculate final VPs for all players
    const getVP = (pid) => {
        const p = engine.players[pid];
        let vp = p.score;
        if (engine.longestRoadHolder === pid)
            vp += 2;
        if (engine.largestArmyHolder === pid)
            vp += 2;
        vp += p.devCards.filter((c) => c.type === 'victoryPoint').length;
        return vp;
    };
    // Sort real players by VP descending
    const ranked = [...realPlayerIds].sort((a, b) => getVP(b) - getVP(a));
    try {
        await prisma.$transaction(ranked.map((pid, index) => prisma.user.update({
            where: { id: pid },
            data: index === 0
                ? { wins: { increment: 1 }, elo: { increment: 25 } }
                : { losses: { increment: 1 }, elo: { decrement: 10 } }
        })));
        await syncPersistentPlayers(gameId, engine);
    }
    catch (e) {
        logger.error({ err: e, gameId, ranked, winnerId }, 'Failed to persist final game stats');
    }
    await prisma.game.update({ where: { id: gameId }, data: { status: 'FINISHED', gameState: buildPersistedEnvelope(gameId, engine) } });
    activeEngines.delete(gameId);
    gameBoards.delete(gameId);
    gamePresence.delete(gameId);
    gameSessionTokens.delete(gameId);
    gameRuntimeMetadata.delete(gameId);
    logger.info(`Game ${gameId} finished. Winner: ${winnerId}`);
}
// Helper: execute an engine action, handle errors, broadcast state
async function handleAction(socket, data, action) {
    const gameId = data.gameId;
    if (!gameId) {
        socket.emit('action_error', 'Missing gameId');
        return;
    }
    const result = await getOrInitGame(gameId);
    if (!result) {
        socket.emit('action_error', 'Game not found');
        return;
    }
    const error = action(result.engine);
    if (error) {
        socket.emit('action_error', error);
        return;
    }
    const engineState = result.engine.getState();
    await saveCheckpoint(gameId);
    const gameRecord = await prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
    io.to(gameId).emit('game_state', {
        ...engineState,
        status: gameRecord?.status || 'LOBBY'
    });
    if (engineState.lastEvent) {
        io.to(gameId).emit('game_event', engineState.lastEvent);
    }
    emitPresence(gameId);
    // Handle game over
    if (engineState.phase === 'GAME_OVER' && engineState.winner) {
        await handleGameOver(gameId, result.engine);
        return;
    }
    // Auto-trigger next bot if applicable
    checkForBotTurn(gameId);
}
function checkForBotTurn(gameId) {
    const engine = activeEngines.get(gameId);
    if (!engine)
        return;
    const state = engine.getState();
    if (state.phase === 'GAME_OVER')
        return;
    let botId = null;
    // ROBBER_DISCARD: ANY bot that must discard (regardless of whose turn)
    if (state.phase === 'MAIN_GAME' && state.turnPhase === 'GOLD_CHOICE') {
        botId = Object.entries(state.pendingGoldChoices || {}).find(([pid, amount]) => amount > 0 && engine.players[pid]?.isBot)?.[0] || null;
    }
    else if (state.phase === 'MAIN_GAME' && state.turnPhase === 'ROBBER_DISCARD') {
        botId = state.playersWhoMustDiscard.find(pid => engine.players[pid]?.isBot) || null;
    }
    else if (state.phase === 'SETUP_R1' || state.phase === 'SETUP_R2') {
        const cur = state.setupInfo?.currentPlayer;
        if (cur && engine.players[cur]?.isBot)
            botId = cur;
    }
    else if (state.phase === 'MAIN_GAME') {
        const cur = state.playerOrder[state.currentTurnIndex];
        if (engine.players[cur]?.isBot)
            botId = cur;
    }
    if (botId) {
        logger.info(`Scheduling bot turn for ${botId} in ${gameId}`);
        io.to(gameId).emit('bot_thinking', { userId: botId });
        const delay = 2000 + Math.random() * 1500;
        setTimeout(async () => {
            const eng = activeEngines.get(gameId);
            if (!eng)
                return;
            if (eng.phase === 'SETUP_R1' || eng.phase === 'SETUP_R2') {
                botCoordinator.performSetup(eng, botId);
            }
            else {
                botCoordinator.performTurn(eng, botId);
            }
            const newState = eng.getState();
            await saveCheckpoint(gameId);
            const gameRecord = await prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
            io.to(gameId).emit('game_state', { ...newState, status: gameRecord?.status || 'IN_PROGRESS' });
            if (newState.lastEvent) {
                io.to(gameId).emit('game_event', newState.lastEvent);
            }
            emitPresence(gameId);
            if (newState.phase === 'GAME_OVER' && newState.winner) {
                await handleGameOver(gameId, eng);
                return;
            }
            checkForBotTurn(gameId);
        }, delay);
    }
}
// ═══════════════════════════════════════════════════════════
//  SOCKET.IO EVENT HANDLERS
// ═══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    logger.info(`Connection opened: ${socket.id}`);
    // ── LOBBY ──
    socket.on('fetch_lobbies', async () => {
        const lobbies = await prisma.game.findMany({
            where: { status: 'LOBBY' },
            take: 20,
            orderBy: { createdAt: 'desc' }
        });
        socket.emit('lobbies_update', lobbies);
    });
    socket.on('create_lobby', async (data) => {
        logger.info(`Creating lobby for ${data.userId}`);
        const expansion = data.expansion === 'seafarers' ? 'seafarers' : 'base';
        const boardData = (0, boardGenerator_1.generateBoardForExpansion)(expansion);
        const engine = new gameEngine_1.GameEngine();
        engine.setBoard(boardData.hexes, boardData.ports);
        engine.addPlayer(data.userId, data.username);
        // Generate 6-char uppercase room code
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const game = await prisma.game.create({
            data: {
                roomCode,
                status: 'LOBBY',
                boardState: boardData,
                gameState: engine.getState()
            }
        });
        activeEngines.set(game.id, engine);
        gameBoards.set(game.id, boardData);
        ensurePresenceSlots(game.id, engine);
        await syncPersistentPlayers(game.id, engine);
        const lobbies = await prisma.game.findMany({
            where: { status: 'LOBBY' },
            take: 20,
            orderBy: { createdAt: 'desc' }
        });
        io.emit('lobbies_update', lobbies);
        // Auto-join the creator
        const sessionToken = await attachPlayerSocket(socket, game.id, data.userId, engine);
        await saveCheckpoint(game.id);
        socket.emit('board_state', boardData);
        socket.emit('game_joined', { gameId: game.id, roomCode, status: 'LOBBY', sessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
        io.to(game.id).emit('game_state', { ...engine.getState(), status: 'LOBBY' });
    });
    socket.on('join_by_code', async (data) => {
        const { userId, roomCode } = data;
        logger.info(`Player ${userId} joining by code: ${roomCode}`);
        const game = await prisma.game.findFirst({
            where: { roomCode: roomCode.toUpperCase(), status: 'LOBBY' }
        });
        if (!game) {
            socket.emit('action_error', 'Room not found or already started');
            return;
        }
        const result = await getOrInitGame(game.id);
        if (!result) {
            socket.emit('action_error', 'Game not found');
            return;
        }
        ensurePresenceSlots(game.id, result.engine);
        const err = result.engine.addPlayer(userId, data.username);
        if (err) {
            // Already in game is OK, just re-send state
            const sessionToken = await attachPlayerSocket(socket, game.id, userId, result.engine);
            await saveCheckpoint(game.id);
            socket.emit('board_state', result.board);
            socket.emit('game_joined', { gameId: game.id, roomCode: game.roomCode, status: game.status, sessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
            io.to(game.id).emit('game_state', { ...result.engine.getState(), status: game.status });
            return;
        }
        const sessionToken = await attachPlayerSocket(socket, game.id, userId, result.engine);
        await saveCheckpoint(game.id);
        socket.emit('board_state', result.board);
        socket.emit('game_joined', { gameId: game.id, roomCode: game.roomCode, status: game.status, sessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
        io.to(game.id).emit('game_state', { ...result.engine.getState(), status: game.status });
    });
    socket.on('rejoin_game', async (data) => {
        const { userId, gameId, sessionToken } = data;
        logger.info(`Rejoin attempt: User ${userId} for Game ${gameId}`);
        const gameRecord = await prisma.game.findUnique({ where: { id: gameId } });
        if (!gameRecord || gameRecord.status === 'FINISHED') {
            socket.emit('action_error', 'Game session not found');
            return;
        }
        const result = await getOrInitGame(gameId);
        if (!result) {
            socket.emit('action_error', 'Game session not found');
            return;
        }
        if (!result.engine.players[userId]) {
            socket.emit('action_error', 'You are not part of this game session');
            return;
        }
        const existingGrant = gameSessionTokens.get(gameId)?.get(userId);
        if (existingGrant && existingGrant.token !== sessionToken) {
            socket.emit('action_error', 'Invalid session token for this game');
            return;
        }
        const engineState = result.engine.getState();
        const issuedSessionToken = await attachPlayerSocket(socket, gameId, userId, result.engine);
        await saveCheckpoint(gameId);
        socket.emit('board_state', result.board);
        socket.emit('game_joined', { gameId, roomCode: gameRecord.roomCode, status: gameRecord.status, restored: true, sessionToken: issuedSessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
        socket.emit('game_state', { ...engineState, status: gameRecord.status });
        logger.info(`Success: User ${userId} rejoined Game ${gameId} (status: ${gameRecord.status})`);
    });
    socket.on('join_game', async (data) => {
        logger.info(`Player ${data.userId} joining ${data.gameId}`);
        const gameRecord = await prisma.game.findUnique({ where: { id: data.gameId }, select: { roomCode: true } });
        const result = await getOrInitGame(data.gameId);
        if (!result) {
            socket.emit('action_error', 'Game not found');
            return;
        }
        ensurePresenceSlots(data.gameId, result.engine);
        const err = result.engine.addPlayer(data.userId, data.username);
        if (err) {
            // Already in game is OK, just re-send state
            const sessionToken = await attachPlayerSocket(socket, data.gameId, data.userId, result.engine);
            await saveCheckpoint(data.gameId);
            socket.emit('board_state', result.board);
            socket.emit('game_joined', { gameId: data.gameId, roomCode: gameRecord?.roomCode || '', status: 'LOBBY', sessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
            io.to(data.gameId).emit('game_state', { ...result.engine.getState(), status: 'LOBBY' });
            return;
        }
        const sessionToken = await attachPlayerSocket(socket, data.gameId, data.userId, result.engine);
        await saveCheckpoint(data.gameId);
        socket.emit('board_state', result.board);
        socket.emit('game_joined', { gameId: data.gameId, roomCode: gameRecord?.roomCode || '', status: 'LOBBY', sessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
        io.to(data.gameId).emit('game_state', { ...result.engine.getState(), status: 'LOBBY' });
    });
    socket.on('add_bot', async (data) => {
        const result = await getOrInitGame(data.gameId);
        if (!result)
            return;
        // Only host can add bots
        if (result.engine.playerOrder[0] !== data.userId)
            return;
        const botId = `bot_${Math.random().toString(36).substring(2, 7)}`;
        const err = result.engine.addPlayer(botId, '', true);
        if (err) {
            socket.emit('action_error', err);
            return;
        }
        await saveCheckpoint(data.gameId);
        io.to(data.gameId).emit('game_state', result.engine.getState());
    });
    socket.on('create_rematch', async (data) => {
        const previousGame = await prisma.game.findUnique({ where: { id: data.gameId } });
        if (!previousGame || previousGame.status !== 'FINISHED') {
            socket.emit('action_error', 'Only finished games can start a rematch');
            return;
        }
        const persisted = parsePersistedEnvelope(previousGame.gameState || {});
        const previousEngine = new gameEngine_1.GameEngine();
        const previousBoard = previousGame.boardState ? previousGame.boardState : (0, boardGenerator_1.generateBoard)();
        if (previousBoard.hexes)
            previousEngine.setBoard(previousBoard.hexes, previousBoard.ports);
        else
            previousEngine.setBoard(previousBoard, []);
        previousEngine.setState(persisted.engine);
        if (!previousEngine.players[data.userId] || previousEngine.players[data.userId].isBot) {
            socket.emit('action_error', 'Only human participants can request a rematch');
            return;
        }
        const expansion = previousEngine.expansion === 'seafarers' ? 'seafarers' : 'base';
        const boardData = (0, boardGenerator_1.generateBoardForExpansion)(expansion);
        const engine = new gameEngine_1.GameEngine();
        engine.setBoard(boardData.hexes, boardData.ports);
        engine.addPlayer(data.userId, previousEngine.players[data.userId].username);
        const botCount = previousEngine.playerOrder.filter((playerId) => previousEngine.players[playerId]?.isBot).length;
        for (let index = 0; index < botCount; index++) {
            const botId = `bot_${Math.random().toString(36).substring(2, 7)}`;
            engine.addPlayer(botId, '', true);
        }
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const game = await prisma.game.create({
            data: {
                roomCode,
                status: 'LOBBY',
                boardState: boardData,
                gameState: engine.getState(),
            }
        });
        activeEngines.set(game.id, engine);
        gameBoards.set(game.id, boardData);
        ensurePresenceSlots(game.id, engine);
        await saveCheckpoint(game.id, { createdFromGameId: data.gameId, rematchOfGameId: data.gameId });
        const sessionToken = await attachPlayerSocket(socket, game.id, data.userId, engine);
        await saveCheckpoint(game.id, { createdFromGameId: data.gameId, rematchOfGameId: data.gameId });
        socket.emit('board_state', boardData);
        socket.emit('game_joined', { gameId: game.id, roomCode, status: 'LOBBY', sessionToken, disconnectGraceMs: DISCONNECT_GRACE_MS });
        io.emit('lobbies_update', await prisma.game.findMany({
            where: { status: 'LOBBY' },
            take: 20,
            orderBy: { createdAt: 'desc' }
        }));
        io.to(data.gameId).emit('rematch_ready', { gameId: game.id, roomCode, requestedBy: data.userId });
        io.to(game.id).emit('game_state', { ...engine.getState(), status: 'LOBBY' });
    });
    socket.on('start_game', async (data) => {
        const result = await getOrInitGame(data.gameId);
        if (!result)
            return;
        const order = result.engine.playerOrder;
        if (order[0] !== data.userId) {
            socket.emit('action_error', 'Only the host can start the game');
            return;
        }
        if (order.length < 2) {
            socket.emit('action_error', 'Need at least 2 players');
            return;
        }
        // Mark game as in progress
        await prisma.game.update({ where: { id: data.gameId }, data: { status: 'IN_PROGRESS' } });
        await saveCheckpoint(data.gameId);
        logger.info(`Game ${data.gameId} started by host with ${order.length} players`);
        io.to(data.gameId).emit('game_started');
        io.to(data.gameId).emit('game_state', { ...result.engine.getState(), status: 'IN_PROGRESS' });
        emitPresence(data.gameId);
        // Check if first player is a bot
        checkForBotTurn(data.gameId);
    });
    // ── GAME ACTIONS ──
    socket.on('roll_dice', (data) => {
        handleAction(socket, data, (engine) => engine.rollDice(data.userId));
    });
    socket.on('end_turn', (data) => {
        handleAction(socket, data, (engine) => engine.endTurn(data.userId));
    });
    socket.on('place_settlement', (data) => {
        handleAction(socket, data, (engine) => engine.placeSettlement(data.userId, data.vertexId));
    });
    socket.on('place_road', (data) => {
        handleAction(socket, data, (engine) => engine.placeRoad(data.userId, data.edgeId));
    });
    socket.on('place_ship', (data) => {
        handleAction(socket, data, (engine) => engine.placeShip(data.userId, data.edgeId));
    });
    socket.on('move_ship', (data) => {
        handleAction(socket, data, (engine) => engine.moveShip(data.userId, data.fromEdgeId, data.toEdgeId));
    });
    socket.on('upgrade_city', (data) => {
        handleAction(socket, data, (engine) => engine.upgradeToCity(data.userId, data.vertexId));
    });
    socket.on('bank_trade', (data) => {
        handleAction(socket, data, (engine) => engine.bankTrade(data.userId, data.offer, data.request));
    });
    socket.on('buy_dev_card', (data) => {
        handleAction(socket, data, (engine) => engine.buyDevCard(data.userId));
    });
    socket.on('play_dev_card', (data) => {
        handleAction(socket, data, (engine) => engine.playDevCard(data.userId, data.cardIndex, data.payload));
    });
    // ── ROBBER ──
    socket.on('robber_discard', (data) => {
        handleAction(socket, data, (engine) => engine.robberDiscard(data.userId, data.discarded));
    });
    socket.on('move_robber', (data) => {
        handleAction(socket, data, (engine) => engine.moveRobber(data.userId, data.hexCoord, data.stealFrom));
    });
    socket.on('choose_gold_resource', (data) => {
        handleAction(socket, data, (engine) => engine.chooseGoldResource(data.userId, data.resource));
    });
    // ── P2P TRADE ──
    socket.on('propose_trade', async (data) => {
        const gameId = data.gameId;
        const result = await getOrInitGame(gameId);
        if (!result) {
            socket.emit('action_error', 'Game not found');
            return;
        }
        const error = result.engine.proposeTrade(data.userId, data.offering, data.requesting);
        if (error) {
            socket.emit('action_error', error);
            return;
        }
        // All bots immediately evaluate and respond
        result.engine.evaluateBotsForTrade(data.userId);
        const engineState = result.engine.getState();
        await saveCheckpoint(gameId);
        const gameRecord = await prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
        io.to(gameId).emit('game_state', { ...engineState, status: gameRecord?.status || 'IN_PROGRESS' });
        if (engineState.lastEvent) {
            io.to(gameId).emit('game_event', engineState.lastEvent);
        }
        emitPresence(gameId);
    });
    socket.on('accept_trade', (data) => {
        handleAction(socket, data, (engine) => engine.acceptTrade(data.userId));
    });
    socket.on('reject_trade', (data) => {
        handleAction(socket, data, (engine) => engine.rejectTrade(data.userId));
    });
    socket.on('disconnect', async () => {
        const session = playerSessions.get(socket.id);
        detachPlayerSocket(socket.id);
        if (session) {
            await saveCheckpoint(session.gameId);
        }
        logger.info(`Player disconnected: ${socket.id}`);
    });
});
// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => logger.info(`Catan Backend alive on port ${PORT}`));

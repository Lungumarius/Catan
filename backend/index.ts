import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { generateBoard } from './boardGenerator';
import { GameEngine } from './gameEngine';
import { register, login, verifyToken } from './auth';

dotenv.config();

const prisma = new PrismaClient();
const isDev = process.env.NODE_ENV !== 'production';
const logger = isDev
  ? pino({ transport: { target: 'pino-pretty', options: { colorize: true } } })
  : pino();

const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] } });

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK (for Render)
// ═══════════════════════════════════════════════════════════

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ═══════════════════════════════════════════════════════════
//  AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════

app.post('/api/register', async (req, res) => {
  const result = await register(prisma, req.body.username, req.body.password);
  res.json(result);
});

app.post('/api/login', async (req, res) => {
  const result = await login(prisma, req.body.username, req.body.password);
  res.json(result);
});

app.get('/api/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) { res.status(401).json({ error: 'No token' }); return; }
  const decoded = verifyToken(authHeader.replace('Bearer ', ''));
  if (!decoded) { res.status(401).json({ error: 'Invalid token' }); return; }
  const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({ id: user.id, username: user.username, wins: user.wins, losses: user.losses, elo: user.elo });
});

// ═══════════════════════════════════════════════════════════
//  IN-MEMORY GAME INSTANCES
// ═══════════════════════════════════════════════════════════

const activeEngines = new Map<string, GameEngine>();
const gameBoards = new Map<string, any>();

async function getOrInitGame(gameId: string) {
  if (activeEngines.has(gameId)) {
    return { engine: activeEngines.get(gameId)!, board: gameBoards.get(gameId)! };
  }

  const gameRecord = await prisma.game.findUnique({ where: { id: gameId } });
  if (!gameRecord) return null;

  const engine = new GameEngine();
  const boardData = gameRecord.boardState ? gameRecord.boardState as any : generateBoard();
  
  if (boardData.hexes) {
    engine.setBoard(boardData.hexes, boardData.ports);
  } else {
    // Fallback for old records that only had hexes
    engine.setBoard(boardData, []);
  }

  if (gameRecord.gameState) engine.setState(gameRecord.gameState as any);

  activeEngines.set(gameId, engine);
  gameBoards.set(gameId, boardData);
  return { engine, board: boardData };
}

async function saveCheckpoint(gameId: string) {
  const engine = activeEngines.get(gameId);
  if (!engine) return;
  await prisma.game.update({
    where: { id: gameId },
    data: { gameState: engine.getState() as any }
  });
}

// Helper: execute an engine action, handle errors, broadcast state
async function handleAction(
  socket: any,
  data: any,
  action: (engine: GameEngine) => string | null
) {
  const gameId = data.gameId;
  if (!gameId) { socket.emit('action_error', 'Missing gameId'); return; }

  const result = await getOrInitGame(gameId);
  if (!result) { socket.emit('action_error', 'Game not found'); return; }

  const error = action(result.engine);
  if (error) {
    socket.emit('action_error', error);
    return;
  }

  const newState = result.engine.getState();
  await saveCheckpoint(gameId);
  io.to(gameId).emit('game_state', newState);

  // Auto-trigger next bot if applicable
  checkForBotTurn(gameId);
}

function checkForBotTurn(gameId: string) {
  const result = activeEngines.get(gameId);
  if (!result) return;

  const state = result.getState();
  if (state.phase === 'GAME_OVER') return;

  let botId: string | null = null;
  if (state.phase === 'SETUP_R1' || state.phase === 'SETUP_R2') {
    const cur = state.setupInfo?.currentPlayer;
    if (cur && result.players[cur]?.isBot) botId = cur;
  } else if (state.phase === 'MAIN_GAME') {
    const cur = state.playerOrder[state.currentTurnIndex];
    if (result.players[cur]?.isBot) {
      // In main game, bots also need to handle discard phase if they are in the list
      if (state.turnPhase === 'ROBBER_DISCARD') {
        botId = state.playersWhoMustDiscard.find(pid => result.players[pid]?.isBot) || null;
      } else {
        botId = cur;
      }
    }
  }

  if (botId) {
    logger.info(`Scheduling bot turn for ${botId} in ${gameId}`);
    io.to(gameId).emit('bot_thinking', { userId: botId });

    const delay = 2500 + Math.random() * 2000;
    setTimeout(async () => {
      const engine = activeEngines.get(gameId);
      if (!engine) return;
      
      if (engine.phase === 'SETUP_R1' || engine.phase === 'SETUP_R2') {
        engine.executeBotSetup(botId!);
      } else {
        engine.executeBotTurn(botId!);
      }
      
      const newState = engine.getState();
      await saveCheckpoint(gameId);
      io.to(gameId).emit('game_state', newState);
      
      // Recurse if next is also a bot
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
    const boardData = generateBoard();
    const engine = new GameEngine();
    engine.setBoard(boardData.hexes, boardData.ports);
    engine.addPlayer(data.userId, data.username);

    // Generate 6-char uppercase room code
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    const game = await prisma.game.create({
      data: {
        roomCode,
        status: 'LOBBY',
        boardState: boardData as any,
        gameState: engine.getState() as any
      }
    });

    activeEngines.set(game.id, engine);
    gameBoards.set(game.id, boardData);

    const lobbies = await prisma.game.findMany({
      where: { status: 'LOBBY' },
      take: 20,
      orderBy: { createdAt: 'desc' }
    });
    io.emit('lobbies_update', lobbies);

    // Auto-join the creator
    socket.join(game.id);
    socket.emit('board_state', boardData);
    socket.emit('game_joined', { gameId: game.id, roomCode });
    io.to(game.id).emit('game_state', engine.getState());
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

    socket.join(game.id);
    const result = await getOrInitGame(game.id);
    if (!result) {
      socket.emit('action_error', 'Game not found');
      return;
    }

    const err = result.engine.addPlayer(userId, data.username);
    if (err) {
      // Already in game is OK, just re-send state
      socket.emit('board_state', result.board);
      socket.emit('game_joined', { gameId: game.id, roomCode: game.roomCode });
      io.to(game.id).emit('game_state', result.engine.getState());
      return;
    }

    await saveCheckpoint(game.id);
    socket.emit('board_state', result.board);
    socket.emit('game_joined', { gameId: game.id, roomCode: game.roomCode });
    io.to(game.id).emit('game_state', result.engine.getState());
  });

  socket.on('rejoin_game', async (data) => {
    const { userId, gameId } = data;
    logger.info(`Rejoin attempt: User ${userId} for Game ${gameId}`);

    const result = await getOrInitGame(gameId);
    if (!result) {
      socket.emit('action_error', 'Game session not found');
      return;
    }

    const gameRecord = await prisma.game.findUnique({ where: { id: gameId } });
    if (!gameRecord) return;

    socket.join(gameId);
    socket.emit('board_state', result.board);
    socket.emit('game_joined', { gameId, roomCode: gameRecord.roomCode });
    socket.emit('game_state', result.engine.getState());
    logger.info(`Success: User ${userId} rejoined Game ${gameId}`);
  });

  socket.on('join_game', async (data) => {
    logger.info(`Player ${data.userId} joining ${data.gameId}`);
    socket.join(data.gameId);

    const result = await getOrInitGame(data.gameId);
    if (!result) {
      socket.emit('action_error', 'Game not found');
      return;
    }

    const err = result.engine.addPlayer(data.userId, data.username);
    if (err) {
      // Already in game is OK, just re-send state
      socket.emit('board_state', result.board);
      io.to(data.gameId).emit('game_state', result.engine.getState());
      return;
    }

    await saveCheckpoint(data.gameId);
    socket.emit('board_state', result.board);
    io.to(data.gameId).emit('game_state', result.engine.getState());
  });

  socket.on('add_bot', async (data) => {
    const result = await getOrInitGame(data.gameId);
    if (!result) return;
    
    // Only host can add bots
    if (result.engine.playerOrder[0] !== data.userId) return;
    
    const botId = `bot_${Math.random().toString(36).substring(2, 7)}`;
    const err = result.engine.addPlayer(botId, '', true);
    if (err) {
      socket.emit('action_error', err);
      return;
    }
    
    await saveCheckpoint(data.gameId);
    io.to(data.gameId).emit('game_state', result.engine.getState());
  });

  socket.on('start_game', async (data) => {
    const result = await getOrInitGame(data.gameId);
    if (!result) return;

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
    io.to(data.gameId).emit('game_state', result.engine.getState());
    
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

  // ── P2P TRADE ──

  socket.on('propose_trade', (data) => {
    handleAction(socket, data, (engine) => engine.proposeTrade(data.userId, data.offering, data.requesting));
  });

  socket.on('accept_trade', (data) => {
    handleAction(socket, data, (engine) => engine.acceptTrade(data.userId));
  });

  socket.on('reject_trade', (data) => {
    handleAction(socket, data, (engine) => engine.rejectTrade(data.userId));
  });

  // ── DEV CHEAT ──
  socket.on('cheat_resources', (data) => {
    handleAction(socket, data, (engine) => {
      const p = engine.players[data.userId];
      if (!p) return 'Player not found';
      p.resources.wood += 99;
      p.resources.brick += 99;
      p.resources.sheep += 99;
      p.resources.wheat += 99;
      p.resources.ore += 99;
      engine.addLog(`🛠️ ${engine.playerName(data.userId)} used DEV CHEAT for +99 resources!`);
      return null;
    });
  });

  socket.on('disconnect', () => {
    logger.info(`Player disconnected: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => logger.info(`Catan Backend alive on port ${PORT}`));

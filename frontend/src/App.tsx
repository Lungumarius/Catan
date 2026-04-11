import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { Board, type HexData, type PortData } from './Board';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f97316'];
const COLOR_NAMES = ['Red', 'Blue', 'Green', 'Orange'];

type ResourceType = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
type Resources = Record<ResourceType, number>;
interface DevCard { type: string; boughtThisTurn: boolean; }
interface PlayerState {
  id: string; color: string; score: number; resources: Resources;
  devCards: DevCard[]; knightsPlayed: number; hasPlayedDevCardThisTurn: boolean;
  isBot: boolean;
}
interface Building { owner: string; type: 'settlement' | 'city'; }
interface TradeOffer { fromPlayer: string; offering: Partial<Resources>; requesting: Partial<Resources>; }

export interface GameState {
  phase: string; turnPhase: string; setupTurnIndex: number;
  players: Record<string, PlayerState>; playerOrder: string[];
  currentTurnIndex: number; diceResult: number | null; dice1: number; dice2: number;
  buildings: Record<string, Building>; roads: Record<string, string>;
  robberHex: string; playersWhoMustDiscard: string[];
  devCardDeckSize: number;
  longestRoadHolder: string | null; longestRoadLength: number;
  largestArmyHolder: string | null; largestArmySize: number;
  activeTradeOffer: TradeOffer | null;
  log: string[]; winner: string | null;
  setupInfo: { currentPlayer: string; expectedAction: string } | null;
  roadBuildingRemaining: number;
}

const RES: Record<string, string> = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
const ZERO_RES = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });

// ═══════════════════════════════════════════════════════════
//  DICE DOT PATTERNS
// ═══════════════════════════════════════════════════════════

const DOT_POSITIONS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[25, 25], [75, 75]],
  3: [[25, 25], [50, 50], [75, 75]],
  4: [[25, 25], [75, 25], [25, 75], [75, 75]],
  5: [[25, 25], [75, 25], [50, 50], [25, 75], [75, 75]],
  6: [[25, 20], [75, 20], [25, 50], [75, 50], [25, 80], [75, 80]],
};

function DiceFace({ value, size = 52 }: { value: number; size?: number }) {
  const dots = DOT_POSITIONS[value] || [];
  return (
    <div className="dice-face" style={{ width: size, height: size }}>
      {dots.map(([ x, y], i) => (
        <div key={i} className="dice-dot" style={{ left: `${x}%`, top: `${y}%` }} />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
//  DICE ROLL ANIMATION COMPONENT
// ═══════════════════════════════════════════════════════════

function DiceAnimation({ d1, d2, total, onComplete }: { d1: number; d2: number; total: number; onComplete: () => void }) {
  const [phase, setPhase] = useState<'rolling' | 'result'>('rolling');
  const [rng1, setRng1] = useState(1);
  const [rng2, setRng2] = useState(1);

  useEffect(() => {
    let frame = 0;
    const interval = setInterval(() => {
      setRng1(Math.floor(Math.random() * 6) + 1);
      setRng2(Math.floor(Math.random() * 6) + 1);
      frame++;
      if (frame >= 12) {
        clearInterval(interval);
        setPhase('result');
        setTimeout(onComplete, 1800);
      }
    }, 80);
    return () => clearInterval(interval);
  }, [d1, d2, onComplete]);

  const show1 = phase === 'result' ? d1 : rng1;
  const show2 = phase === 'result' ? d2 : rng2;

  return (
    <motion.div className="dice-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="dice-animation-container">
        <motion.div
          animate={phase === 'rolling' ? { rotate: [0, 360], scale: [1, 1.1, 1] } : { rotate: 0, scale: 1 }}
          transition={phase === 'rolling' ? { duration: 0.3, repeat: Infinity } : { type: 'spring', bounce: 0.5 }}>
          <DiceFace value={show1} size={80} />
        </motion.div>
        <motion.div
          animate={phase === 'rolling' ? { rotate: [360, 0], scale: [1, 1.1, 1] } : { rotate: 0, scale: 1 }}
          transition={phase === 'rolling' ? { duration: 0.3, repeat: Infinity } : { type: 'spring', bounce: 0.5 }}>
          <DiceFace value={show2} size={80} />
        </motion.div>
      </div>
      {phase === 'result' && (
        <motion.div className="dice-total-display" initial={{ scale: 0 }} animate={{ scale: 1 }}
          transition={{ type: 'spring', bounce: 0.6 }}>
          {total}
        </motion.div>
      )}
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════════════════════

type View = 'AUTH' | 'MATCHMAKING' | 'LOBBY' | 'GAME';

interface AuthUser { id: string; username: string; wins: number; losses: number; elo: number; }

function App() {
  // Auth state
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Socket & game state
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [boardState, setBoardState] = useState<{ hexes: HexData[], ports: PortData[] }>({ hexes: [], ports: [] });
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [view, setView] = useState<View>('AUTH');
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [currentGameId, setCurrentGameId] = useState<string | null>(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [botThinking, setBotThinking] = useState<string | null>(null);
  void gameStarted; // Used by game_started socket event

  // UI state
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [buildMode, setBuildMode] = useState<'settlement' | 'road' | 'city' | null>(null);
  const [showBankTrade, setShowBankTrade] = useState(false);
  const [showP2PTrade, setShowP2PTrade] = useState(false);
  const [showDevCards, setShowDevCards] = useState(false);
  const [bankOffer, setBankOffer] = useState<ResourceType>('wood');
  const [bankRequest, setBankRequest] = useState<ResourceType>('ore');
  const [p2pOffer, setP2pOffer] = useState<Resources>(ZERO_RES());
  const [p2pRequest, setP2pRequest] = useState<Resources>(ZERO_RES());
  const [discardAmounts, setDiscardAmounts] = useState<Resources>(ZERO_RES());

  // Dice animation
  const [showDiceAnim, setShowDiceAnim] = useState(false);
  const [animDice, setAnimDice] = useState({ d1: 1, d2: 1, total: 2 });

  const userId = authUser?.id ?? '';

  const emit = useCallback((event: string, payload: any = {}) => {
    socket?.emit(event, { ...payload, gameId: currentGameId, userId });
  }, [socket, currentGameId, userId]);

  // ── Check stored token on mount ──
  useEffect(() => {
    const token = localStorage.getItem('catan_token');
    if (token) {
      fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
          if (data.id) { setAuthUser(data); setView('MATCHMAKING'); }
        })
        .catch(() => {});
    }
  }, []);

  // ── Auth handler ──
  const handleAuth = async () => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem('catan_token', data.token);
        setAuthUser(data.user);
        setView('MATCHMAKING');
      } else {
        setAuthError(data.error || 'Something went wrong');
      }
    } catch {
      setAuthError('Cannot reach server');
    }
    setAuthLoading(false);
  };

  // ── Socket setup (after auth) ──
  useEffect(() => {
    if (!authUser) return;
    const s = io(API);
    setSocket(s);
    s.on('connect', () => { setIsConnected(true); s.emit('fetch_lobbies'); });
    s.on('lobbies_update', (l: any[]) => setLobbies(l));
    s.on('board_state', (data: any) => {
      if (data.hexes) {
        setBoardState(data);
      } else {
        // Fallback for old data
        setBoardState({ hexes: data, ports: [] });
      }
    });
    s.on('game_state', (st: GameState) => {
      setBotThinking(null); // Bot finished thinking
      setGameState(prev => {
        // Trigger dice animation if we just rolled
        if (st.diceResult && (!prev || !prev.diceResult) && st.diceResult !== prev?.diceResult) {
          setAnimDice({ d1: st.dice1, d2: st.dice2, total: st.diceResult });
          setShowDiceAnim(true);
        }
        return st;
      });
    });
    s.on('bot_thinking', (d: { userId: string }) => {
      setBotThinking(d.userId);
    });
    s.on('game_started', () => {
      setGameStarted(true);
      setView('GAME');
    });
    s.on('game_joined', (d: { gameId: string; roomCode?: string }) => {
      setCurrentGameId(d.gameId);
      if (d.roomCode) setRoomCode(d.roomCode);
      setView('LOBBY');
    });
    s.on('action_error', (msg: string) => { setErrorMsg(msg); setTimeout(() => setErrorMsg(null), 3000); });
    s.on('disconnect', () => setIsConnected(false));
    return () => { s.close(); };
  }, [authUser]);

  // ── Derived ──
  const gs = gameState;
  const me = gs?.players[userId] ?? null;
  const isMyTurn = gs ? gs.playerOrder[gs.currentTurnIndex] === userId : false;
  const curPid = gs?.playerOrder[gs?.currentTurnIndex] ?? null;
  const isSetup = gs?.phase === 'SETUP_R1' || gs?.phase === 'SETUP_R2';
  const isMySetupTurn = isSetup && gs?.setupInfo?.currentPlayer === userId;
  const mustDiscard = gs?.playersWhoMustDiscard?.includes(userId) ?? false;
  const pIdx = (pid: string) => (gs?.playerOrder.indexOf(pid) ?? -1) + 1;

  const totalVP = () => {
    if (!me || !gs) return 0;
    let vp = me.score;
    if (gs.longestRoadHolder === userId) vp += 2;
    if (gs.largestArmyHolder === userId) vp += 2;
    vp += (me.devCards?.filter(c => c.type === 'victoryPoint').length ?? 0);
    return vp;
  };

  // ── Handlers ──
  const handleVertexClick = (vid: string) => {
    if (isSetup && isMySetupTurn && gs?.setupInfo?.expectedAction === 'settlement') { emit('place_settlement', { vertexId: vid }); return; }
    if (buildMode === 'settlement') { emit('place_settlement', { vertexId: vid }); setBuildMode(null); }
    else if (buildMode === 'city') { emit('upgrade_city', { vertexId: vid }); setBuildMode(null); }
  };
  const handleEdgeClick = (eid: string) => {
    if (isSetup && isMySetupTurn && gs?.setupInfo?.expectedAction === 'road') { emit('place_road', { edgeId: eid }); return; }
    if (buildMode === 'road' || (gs?.roadBuildingRemaining ?? 0) > 0) { emit('place_road', { edgeId: eid }); if (buildMode === 'road') setBuildMode(null); }
  };
  const handleHexClick = (hc: string) => {
    if (gs?.turnPhase === 'ROBBER_MOVE' && isMyTurn) emit('move_robber', { hexCoord: hc, stealFrom: null });
  };

  const logout = () => {
    localStorage.removeItem('catan_token');
    setAuthUser(null);
    setView('AUTH');
    socket?.close();
    setSocket(null);
  };

  // ═══════════════════════════════════════════════════════════
  //  AUTH VIEW
  // ═══════════════════════════════════════════════════════════

  if (view === 'AUTH' || !authUser) {
    return (
      <div className="game-container">
        <motion.div className="glass-panel auth-card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 style={{ fontSize: '2.2rem', marginBottom: '2px' }}>⚔️ Catan Legends</h1>
          <p style={{ color: 'var(--text-dim)', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
            {authMode === 'login' ? 'Welcome back, settler!' : 'Create your account'}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <input type="text" placeholder="Username" value={username}
              onChange={e => setUsername(e.target.value)}
              className="auth-input" autoFocus
              onKeyDown={e => e.key === 'Enter' && handleAuth()} />
            <input type="password" placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)}
              className="auth-input"
              onKeyDown={e => e.key === 'Enter' && handleAuth()} />

            {authError && <div className="auth-error">{authError}</div>}

            <button className="btn-action btn-lg" style={{ width: '100%' }} onClick={handleAuth} disabled={authLoading}>
              {authLoading ? '...' : authMode === 'login' ? '🎮 Login' : '✨ Register'}
            </button>

            <button className="btn-ghost btn-action" style={{ width: '100%' }}
              onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError(null); }}>
              {authMode === 'login' ? "Don't have an account? Register" : 'Already have an account? Login'}
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  MATCHMAKING
  // ═══════════════════════════════════════════════════════════

  if (view === 'MATCHMAKING') {
    return (
      <div className="game-container" style={{ overflow: 'auto' }}>
        <motion.div className="glass-panel" style={{ width: '440px', padding: '2rem', textAlign: 'center' }}
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 style={{ fontSize: '1.8rem', marginBottom: '4px' }}>⚔️ Catan Legends</h1>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginBottom: '1.5rem' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{authUser.username}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>
              {authUser.wins}W / {authUser.losses}L • ELO {authUser.elo}
            </span>
            <button className="btn-ghost btn-action" style={{ padding: '2px 8px', fontSize: '0.7rem' }}
              onClick={logout}>Logout</button>
          </div>

          <button className="btn-action btn-lg" style={{ width: '100%', marginBottom: '1rem' }}
            onClick={() => socket?.emit('create_lobby', { userId })}>
            ➕ Create New Room
          </button>

          {/* JOIN BY CODE */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem' }}>
            <input className="auth-input" placeholder="Enter Room Code" value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              style={{ flex: 1, textAlign: 'center', fontWeight: 700, letterSpacing: '3px', fontSize: '1.1rem' }}
              maxLength={6}
            />
            <button className="btn-action" disabled={joinCode.length < 4}
              onClick={() => { socket?.emit('join_by_code', { userId, roomCode: joinCode }); }}>
              🔑 Join
            </button>
          </div>

          <h3 style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '6px', fontSize: '0.8rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Open Rooms
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px', maxHeight: '300px', overflowY: 'auto' }}>
            {lobbies.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>No rooms yet. Create one!</p>}
            {lobbies.map(l => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.25)', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ fontSize: '0.85rem' }}>🏰 {l.roomCode || l.id.substring(0, 8)}</span>
                <button className="btn-action" onClick={() => {
                  setCurrentGameId(l.id); setView('LOBBY');
                  socket?.emit('join_game', { gameId: l.id, userId });
                }}>Join</button>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  LOBBY
  // ═══════════════════════════════════════════════════════════

  if (view === 'LOBBY') {
    const players = gs?.playerOrder ?? [];
    const isHost = players[0] === userId;
    const canStart = players.length >= 2;

    return (
      <div className="lobby-screen" style={{ overflow: 'auto' }}>
        <motion.div className="glass-panel lobby-card" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
          <h1 style={{ fontSize: '1.6rem' }}>🏰 Game Lobby</h1>
          
          {/* ROOM CODE - Big, prominent, copyable */}
          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '1rem', border: '1px solid var(--glass-border)' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
              Share this code with friends
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
              <span style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '6px', color: 'var(--accent)' }}>
                {roomCode || currentGameId?.substring(0, 6).toUpperCase()}
              </span>
              <button className="btn-ghost btn-action" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                onClick={() => { navigator.clipboard.writeText(roomCode || ''); }}>
                📋 Copy
              </button>
            </div>
          </div>

          <div className="player-slots">
            {[0, 1, 2, 3].map(i => {
              const pid = players[i];
              const isYou = pid === userId;
              return (
                <motion.div key={i} className={`player-slot ${pid ? 'occupied' : ''} ${isYou ? 'you' : ''}`}
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}>
                  <div className="color-dot" style={{ backgroundColor: COLORS[i] }} />
                  {pid ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div>
                        <div className="slot-name" style={{ color: COLORS[i] }}>
                          {gs?.players[pid]?.isBot ? '🤖 Bot' : COLOR_NAMES[i]} {isYou ? '(You)' : ''}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                          {pid.substring(0, 8)} {i === 0 ? '👑 Host' : ''}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <span className="slot-empty">Waiting for player...</span>
                  )}
                </motion.div>
              );
            })}
          </div>

          {isHost && players.length < 4 && (
            <button className="btn-action btn-ghost" style={{ width: '100%', marginBottom: '10px' }}
              onClick={() => emit('add_bot')}>🤖 Add Bot</button>
          )}

          {!canStart && (
            <div className="lobby-waiting"><div className="spinner" /><span>Need at least 2 players to start</span></div>
          )}
          {isHost && canStart && (
            <button className="btn-action btn-lg" style={{ width: '100%', background: 'var(--success)', marginTop: '0.5rem' }}
              onClick={() => emit('start_game')}>🎮 Start Game ({players.length}/4)</button>
          )}
          {!isHost && canStart && (
            <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
              ⏳ Waiting for host to start...
            </p>
          )}
          <button className="btn-ghost btn-action" style={{ marginTop: '1rem', width: '100%' }}
            onClick={() => setView('MATCHMAKING')}>← Back to Rooms</button>
        </motion.div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  GAME VIEW
  // ═══════════════════════════════════════════════════════════

  const expectedAction = gs?.setupInfo?.expectedAction;

  return (
    <div className="game-layout">
      {/* DICE ROLL ANIMATION */}
      <AnimatePresence>
        {showDiceAnim && (
          <DiceAnimation d1={animDice.d1} d2={animDice.d2} total={animDice.total}
            onComplete={() => setShowDiceAnim(false)} />
        )}
      </AnimatePresence>

      {/* ERROR TOAST */}
      <AnimatePresence>
        {errorMsg && (
          <motion.div className="error-toast" initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}>
            ❌ {errorMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* VICTORY */}
      {gs?.winner && (
        <div className="victory-overlay">
          <motion.div className="glass-panel victory-card" initial={{ scale: 0 }} animate={{ scale: 1 }}>
            <h1>🏆 {gs.winner === userId ? 'YOU WIN!' : `Player ${pIdx(gs.winner)} Wins!`}</h1>
            <p style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>{totalVP()} Victory Points</p>
            <button className="btn-action btn-lg" onClick={() => setView('MATCHMAKING')}>Back to Lobby</button>
          </motion.div>
        </div>
      )}

      {/* TOP BAR */}
      <div className="game-top-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button className="btn-action btn-ghost" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            onClick={() => setView('MATCHMAKING')}>← Leave</button>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            {isSetup ? `Setup ${gs?.phase === 'SETUP_R1' ? 'R1' : 'R2'}` : 'Game'} • {authUser.username}
          </span>
        </div>
        <div className="scoreboard">
          {gs?.playerOrder.map((pid, i) => (
            <div key={pid} className={`score-card ${pid === curPid ? 'active-player' : ''}`}
              style={{ borderColor: gs.players[pid].color }}>
              <span style={{ color: gs.players[pid].color, fontWeight: 700 }}>P{i + 1}</span>
              <span>{gs.players[pid].score}VP</span>
              {pid === userId && <span style={{ fontSize: '0.7rem' }}>⭐</span>}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--danger)' }} />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{isConnected ? 'Live' : '...'}</span>
        </div>
      </div>

      {/* BOARD */}
      <div className="game-board-area">
        {boardState.hexes.length > 0 ? (
          <Board
            hexes={boardState.hexes}
            ports={boardState.ports}
            gameState={gs} onVertexClick={handleVertexClick}
            onEdgeClick={handleEdgeClick} onHexClick={handleHexClick}
            robberHex={gs?.robberHex ?? null} buildMode={buildMode}
            setupHighlight={isMySetupTurn ? expectedAction ?? null : null} />
        ) : <div style={{ color: 'var(--text-dim)' }}>Loading board...</div>}

        {gs && gs.log && gs.log.length > 0 && (
          <div className="game-log">
            {gs.log.slice(-8).map((msg, i) => <div key={i} className="log-entry">{msg}</div>)}
          </div>
        )}
      </div>

      {/* SIDEBAR */}
      <div className="game-sidebar">
        {/* Phase Banner */}
        {isSetup && (
          <div className={`phase-banner ${isMySetupTurn ? 'your-turn' : 'waiting'} ${botThinking ? 'pulsing' : ''}`}>
            {isMySetupTurn ? (
              <><span style={{ fontSize: '1.2rem' }}>{expectedAction === 'settlement' ? '🏠' : '🛤️'}</span>
              <span>Place your {expectedAction}!</span></>
            ) : (
              <span>
                {botThinking ? '🤖 Bot is thinking...' : `⏳ P${pIdx(gs?.setupInfo?.currentPlayer ?? '')} is placing...`}
              </span>
            )}
          </div>
        )}

        {gs?.phase === 'MAIN_GAME' && (
          <div className={`phase-banner ${isMyTurn ? 'your-turn' : 'waiting'} ${botThinking ? 'pulsing' : ''}`}>
            {isMyTurn ? (
              gs.turnPhase === 'MUST_ROLL' ? <span>🎲 Roll the dice!</span> :
              gs.turnPhase === 'ROBBER_MOVE' ? <span>🏴‍☠️ Move the Robber!</span> :
              gs.turnPhase === 'ROBBER_DISCARD' ? <span>⚠️ Discard cards</span> :
              <span>🎯 Build or Trade!</span>
            ) : (
              <span>
                {botThinking ? '🤖 Bot is thinking...' : `⏳ Waiting for P${pIdx(curPid ?? '')}...`}
              </span>
            )}
          </div>
        )}

        {/* Resources */}
        {me && (
          <div className="sidebar-section">
            <h3>Resources</h3>
            <div className="resource-grid">
              {(Object.keys(me.resources) as ResourceType[]).map(r => (
                <div key={r} className="resource-item"><span>{RES[r]}</span><span className="count">{me.resources[r]}</span></div>
              ))}
            </div>
          </div>
        )}

        {/* Bonuses */}
        {gs && (gs.longestRoadHolder === userId || gs.largestArmyHolder === userId) && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {gs.longestRoadHolder === userId && <span className="badge">🛤️ Longest Road +2VP</span>}
            {gs.largestArmyHolder === userId && <span className="badge">⚔️ Largest Army +2VP</span>}
          </div>
        )}

        {/* Dice display */}
        {gs?.phase === 'MAIN_GAME' && gs.diceResult && !showDiceAnim && (
          <div className="dice-display">
            <DiceFace value={gs.dice1} />
            <span style={{ fontSize: '1.2rem', color: 'var(--text-dim)' }}>+</span>
            <DiceFace value={gs.dice2} />
            <span style={{ fontSize: '1.2rem', color: 'var(--text-dim)' }}>=</span>
            <span className="dice-total">{gs.diceResult}</span>
          </div>
        )}

        {/* Discard */}
        {mustDiscard && me && (
          <div className="discard-panel">
            <h4>🏴‍☠️ Discard {Math.floor(Object.values(me.resources).reduce((a, b) => a + b, 0) / 2)} cards</h4>
            <div className="trade-inputs" style={{ marginBottom: '8px' }}>
              {(Object.keys(me.resources) as ResourceType[]).map(r => (
                <div key={r} className="trade-input-item"><span>{RES[r]}</span>
                <input type="number" min={0} max={me.resources[r]} value={discardAmounts[r]}
                  onChange={e => setDiscardAmounts({ ...discardAmounts, [r]: parseInt(e.target.value) || 0 })} /></div>
              ))}
            </div>
            <button className="btn-action" style={{ width: '100%', background: 'var(--danger)', color: 'white' }}
              onClick={() => emit('robber_discard', { discarded: discardAmounts })}>Confirm Discard</button>
          </div>
        )}

        {/* Roll */}
        {gs?.phase === 'MAIN_GAME' && isMyTurn && gs.turnPhase === 'MUST_ROLL' && (
          <button className="btn-action btn-lg" style={{ width: '100%' }} onClick={() => emit('roll_dice')}>
            🎲 Roll Dice
          </button>
        )}

        {/* Build & Trade */}
        {gs?.phase === 'MAIN_GAME' && isMyTurn && gs.turnPhase === 'FREE_ACTION' && (
          <>
            <div className="sidebar-section">
              <h3>Build</h3>
              <div className="build-grid">
                <button className={`build-btn ${buildMode === 'settlement' ? 'active' : ''}`}
                  onClick={() => setBuildMode(buildMode === 'settlement' ? null : 'settlement')}>
                  <span className="build-icon">🏠</span><span>Settlement</span><span className="build-cost">🪵🧱🐑🌾</span>
                </button>
                <button className={`build-btn ${buildMode === 'road' ? 'active' : ''}`}
                  onClick={() => setBuildMode(buildMode === 'road' ? null : 'road')}>
                  <span className="build-icon">🛤️</span><span>Road</span><span className="build-cost">🪵🧱</span>
                </button>
                <button className={`build-btn ${buildMode === 'city' ? 'active' : ''}`}
                  onClick={() => setBuildMode(buildMode === 'city' ? null : 'city')}>
                  <span className="build-icon">🏰</span><span>City</span><span className="build-cost">🌾🌾🪨🪨🪨</span>
                </button>
                <button className="build-btn" onClick={() => emit('buy_dev_card')}>
                  <span className="build-icon">🃏</span><span>Dev Card</span><span className="build-cost">🐑🌾🪨</span>
                </button>
              </div>
              {buildMode && <p style={{ fontSize: '0.75rem', color: 'var(--info)', textAlign: 'center', marginTop: '6px' }}>
                ← Click the board to place your {buildMode}</p>}
            </div>

            <div className="sidebar-section">
              <h3>Trade</h3>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn-action btn-ghost" style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={() => { setShowBankTrade(!showBankTrade); setShowP2PTrade(false); }}>🏛️ Bank 4:1</button>
                <button className="btn-action btn-ghost" style={{ flex: 1, fontSize: '0.75rem' }}
                  onClick={() => { setShowP2PTrade(!showP2PTrade); setShowBankTrade(false); }}>🤝 Player</button>
              </div>
              {showBankTrade && (
                <div style={{ marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <select value={bankOffer} onChange={e => setBankOffer(e.target.value as ResourceType)}
                    style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '6px' }}>
                    {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                  </select>
                  <span>→</span>
                  <select value={bankRequest} onChange={e => setBankRequest(e.target.value as ResourceType)}
                    style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '6px' }}>
                    {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                  </select>
                  <button className="btn-action" style={{ padding: '6px 12px' }}
                    onClick={() => { emit('bank_trade', { offer: bankOffer, request: bankRequest }); setShowBankTrade(false); }}>Go</button>
                </div>
              )}
              {showP2PTrade && (
                <div style={{ marginTop: '8px' }}>
                  <div className="trade-section" style={{ marginBottom: '6px' }}>
                    <h4>You give</h4>
                    <div className="trade-inputs">
                      {(['wood','brick','sheep','wheat','ore'] as const).map(r => (
                        <div key={r} className="trade-input-item"><span>{RES[r]}</span>
                        <input type="number" min={0} value={p2pOffer[r]}
                          onChange={e => setP2pOffer({ ...p2pOffer, [r]: parseInt(e.target.value) || 0 })} /></div>
                      ))}
                    </div>
                  </div>
                  <div className="trade-section">
                    <h4>You want</h4>
                    <div className="trade-inputs">
                      {(['wood','brick','sheep','wheat','ore'] as const).map(r => (
                        <div key={r} className="trade-input-item"><span>{RES[r]}</span>
                        <input type="number" min={0} value={p2pRequest[r]}
                          onChange={e => setP2pRequest({ ...p2pRequest, [r]: parseInt(e.target.value) || 0 })} /></div>
                      ))}
                    </div>
                  </div>
                  <button className="btn-action" style={{ width: '100%', marginTop: '6px' }}
                    onClick={() => { emit('propose_trade', { offering: p2pOffer, requesting: p2pRequest }); setShowP2PTrade(false); }}>
                    Propose Trade</button>
                </div>
              )}
            </div>

            <button className="btn-action end-turn" style={{ width: '100%' }} onClick={() => emit('end_turn')}>
              End Turn ➡️
            </button>
          </>
        )}

        {/* Dev Cards */}
        {me && me.devCards && me.devCards.length > 0 && (
          <div className="sidebar-section">
            <h3 onClick={() => setShowDevCards(!showDevCards)} style={{ cursor: 'pointer' }}>
              🃏 Dev Cards ({me.devCards.length}) {showDevCards ? '▼' : '▶'}
            </h3>
            {showDevCards && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {me.devCards.map((card, i) => (
                  <div key={i} className="dev-card-item">
                    <div><span className="card-name">{card.type}</span>
                      {card.boughtThisTurn && <span className="card-new"> (new)</span>}
                    </div>
                    {card.type !== 'victoryPoint' && !card.boughtThisTurn && isMyTurn && (
                      <button className="btn-action" style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                        onClick={() => emit('play_dev_card', { cardIndex: i })}>Play</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Incoming Trade */}
        {gs?.activeTradeOffer && gs.activeTradeOffer.fromPlayer !== userId && (
          <div className="incoming-trade">
            <h4 style={{ margin: '0 0 6px 0' }}>🤝 Trade from P{pIdx(gs.activeTradeOffer.fromPlayer)}</h4>
            <p style={{ fontSize: '0.8rem', margin: '2px 0' }}>
              Gives: {Object.entries(gs.activeTradeOffer.offering).filter(([, v]) => v && v > 0).map(([r, v]) => `${RES[r]}×${v}`).join(' ')}
            </p>
            <p style={{ fontSize: '0.8rem', margin: '2px 0 8px' }}>
              Wants: {Object.entries(gs.activeTradeOffer.requesting).filter(([, v]) => v && v > 0).map(([r, v]) => `${RES[r]}×${v}`).join(' ')}
            </p>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="btn-action" style={{ flex: 1, background: 'var(--success)' }}
                onClick={() => emit('accept_trade')}>✅ Accept</button>
              <button className="btn-action" style={{ flex: 1, background: 'var(--danger)', color: 'white' }}
                onClick={() => emit('reject_trade')}>❌ Reject</button>
            </div>
          </div>
        )}

        {/* VP */}
        {me && (
          <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Your VP: <strong style={{ color: 'var(--accent)', fontSize: '1.1rem' }}>{totalVP()}</strong> / 10
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

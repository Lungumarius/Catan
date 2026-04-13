import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { Board, type HexData, type PortData } from './Board';
import './App.css';
import musicFile from './music.mp3?url';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f97316'];
const COLOR_NAMES = ['Red', 'Blue', 'Green', 'Orange'];

type ResourceType = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
type Resources = Record<ResourceType, number>;
interface DevCard { type: string; boughtThisTurn: boolean; }
interface PlayerState {
  id: string; username: string; color: string; score: number; resources: Resources;
  devCards: DevCard[]; knightsPlayed: number; hasPlayedDevCardThisTurn: boolean;
  isBot: boolean;
}
interface Building { owner: string; type: 'settlement' | 'city'; }
interface TradeOffer { fromPlayer: string; offering: Partial<Resources>; requesting: Partial<Resources>; rejectedBy?: string[]; }

interface GameEvent {
  type: 'dev_card' | 'steal';
  eventId: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  card?: string;
  details?: {
    knightsTotal?: number;
    res1?: string; res2?: string;
    resource?: string; stolen?: number;
    stolenFrom?: string; stolenFromName?: string; stolenFromColor?: string; stolenRes?: string;
  };
}

export interface GameState {
  status?: string;
  phase: string; turnPhase: string; setupTurnIndex: number;
  players: Record<string, PlayerState>; playerOrder: string[];
  currentTurnIndex: number; diceResult: number | null; dice1: number; dice2: number;
  rollCount: number; lastDiceYields: Record<string, ResourceType[]>;
  buildings: Record<string, Building>; roads: Record<string, string>;
  robberHex: string; playersWhoMustDiscard: string[];
  devCardDeckSize: number;
  longestRoadHolder: string | null; longestRoadLength: number;
  largestArmyHolder: string | null; largestArmySize: number;
  activeTradeOffer: TradeOffer | null;
  log: string[]; winner: string | null;
  setupInfo: { currentPlayer: string; expectedAction: string } | null;
  roadBuildingRemaining: number;
  lastEvent?: GameEvent | null;
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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isRejoining, setIsRejoining] = useState(!!localStorage.getItem('catan_game_id'));
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

  // Fullscreen: real browser API
  const gameLayoutRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [musicStarted, setMusicStarted] = useState(false);
  const [devCardAction, setDevCardAction] = useState<{ index: number, type: string } | null>(null);
  const [devRes1, setDevRes1] = useState<ResourceType>('wood');
  const [devRes2, setDevRes2] = useState<ResourceType>('wheat');

  // Robber steal picker
  const [stealTargets, setStealTargets] = useState<string[]>([]);
  const [pendingRobberHex, setPendingRobberHex] = useState<string | null>(null);

  // Universal Physical Card Animations
  const [globalFlies, setGlobalFlies] = useState<{ id: number; pid: string; res: string; amount: number; isGain: boolean }[]>([]);
  const prevPlayersRef = useRef<Record<string, PlayerState> | null>(null);
  const flyIdRef = useRef(0);

  // Dev Card / Steal event overlay
  const [devCardEvent, setDevCardEvent] = useState<GameEvent | null>(null);
  const lastShownEventId = useRef<string | null>(null);
  useEffect(() => {
    if (devCardEvent) {
      const t = setTimeout(() => setDevCardEvent(null), 3500);
      return () => clearTimeout(t);
    }
  }, [devCardEvent]);


  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        if (document.fullscreenElement) document.exitFullscreen();
        setIsFullscreen(false);
      }
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey && view === 'GAME') {
        const active = document.activeElement?.tagName;
        if (active !== 'INPUT' && active !== 'TEXTAREA') {
          toggleFullscreen();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [view, isFullscreen]);

  function toggleFullscreen() {
    if (!isFullscreen) {
      gameLayoutRef.current?.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      if (document.fullscreenElement) document.exitFullscreen();
      setIsFullscreen(false);
    }
  }

  // Background music
  useEffect(() => {
    const audio = new Audio(musicFile);
    audio.loop = true;
    audio.volume = 0.3;
    audioRef.current = audio;
    return () => { audio.pause(); audio.src = ''; };
  }, []);

  function startMusic() {
    if (!musicStarted && audioRef.current) {
      audioRef.current.play().catch(() => {});
      setMusicStarted(true);
    }
  }

  // ── Global Auto-Play Music on initial interaction ──
  useEffect(() => {
    const handleGlobalClick = () => startMusic();
    document.addEventListener('click', handleGlobalClick);
    return () => document.removeEventListener('click', handleGlobalClick);
  }, [musicStarted]);

  const userId = authUser?.id ?? '';

  const emit = useCallback((event: string, payload: any = {}) => {
    socket?.emit(event, { ...payload, gameId: currentGameId, userId, username: authUser?.username });
  }, [socket, currentGameId, userId, authUser]);

  // ── Check stored token on mount ──
  useEffect(() => {
    const token = localStorage.getItem('catan_token');
    if (token) {
      fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
          if (data.id) { setAuthUser(data); setView('MATCHMAKING'); }
          else { setIsRejoining(false); }
        })
        .catch(() => { setIsRejoining(false); });
    } else {
      setIsRejoining(false);
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
        localStorage.setItem('catan_user', JSON.stringify(data.user));
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

    s.on('connect', () => {
      setIsConnected(true);
      // Attempt to rejoin if we have a saved gameId
      const savedGameId = localStorage.getItem('catan_game_id');
      if (savedGameId) {
        setIsRejoining(true);
        s.emit('rejoin_game', { userId: authUser.id, gameId: savedGameId });
        
        // Safety timeout: if server doesn't respond in 6s, let user play normally
        setTimeout(() => setIsRejoining(false), 6000);
      }
    });
    s.on('disconnect', () => setIsConnected(false));
    s.on('game_joined', (data) => {
      setIsRejoining(false);
      setCurrentGameId(data.gameId);
      setRoomCode(data.roomCode);
      localStorage.setItem('catan_game_id', data.gameId);
      localStorage.setItem('catan_room_code', data.roomCode);
      setView('LOBBY');
    });
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

      // Universal Physical Card Animations: detect gains and losses for ALL players
      if (prevPlayersRef.current) {
        const prevP = prevPlayersRef.current;
        const flies: { id: number; pid: string; res: string; amount: number; isGain: boolean }[] = [];
        
        for (const pid of st.playerOrder) {
          const myRes = st.players[pid]?.resources;
          const oldRes = prevP[pid]?.resources;
          if (myRes && oldRes) {
            for (const r of ['wood','brick','sheep','wheat','ore'] as ResourceType[]) {
              const diff = myRes[r] - (oldRes[r] || 0);
              if (diff !== 0) {
                flies.push({ id: flyIdRef.current++, pid, res: r, amount: Math.abs(diff), isGain: diff > 0 });
              }
            }
          }
        }
        
        if (flies.length > 0) {
          // If a dice roll just happened, wait for the animation to finish (~2s)
          const delay = (st.diceResult && (!prevP || !prevP[authUser.id]) && st.diceResult !== (gameState?.diceResult)) ? 2200 : 0;
          
          setTimeout(() => {
            setGlobalFlies(f => [...f, ...flies]);
            setTimeout(() => {
              setGlobalFlies(f => f.filter(x => !flies.some(y => y.id === x.id)));
            }, 3500);
          }, delay);
        }
      }
      
      // Save deep copy of all players for accurate deltas
      prevPlayersRef.current = JSON.parse(JSON.stringify(st.players));

      // Persistence Fix: Only auto-switch to GAME view if the game has explicitly STARTED
      if (st.status === 'STARTED' && view !== 'GAME') {
        setView('GAME');
      }
      setIsRejoining(false);

      // Dev card / steal event overlay
      if (st.lastEvent && st.lastEvent.eventId !== lastShownEventId.current) {
        lastShownEventId.current = st.lastEvent.eventId;
        setDevCardEvent(st.lastEvent);
      }


      // If finished game session, clear it from storage
      if (st.status === 'FINISHED') {
        localStorage.removeItem('catan_game_id');
        localStorage.removeItem('catan_room_code');
      }
    });
    s.on('bot_thinking', (d: { userId: string }) => {
      setBotThinking(d.userId);
    });
    s.on('game_started', () => {
      setIsRejoining(false);
      setGameStarted(true);
      setView('GAME');
    });
    s.on('action_error', (msg: string) => { 
      setIsRejoining(false);
      if (msg.toLowerCase().includes('not found')) {
        localStorage.removeItem('catan_game_id');
        localStorage.removeItem('catan_room_code');
      }
      setErrorMsg(msg); 
      setTimeout(() => setErrorMsg(null), 3000); 
    });
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
    if (gs?.turnPhase === 'ROBBER_MOVE' && isMyTurn) {
      // Find players with buildings on this hex to allow steal picker
      const hexQ = parseInt(hc.split(',')[0]);
      const hexR = parseInt(hc.split(',')[1]);
      const HEX_WIDTH = 200;
      const SIZE = 115.47;
      const cx = HEX_WIDTH * (hexQ + hexR / 2);
      const cy = SIZE * 1.5 * hexR;
      const hexVerts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (30 + 60 * i);
        hexVerts.push(`${Math.round(cx + SIZE * Math.cos(a))},${Math.round(cy + SIZE * Math.sin(a))}`);
      }
      const targets = new Set<string>();
      hexVerts.forEach(v => {
        const bld = gs?.buildings[v];
        if (bld && bld.owner !== userId) targets.add(bld.owner);
      });
      const targetList = Array.from(targets);
      
      if (targetList.length === 0) {
        // No one to steal from
        emit('move_robber', { hexCoord: hc, stealFrom: null });
      } else if (targetList.length === 1) {
        // Auto-steal from the only player
        emit('move_robber', { hexCoord: hc, stealFrom: targetList[0] });
      } else {
        // Show picker modal
        setPendingRobberHex(hc);
        setStealTargets(targetList);
      }
    }
  };

  const getBestBankRate = (offerRes: ResourceType) => {
    if (!gs) return 4;
    let rate = 4;
    const myBuildings = Object.keys(gs.buildings).filter(v => gs.buildings[v].owner === userId);
    for (const port of boardState.ports) {
      const hasAccess = port.vertices.some(pv => myBuildings.includes(pv));
      if (hasAccess) {
        if (port.type === 'generic' && rate > 3) rate = 3;
        if (port.type === offerRes && rate > 2) rate = 2;
      }
    }
    return rate;
  };

  const logout = () => {
    localStorage.removeItem('catan_token');
    localStorage.removeItem('catan_user');
    localStorage.removeItem('catan_game_id');
    localStorage.removeItem('catan_room_code');
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
            onClick={() => socket?.emit('create_lobby', { userId, username: authUser.username })}>
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
              onClick={() => { socket?.emit('join_by_code', { userId, roomCode: joinCode, username: authUser.username }); }}>
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
                  socket?.emit('join_game', { gameId: l.id, userId, username: authUser.username });
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
                          {gs?.players[pid]?.username || COLOR_NAMES[i]} {isYou ? '(You)' : ''}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                          {gs?.players[pid]?.isBot ? 'Legendary Opponent' : 'Human Player'} {i === 0 ? '👑 Host' : ''}
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
    <div className={`game-layout ${isFullscreen ? 'fullscreen-mode' : ''}`} ref={gameLayoutRef} onClick={startMusic}>
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



      {/* DEV CARD / STEAL EVENT OVERLAY */}
      <AnimatePresence>
        {devCardEvent && (
          <motion.div
            key={devCardEvent.eventId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0, zIndex: 9800,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
              pointerEvents: 'none',
            }}
          >
            <motion.div
              initial={{ scale: 0.2, y: 80, rotate: -10 }}
              animate={{ scale: 1, y: 0, rotate: 0 }}
              exit={{ scale: 0.4, y: -60, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 280, damping: 22 }}
              style={{
                background: 'linear-gradient(135deg, rgba(10,12,28,0.99) 0%, rgba(25,15,55,0.99) 100%)',
                border: `2.5px solid ${devCardEvent.playerColor}`,
                borderRadius: '24px',
                padding: '2.2rem 3rem',
                textAlign: 'center',
                boxShadow: `0 0 80px ${devCardEvent.playerColor}55, 0 25px 70px rgba(0,0,0,0.9)`,
                maxWidth: '420px',
                width: '88vw',
              }}
            >
              <motion.div initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', letterSpacing: '2.5px', textTransform: 'uppercase', marginBottom: '6px' }}>
                  {devCardEvent.type === 'steal' ? '🏴‍☠️ Robber' : '🃏 Card Played'}
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: 900, color: devCardEvent.playerColor, marginBottom: '0.4rem', textShadow: `0 0 20px ${devCardEvent.playerColor}` }}>
                  {devCardEvent.playerName}
                </div>
              </motion.div>

              <motion.div
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', delay: 0.18, stiffness: 350, damping: 18 }}
                style={{ fontSize: '5.5rem', margin: '0.4rem 0', lineHeight: 1, filter: `drop-shadow(0 0 20px ${devCardEvent.playerColor})` }}
              >
                {devCardEvent.type === 'steal' ? '🏴‍☠️'
                  : devCardEvent.card === 'knight' ? '⚔️'
                  : devCardEvent.card === 'yearOfPlenty' ? '🌟'
                  : devCardEvent.card === 'monopoly' ? '💰'
                  : devCardEvent.card === 'roadBuilding' ? '🛣️'
                  : '🃏'}
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.32 }}
                style={{ fontSize: '1.05rem', color: 'rgba(255,255,255,0.75)', lineHeight: 1.6 }}
              >
                {devCardEvent.type === 'steal' && devCardEvent.details?.stolenFromName && (
                  <>
                    <span style={{ color: '#fbbf24', fontWeight: 700 }}>stole a card</span>
                    {' from '}
                    <span style={{ color: devCardEvent.details.stolenFromColor || '#fff', fontWeight: 900 }}>
                      {devCardEvent.details.stolenFromName}
                    </span>
                    {devCardEvent.details.stolenRes && (
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.45, type: 'spring' }}
                        style={{ fontSize: '2.5rem', marginTop: '6px' }}>
                        {RES[devCardEvent.details.stolenRes] || '🃏'}
                      </motion.div>
                    )}
                  </>
                )}
                {devCardEvent.card === 'knight' && (
                  <>
                    <span style={{ color: '#ef4444', fontWeight: 700 }}>Knight Card!</span>
                    {devCardEvent.details?.knightsTotal && (
                      <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
                        {devCardEvent.details.knightsTotal} knights played total
                      </div>
                    )}
                  </>
                )}
                {devCardEvent.card === 'yearOfPlenty' && devCardEvent.details?.res1 && (
                  <>
                    <span style={{ color: '#fbbf24', fontWeight: 700 }}>Year of Plenty!</span>
                    <div style={{ fontSize: '2rem', marginTop: '4px' }}>
                      {RES[devCardEvent.details.res1]} + {RES[devCardEvent.details.res2 || devCardEvent.details.res1]}
                    </div>
                  </>
                )}
                {devCardEvent.card === 'monopoly' && (
                  <>
                    <span style={{ color: '#f97316', fontWeight: 700 }}>Monopoly on </span>
                    <span style={{ color: '#fbbf24', fontWeight: 900 }}>{devCardEvent.details?.resource}</span>
                    {(devCardEvent.details?.stolen ?? 0) > 0 && (
                      <div style={{ color: '#ef4444', marginTop: '4px', fontWeight: 700 }}>
                        Stole {devCardEvent.details!.stolen} cards from everyone!
                      </div>
                    )}
                  </>
                )}
                {devCardEvent.card === 'roadBuilding' && (
                  <span style={{ color: '#22c55e', fontWeight: 700 }}>Builds 2 free roads!</span>
                )}
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ROBBER STEAL PICKER */}

      {pendingRobberHex && stealTargets.length > 0 && (
        <div className="steal-picker-overlay">
          <motion.div className="steal-picker-card" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            <h3>🏴‍☠️ Choose who to steal from</h3>
            <div className="steal-targets">
              {stealTargets.map(pid => {
                const player = gs?.players[pid];
                const idx = gs?.playerOrder.indexOf(pid) ?? 0;
                return (
                  <button key={pid} className="steal-target-btn"
                    onClick={() => {
                      emit('move_robber', { hexCoord: pendingRobberHex, stealFrom: pid });
                      setPendingRobberHex(null);
                      setStealTargets([]);
                    }}>
                    <div className="steal-dot" style={{ backgroundColor: player?.color }} />
                    <span>{player?.username || `Player ${idx + 1}`}</span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        </div>
      )}

      {/* PERSONAL TEXT FLY-IN (+1 🌾) */}
      <AnimatePresence>
        {globalFlies.filter(f => f.pid === userId).map((fly, i) => (
          <motion.div key={`text-${fly.id}`}
            initial={{ opacity: 1, y: 0, x: 0, scale: 1.2 }}
            animate={{ opacity: 0, y: -80, scale: 0.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.8, ease: 'easeOut' }}
            style={{ 
              top: `${50 + i * 10}%`, 
              right: '320px', 
              position: 'absolute', 
              zIndex: 9600,
              pointerEvents: 'none'
            }}>
            <span style={{ 
              color: fly.isGain ? '#a7f3d0' : '#fca5a5', 
              fontWeight: 800, 
              fontSize: '1.5rem',
              background: 'rgba(0,0,0,0.7)',
              padding: '6px 14px',
              borderRadius: '20px',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
            }}>
              {fly.isGain ? '+' : '-'}{fly.amount} {RES[fly.res as ResourceType]}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* VICTORY */}
      {gs?.winner && (
        <div className="victory-overlay">
          <motion.div className="glass-panel victory-card" initial={{ scale: 0 }} animate={{ scale: 1 }}>
            <h1>🏆 {gs.winner === userId ? 'YOU WIN!' : `${gs.players[gs.winner]?.username || 'Player'} Wins!`}</h1>
            <p style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>{totalVP()} Victory Points</p>
            <button className="btn-action btn-lg" onClick={() => {
              localStorage.removeItem('catan_game_id');
              localStorage.removeItem('catan_room_code');
              setGameState(null);
              setView('MATCHMAKING');
            }}>Back to Lobby</button>
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
          {gs?.playerOrder.map((pid, i) => {
            const hasRoad = gs.longestRoadHolder === pid;
            const hasArmy = gs.largestArmyHolder === pid;
            return (
              <div key={pid} style={{ position: 'relative' }}>
                <div className={`score-card ${pid === curPid ? 'active-player' : ''}`}
                  style={{ borderColor: gs.players[pid].color }}>
                  <span style={{ color: gs.players[pid].color, fontWeight: 700, fontSize: '0.9rem' }}>{gs.players[pid].username || `P${i + 1}`}</span>
                  <span>{gs.players[pid].score}VP</span>
                  {pid === userId && <span style={{ fontSize: '0.7rem' }}>⭐</span>}
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginLeft: '4px' }}>
                    {Object.values(gs.players[pid].resources).reduce((a: number, b: number) => a + b, 0)}🃏
                    {' '}·{' '}
                    {gs.players[pid].devCards?.length ?? 0}🎴
                  </span>
                  <div style={{ display: 'flex', gap: '4px', marginLeft: '6px' }}>
                    {hasRoad && (
                      <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} title="Longest Road" 
                        style={{ fontSize: '1.2rem', filter: 'drop-shadow(0 0 5px gold)' }}>🛤️</motion.span>
                    )}
                    {hasArmy && (
                      <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} title="Largest Army" 
                        style={{ fontSize: '1.2rem', filter: 'drop-shadow(0 0 5px gold)' }}>⚔️</motion.span>
                    )}
                  </div>
                </div>

                {/* Universal Physical Card Animations */}
                <div style={{ position: 'absolute', top: '140%', left: '50%', transform: 'translateX(-50%)', zIndex: 9000, display: 'flex', pointerEvents: 'none' }}>
                  <AnimatePresence>
                    {globalFlies.filter(f => f.pid === pid).flatMap((fly, fIdx, arr) => {
                      return Array.from({ length: fly.amount }).map((_, cIdx) => {
                        const uniqueId = `${fly.id}-${cIdx}`;
                        // We map all cards for this user to create a coherent fanned hand
                        const totalCardsForUser = arr.reduce((sum, f) => sum + f.amount, 0);
                        let offsetIndex = 0;
                        for (let j = 0; j < fIdx; j++) offsetIndex += arr[j].amount;
                        offsetIndex += cIdx;
                        
                        const angle = (offsetIndex - (totalCardsForUser - 1) / 2) * 12;
                        const isFirstCard = offsetIndex === 0;
                        
                        return (
                          <motion.div key={uniqueId} className={`deal-card ${fly.res}`}
                            initial={fly.isGain 
                              ? { opacity: 0, y: -40, scale: 0.3, rotate: angle - 30 } 
                              : { opacity: 1, y: 0, scale: 1, rotate: angle }}
                            animate={fly.isGain 
                              ? { opacity: 1, y: 0, scale: 1, rotate: angle } 
                              : { opacity: 0, y: 60, scale: 0.5, rotate: angle + 30, filter: 'grayscale(100%)' }}
                            exit={{ opacity: 0, scale: 0.2 }}
                            transition={{ type: 'spring', bounce: 0.4 }}
                            style={{ 
                              position: isFirstCard ? 'relative' : 'absolute', 
                              left: isFirstCard ? 0 : `${offsetIndex * 15}px`, /* Fanning horizontal spread */
                              boxShadow: fly.isGain ? '0 10px 20px rgba(0,0,0,0.8)' : 'none'
                             }}
                          >
                            {RES[fly.res as ResourceType]}
                            {!fly.isGain && (
                              <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,0,0,0.5)', borderRadius: '6px' }} />
                            )}
                          </motion.div>
                        );
                      });
                    })}
                  </AnimatePresence>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button className="btn-fullscreen" onClick={() => toggleFullscreen()}
            title="Toggle fullscreen (F)">⛶ {isFullscreen ? 'Exit' : 'Full'}</button>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--danger)' }} />
          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{isConnected ? 'Live' : '...'}</span>
        </div>
      </div>

      {/* FULLSCREEN EXIT HINT */}
      {isFullscreen && (
        <div className="fullscreen-exit-hint" onClick={() => setIsFullscreen(false)}>
          Press <b>Esc</b> or <b>F</b> to exit fullscreen
        </div>
      )}

      {/* BOARD */}
      <div className="game-board-area">
        {boardState.hexes.length > 0 ? (
          <Board
            hexes={boardState.hexes}
            ports={boardState.ports}
            gameState={gs} onVertexClick={handleVertexClick}
            onEdgeClick={handleEdgeClick} onHexClick={handleHexClick}
            robberHex={gs?.robberHex ?? null} buildMode={buildMode}
            setupHighlight={isMySetupTurn ? expectedAction ?? null : null}
            currentPlayerColor={gs?.players[userId]?.color} />
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

        {/* Resources — Card Style */}
        {me && (
          <div className="sidebar-section">
            <h3>Resources</h3>
            <div className="resource-cards-row">
              {(['wood','brick','sheep','wheat','ore'] as ResourceType[]).map(r => (
                <div key={r} className={`resource-card ${r}`}>
                  <span className="rc-icon">{RES[r]}</span>
                  <span className="rc-count">{me.resources[r]}</span>
                  <span className="rc-name">{r}</span>
                </div>
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
            <div className="stepper-row" style={{ marginBottom: '8px' }}>
              {(['wood','brick','sheep','wheat','ore'] as ResourceType[]).map(r => (
                <div key={r} className="stepper-item">
                  <span className="stepper-icon">{RES[r]}</span>
                  <span className="stepper-value">{discardAmounts[r]}</span>
                  <div className="stepper-controls">
                    <button className="stepper-btn" onClick={() => setDiscardAmounts(d => ({ ...d, [r]: Math.max(0, d[r] - 1) }))}>−</button>
                    <button className="stepper-btn" onClick={() => setDiscardAmounts(d => ({ ...d, [r]: Math.min(me.resources[r], d[r] + 1) }))}>+</button>
                  </div>
                </div>
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
                <div style={{ marginTop: '8px', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
                    <select value={bankOffer} onChange={e => setBankOffer(e.target.value as ResourceType)}
                      style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '6px' }}>
                      {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                    </select>
                    <span>→</span>
                    <select value={bankRequest} onChange={e => setBankRequest(e.target.value as ResourceType)}
                      style={{ flex: 1, background: '#1e293b', color: 'white', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '6px' }}>
                      {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 600 }}>
                      Rate: {getBestBankRate(bankOffer)}:1 {getBestBankRate(bankOffer) < 4 ? '✨' : ''}
                    </span>
                    <button className="btn-action" style={{ padding: '4px 16px' }}
                    onClick={() => { emit('bank_trade', { offer: bankOffer, request: bankRequest }); setShowBankTrade(false); setBankOffer('wood'); setBankRequest('ore'); }}>Trade</button>
                  </div>
                </div>
              )}
              {showP2PTrade && (
                <div style={{ marginTop: '8px' }}>
                  {/* Show current hand during trade */}
                  {me && (
                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '8px', padding: '6px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px' }}>
                      {(['wood','brick','sheep','wheat','ore'] as ResourceType[]).map(r => (
                        <span key={r} style={{ fontSize: '0.75rem', color: me.resources[r] > 0 ? 'var(--accent)' : 'var(--text-dim)' }}>
                          {RES[r]}{me.resources[r]}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="trade-section" style={{ marginBottom: '6px' }}>
                    <h4>You give</h4>
                    <div className="stepper-row">
                      {(['wood','brick','sheep','wheat','ore'] as const).map(r => (
                        <div key={r} className="stepper-item">
                          <span className="stepper-icon">{RES[r]}</span>
                          <span className="stepper-value">{p2pOffer[r]}</span>
                          <div className="stepper-controls">
                            <button className="stepper-btn" onClick={() => setP2pOffer(o => ({ ...o, [r]: Math.max(0, o[r] - 1) }))}>−</button>
                            <button className="stepper-btn" onClick={() => setP2pOffer(o => ({ ...o, [r]: o[r] + 1 }))}>+</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="trade-section">
                    <h4>You want</h4>
                    <div className="stepper-row">
                      {(['wood','brick','sheep','wheat','ore'] as const).map(r => (
                        <div key={r} className="stepper-item">
                          <span className="stepper-icon">{RES[r]}</span>
                          <span className="stepper-value">{p2pRequest[r]}</span>
                          <div className="stepper-controls">
                            <button className="stepper-btn" onClick={() => setP2pRequest(o => ({ ...o, [r]: Math.max(0, o[r] - 1) }))}>−</button>
                            <button className="stepper-btn" onClick={() => setP2pRequest(o => ({ ...o, [r]: o[r] + 1 }))}>+</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <button className="btn-action" style={{ width: '100%', marginTop: '6px' }}
                    onClick={() => { emit('propose_trade', { offering: p2pOffer, requesting: p2pRequest }); setShowP2PTrade(false); setP2pOffer(ZERO_RES()); setP2pRequest(ZERO_RES()); }}>
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
                    <div style={{ flex: 1 }}><span className="card-name">{card.type}</span>
                      {card.boughtThisTurn && <span className="card-new"> (new)</span>}
                    </div>
                    {card.type !== 'victoryPoint' && !card.boughtThisTurn && isMyTurn && !me.hasPlayedDevCardThisTurn && (
                      <button className="btn-action" style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                        onClick={() => {
                          if (card.type === 'yearOfPlenty' || card.type === 'monopoly') {
                            setDevCardAction(devCardAction?.index === i ? null : { index: i, type: card.type });
                          } else {
                            emit('play_dev_card', { cardIndex: i });
                          }
                        }}>Play</button>
                    )}
                  </div>
                ))}

                {/* Modals for Year of Plenty / Monopoly */}
                {devCardAction && (
                  <div className="glass-panel" style={{ padding: '10px', marginTop: '4px', fontSize: '0.8rem', background: 'rgba(0,0,0,0.5)' }}>
                    {devCardAction.type === 'monopoly' ? (
                      <>
                        <h4 style={{ margin: '0 0 6px 0' }}>Monopoly: Choose Resource</h4>
                        <select value={devRes1} onChange={e => setDevRes1(e.target.value as ResourceType)} style={{ width: '100%', marginBottom: '8px', padding: '4px' }}>
                          {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                        </select>
                        <button className="btn-action" style={{ width: '100%' }} onClick={() => {
                          emit('play_dev_card', { cardIndex: devCardAction.index, payload: { resource: devRes1 } });
                          setDevCardAction(null);
                        }}>Steal All</button>
                      </>
                    ) : (
                      <>
                        <h4 style={{ margin: '0 0 6px 0' }}>Year of Plenty: Choose 2</h4>
                        <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                          <select value={devRes1} onChange={e => setDevRes1(e.target.value as ResourceType)} style={{ flex: 1, padding: '4px' }}>
                            {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                          </select>
                          <select value={devRes2} onChange={e => setDevRes2(e.target.value as ResourceType)} style={{ flex: 1, padding: '4px' }}>
                            {(['wood','brick','sheep','wheat','ore'] as const).map(r => <option key={r} value={r}>{RES[r]} {r}</option>)}
                          </select>
                        </div>
                        <button className="btn-action" style={{ width: '100%' }} onClick={() => {
                          emit('play_dev_card', { cardIndex: devCardAction.index, payload: { res1: devRes1, res2: devRes2 } });
                          setDevCardAction(null);
                        }}>Take Resources</button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Universal Trade Overlay (Prominent) */}
        <AnimatePresence>
          {gs?.activeTradeOffer && (
            <div className="trade-fullscreen-overlay">
              <motion.div className="glass-panel trade-modal" 
                initial={{ scale: 0.8, opacity: 0, y: 50 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.8, opacity: 0, y: 50 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '15px', marginBottom: '1.5rem' }}>
                  <div className="trade-p-pill" style={{ borderColor: gs.players[gs.activeTradeOffer.fromPlayer]?.color }}>
                    {gs.players[gs.activeTradeOffer.fromPlayer]?.username}
                  </div>
                  <span style={{ fontSize: '1.5rem' }}>🤝</span>
                  <div className="trade-p-pill" style={{ opacity: 0.6 }}>Anyone</div>
                </div>

                <div className="trade-flow">
                  <div className="trade-block">
                    <div className="trade-label">Gives</div>
                    <div className="trade-cards">
                      {Object.entries(gs.activeTradeOffer.offering).flatMap(([res, amt]) => 
                        Array.from({ length: amt || 0 }).map((_, i) => (
                          <div key={`${res}-${i}`} className={`deal-card ${res}`} style={{ margin: '0 -10px' }}>
                            {RES[res]}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="trade-arrow">➡️</div>

                  <div className="trade-block">
                    <div className="trade-label">Wants</div>
                    <div className="trade-cards">
                      {Object.entries(gs.activeTradeOffer.requesting).flatMap(([res, amt]) => 
                        Array.from({ length: amt || 0 }).map((_, i) => (
                          <div key={`${res}-${i}`} className={`deal-card ${res}`} style={{ margin: '0 -10px' }}>
                            {RES[res]}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="trade-actions" style={{ marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {/* Always show the current player's resources */}
                  {me && (
                    <div style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.4)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '5px' }}>
                        Your Resources
                      </div>
                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                        {(['wood','brick','sheep','wheat','ore'] as ResourceType[]).map(r => (
                          <span key={r} style={{
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            color: me.resources[r] > 0 ? 'var(--accent)' : 'rgba(255,255,255,0.25)',
                          }}>
                            {RES[r]}{me.resources[r]}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '10px' }}>
                    {gs.activeTradeOffer.fromPlayer !== userId ? (
                      <>
                        <button className="btn-action btn-lg" style={{ flex: 2, background: 'var(--success)' }}
                          onClick={() => emit('accept_trade')}>✅ Accept Trade</button>
                        <button className="btn-action btn-ghost" style={{ flex: 1 }}
                          onClick={() => emit('reject_trade')}>Dismiss</button>
                      </>
                    ) : (
                      <button className="btn-action btn-ghost" style={{ width: '100%', border: '1px dashed var(--danger)', color: 'var(--danger)' }}
                        onClick={() => emit('reject_trade')}>❌ Cancel My Offer</button>
                    )}
                  </div>
                </div>

              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* VP */}
        {me && (
          <div style={{ textAlign: 'center', padding: '8px', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Your VP: <strong style={{ color: 'var(--accent)', fontSize: '1.1rem' }}>{totalVP()}</strong> / 10
          </div>
        )}
      </div>

      <AnimatePresence>
        {isRejoining && (
          <motion.div 
            className="rejoin-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="rejoin-content">
              <div className="golden-spinner"></div>
              <h1>Rejoining your Legend...</h1>
              <p>Restoring your throne on the island of Catan</p>
              
              {/* Emergency button if it takes too long */}
              <button 
                className="btn-action btn-ghost" 
                style={{ marginTop: '2rem', fontSize: '0.8rem', opacity: 0.6 }}
                onClick={() => setIsRejoining(false)}
              >
                Enter anyway
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;

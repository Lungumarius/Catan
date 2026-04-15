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
type GameExpansion = 'base' | 'seafarers';
interface DevCard { type: string; boughtThisTurn: boolean; }
interface PlayerState {
  id: string; username: string; color: string; score: number; resources: Resources;
  devCards: DevCard[]; knightsPlayed: number; hasPlayedDevCardThisTurn: boolean;
  isBot: boolean;
}
interface Building { owner: string; type: 'settlement' | 'city'; }
interface TradeOffer { fromPlayer: string; offering: Partial<Resources>; requesting: Partial<Resources>; rejectedBy?: string[]; }
interface ValidMoves {
  settlements: string[];
  roads: string[];
  ships: string[];
  movableShips: string[];
  cities: string[];
  robberHexes: string[];
}

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
  expansion?: GameExpansion;
  phase: string; turnPhase: string; setupTurnIndex: number;
  players: Record<string, PlayerState>; playerOrder: string[];
  currentTurnIndex: number; diceResult: number | null; dice1: number; dice2: number;
  rollCount: number; lastDiceYields: Record<string, ResourceType[]>;
  buildings: Record<string, Building>; roads: Record<string, string>; ships?: Record<string, string>;
  robberHex: string; pirateHex?: string | null; playersWhoMustDiscard: string[];
  pendingGoldChoices?: Record<string, number>;
  devCardDeckSize: number;
  longestRoadHolder: string | null; longestRoadLength: number;
  largestArmyHolder: string | null; largestArmySize: number;
  activeTradeOffer: TradeOffer | null;
  log: string[]; winner: string | null;
  setupInfo: { currentPlayer: string; expectedAction: string } | null;
  roadBuildingRemaining: number;
  lastEvent?: GameEvent | null;
  validMoves?: Record<string, ValidMoves>;
}


const RES: Record<string, string> = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
const ZERO_RES = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const ACTION_LABELS: Record<string, string> = {
  place_settlement: 'Placing settlement',
  place_road: 'Placing road',
  place_ship: 'Placing ship',
  move_ship: 'Moving ship',
  upgrade_city: 'Upgrading city',
  move_robber: 'Moving robber',
  robber_discard: 'Discarding cards',
  roll_dice: 'Rolling dice',
  end_turn: 'Ending turn',
  bank_trade: 'Trading with bank',
  propose_trade: 'Sending trade',
  accept_trade: 'Accepting trade',
  reject_trade: 'Updating trade',
  choose_gold_resource: 'Choosing gold resource',
  buy_dev_card: 'Buying dev card',
  play_dev_card: 'Playing dev card',
  create_rematch: 'Creating rematch',
};

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

function DiceAnimation({ d1, d2, total, motionMode, onComplete }: { d1: number; d2: number; total: number; motionMode: 'fast' | 'cinematic'; onComplete: () => void }) {
  const [phase, setPhase] = useState<'rolling' | 'result'>('rolling');
  const [rng1, setRng1] = useState(1);
  const [rng2, setRng2] = useState(1);

  useEffect(() => {
    let frame = 0;
    const interval = setInterval(() => {
      setRng1(Math.floor(Math.random() * 6) + 1);
      setRng2(Math.floor(Math.random() * 6) + 1);
      frame++;
      if (frame >= (motionMode === 'fast' ? 5 : 12)) {
        clearInterval(interval);
        setPhase('result');
        setTimeout(onComplete, motionMode === 'fast' ? 320 : 1200);
      }
    }, motionMode === 'fast' ? 45 : 70);
    return () => clearInterval(interval);
  }, [d1, d2, motionMode, onComplete]);

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

function resourceTotal(resources: Partial<Resources>) {
  return Object.values(resources).reduce((sum, amount) => sum + (amount ?? 0), 0);
}

function scoreTrade(resources: Resources, incoming: Partial<Resources>, outgoing: Partial<Resources>) {
  const next = { ...resources };
  for (const [res, amount] of Object.entries(incoming)) next[res as ResourceType] += amount ?? 0;
  for (const [res, amount] of Object.entries(outgoing)) next[res as ResourceType] -= amount ?? 0;

  const plans = [
    { cost: { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 }, weight: 12 },
    { cost: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 }, weight: 9 },
    { cost: { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 }, weight: 5 },
    { cost: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 }, weight: 4 },
  ] as const;

  return plans.reduce((score, plan) => {
    const beforeMissing = (Object.keys(plan.cost) as ResourceType[]).reduce((sum, res) => sum + Math.max(0, plan.cost[res] - resources[res]), 0);
    const afterMissing = (Object.keys(plan.cost) as ResourceType[]).reduce((sum, res) => sum + Math.max(0, plan.cost[res] - next[res]), 0);
    return score + Math.max(0, beforeMissing - afterMissing) * plan.weight;
  }, 0);
}

// ═══════════════════════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════════════════════

type View = 'AUTH' | 'MATCHMAKING' | 'LOBBY' | 'GAME';
type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'FINISHED';
type PlayerPresenceState = Record<string, { connected: boolean; lastSeenAt: string | null }>;

interface AuthUser { id: string; username: string; wins: number; losses: number; elo: number; }
interface MatchHistoryEntry {
  gameId: string;
  roomCode: string;
  finishedAt: string;
  winner: { id: string; username: string; color: string | null } | null;
  didWin: boolean;
  finalVp: number;
  standings: { id: string; username: string; color: string; vp: number }[];
}

interface MatchHistoryResponse {
  items: MatchHistoryEntry[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

function getViewForStatus(status?: string): View {
  return status === 'IN_PROGRESS' || status === 'FINISHED' ? 'GAME' : 'LOBBY';
}

function App() {
  // Auth state
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authRestoring, setAuthRestoring] = useState(() => !!localStorage.getItem('catan_token'));
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);

  // Socket & game state
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [boardState, setBoardState] = useState<{ hexes: HexData[], ports: PortData[] }>({ hexes: [], ports: [] });
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [view, setView] = useState<View>('AUTH');
  const [lobbies, setLobbies] = useState<any[]>([]);
  const [matchHistory, setMatchHistory] = useState<MatchHistoryEntry[]>([]);
  const [matchHistoryPage, setMatchHistoryPage] = useState(1);
  const [hasMoreMatchHistory, setHasMoreMatchHistory] = useState(false);
  const [currentGameId, setCurrentGameId] = useState<string | null>(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [botThinking, setBotThinking] = useState<string | null>(null);
  const [playerPresence, setPlayerPresence] = useState<PlayerPresenceState>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isRejoining, setIsRejoining] = useState(!!localStorage.getItem('catan_game_id'));
  void gameStarted; // Used by game_started socket event

  // UI state
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [buildMode, setBuildMode] = useState<'settlement' | 'road' | 'ship' | 'moveShip' | 'city' | null>(null);
  const [selectedShipEdge, setSelectedShipEdge] = useState<string | null>(null);
  const [showBankTrade, setShowBankTrade] = useState(false);
  const [showP2PTrade, setShowP2PTrade] = useState(false);
  const [showDevCards, setShowDevCards] = useState(false);
  const [bankOffer, setBankOffer] = useState<ResourceType>('wood');
  const [bankRequest, setBankRequest] = useState<ResourceType>('ore');
  const [p2pOffer, setP2pOffer] = useState<Resources>(ZERO_RES());
  const [p2pRequest, setP2pRequest] = useState<Resources>(ZERO_RES());
  const [discardAmounts, setDiscardAmounts] = useState<Resources>(ZERO_RES());
  const [showLogDrawer, setShowLogDrawer] = useState(false);
  const [motionMode, setMotionMode] = useState<'fast' | 'cinematic'>(() =>
    localStorage.getItem('catan_motion_mode') === 'cinematic' ? 'cinematic' : 'fast'
  );

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
  const latestDiceResultRef = useRef<number | null>(null);
  const flyIdRef = useRef(0);
  const rejoinTimeoutRef = useRef<number | null>(null);
  const currentGameIdRef = useRef<string | null>(null);
  const pendingActionSeqRef = useRef(0);
  const pendingEventRef = useRef<string | null>(null);

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

  const clearStoredSession = useCallback(() => {
    localStorage.removeItem('catan_game_id');
    localStorage.removeItem('catan_room_code');
    localStorage.removeItem('catan_session_token');
  }, []);

  const refreshProfile = useCallback(async () => {
    const token = localStorage.getItem('catan_token');
    if (!token) return;

    try {
      const res = await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data?.id) setAuthUser(data);
    } catch {
      // Keep existing profile snapshot if refresh fails.
    }
  }, []);

  const refreshMatchHistory = useCallback(async (page = 1, append = false) => {
    const token = localStorage.getItem('catan_token');
    if (!token) return;

    try {
      const res = await fetch(`${API}/api/matches?page=${page}&pageSize=8`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json() as MatchHistoryResponse;
      if (Array.isArray(data.items)) {
        setMatchHistory((current) => append ? [...current, ...data.items] : data.items);
        setMatchHistoryPage(data.page);
        setHasMoreMatchHistory(data.hasMore);
      }
    } catch {
      // Keep last loaded history snapshot if refresh fails.
    }
  }, []);

  const resetActiveSession = useCallback(() => {
    clearStoredSession();
    setCurrentGameId(null);
    setRoomCode('');
    setGameState(null);
    setBoardState({ hexes: [], ports: [] });
    setPlayerPresence({});
    setBotThinking(null);
    setBuildMode(null);
    setSelectedShipEdge(null);
    setShowBankTrade(false);
    setShowP2PTrade(false);
    setShowDevCards(false);
    setPendingRobberHex(null);
    setStealTargets([]);
    setDevCardAction(null);
    setPendingAction(null);
    setPendingEvent(null);
    pendingEventRef.current = null;
    prevPlayersRef.current = null;
    latestDiceResultRef.current = null;
  }, [clearStoredSession]);

  const emit = useCallback((event: string, payload: any = {}) => {
    if (!socket) return;
    if (pendingEventRef.current) return;
    const actionLabel = ACTION_LABELS[event];
    if (actionLabel) {
      const seq = ++pendingActionSeqRef.current;
      setPendingAction(actionLabel);
      pendingEventRef.current = event;
      setPendingEvent(event);
      window.setTimeout(() => {
        if (pendingActionSeqRef.current === seq) setPendingAction(null);
        if (pendingEventRef.current === event) {
          pendingEventRef.current = null;
          setPendingEvent(null);
        }
      }, 2200);
    }
    socket.emit(event, { ...payload, gameId: currentGameId, userId, username: authUser?.username });
  }, [socket, currentGameId, userId, authUser]);

  useEffect(() => {
    currentGameIdRef.current = currentGameId;
  }, [currentGameId]);

  useEffect(() => {
    localStorage.setItem('catan_motion_mode', motionMode);
  }, [motionMode]);

  // ── Check stored token on mount ──
  useEffect(() => {
    const token = localStorage.getItem('catan_token');
    if (token) {
      fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
          if (data.id) {
            setAuthUser(data);
            refreshMatchHistory(1, false);
            const savedGameId = localStorage.getItem('catan_game_id');
            const savedRoomCode = localStorage.getItem('catan_room_code');
            if (savedGameId) {
              setCurrentGameId(savedGameId);
              if (savedRoomCode) setRoomCode(savedRoomCode);
              setIsRejoining(true);
              setView('GAME');
            } else {
              setView('MATCHMAKING');
            }
          } else {
            setIsRejoining(false);
          }
        })
        .catch(() => { setIsRejoining(false); })
        .finally(() => setAuthRestoring(false));
    } else {
      setIsRejoining(false);
      setAuthRestoring(false);
    }
  }, [refreshMatchHistory]);

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
        refreshMatchHistory(1, false);
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
    const s = io(API, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    setSocket(s);

    const clearRejoinTimeout = () => {
      if (rejoinTimeoutRef.current) {
        window.clearTimeout(rejoinTimeoutRef.current);
        rejoinTimeoutRef.current = null;
      }
    };

    s.on('connect', () => {
      setIsConnected(true);
      clearRejoinTimeout();
      const savedGameId = localStorage.getItem('catan_game_id');
      const savedSessionToken = localStorage.getItem('catan_session_token');
      if (savedGameId) {
        setIsRejoining(true);
        s.emit('rejoin_game', { userId: authUser.id, gameId: savedGameId, sessionToken: savedSessionToken });
        rejoinTimeoutRef.current = window.setTimeout(() => setIsRejoining(false), 6000);
      } else {
        s.emit('fetch_lobbies');
      }
    });
    s.on('disconnect', () => {
      setIsConnected(false);
      if (localStorage.getItem('catan_game_id')) {
        setIsRejoining(true);
      }
    });
    s.on('game_joined', (data: { gameId: string; roomCode: string; status?: GameStatus; sessionToken?: string }) => {
      clearRejoinTimeout();
      setIsRejoining(false);
      setPendingAction(null);
      setPendingEvent(null);
      pendingEventRef.current = null;
      setCurrentGameId(data.gameId);
      setRoomCode(data.roomCode);
      localStorage.setItem('catan_game_id', data.gameId);
      localStorage.setItem('catan_room_code', data.roomCode);
      if (data.sessionToken) localStorage.setItem('catan_session_token', data.sessionToken);
      setView(getViewForStatus(data.status));
    });
    s.on('lobbies_update', (l: any[]) => setLobbies(l));
    s.on('presence_update', (presence: PlayerPresenceState) => setPlayerPresence(presence));
    s.on('game_event', (event: GameEvent) => {
      if (event?.eventId && event.eventId !== lastShownEventId.current) {
        lastShownEventId.current = event.eventId;
        setDevCardEvent(event);
      }
    });
    s.on('rematch_ready', (data: { gameId: string; roomCode: string; requestedBy: string }) => {
      if (data.requestedBy === authUser.id) return;
      setCurrentGameId(data.gameId);
      setRoomCode(data.roomCode);
      s.emit('join_game', { gameId: data.gameId, userId: authUser.id, username: authUser.username });
    });
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
      setPendingAction(null);
      setPendingEvent(null);
      pendingEventRef.current = null;
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
          if (flies.length >= 8) break;
          const myRes = st.players[pid]?.resources;
          const oldRes = prevP[pid]?.resources;
          if (myRes && oldRes) {
            for (const r of ['wood','brick','sheep','wheat','ore'] as ResourceType[]) {
              const diff = myRes[r] - (oldRes[r] || 0);
              if (diff !== 0) {
                flies.push({ id: flyIdRef.current++, pid, res: r, amount: Math.min(Math.abs(diff), 2), isGain: diff > 0 });
                if (flies.length >= 8) break;
              }
            }
          }
        }
        
        if (flies.length > 0) {
          // If a dice roll just happened, wait for the animation to finish (~2s)
          const delay = motionMode === 'cinematic' && st.diceResult && (!prevP || !prevP[authUser.id]) && st.diceResult !== latestDiceResultRef.current ? 1200 : 0;
          
          setTimeout(() => {
            setGlobalFlies(f => [...f, ...flies]);
            setTimeout(() => {
              setGlobalFlies(f => f.filter(x => !flies.some(y => y.id === x.id)));
            }, motionMode === 'fast' ? 900 : 1800);
          }, delay);
        }
      }
      
      // Save deep copy of all players for accurate deltas
      prevPlayersRef.current = st.players;
      latestDiceResultRef.current = st.diceResult;

      if (st.status === 'IN_PROGRESS' || st.status === 'FINISHED') {
        setView('GAME');
      } else if (st.status === 'LOBBY' && localStorage.getItem('catan_game_id')) {
        setView('LOBBY');
      }
      clearRejoinTimeout();
      setIsRejoining(false);

      // Dev card / steal event overlay
      if (st.lastEvent && st.lastEvent.eventId !== lastShownEventId.current) {
        lastShownEventId.current = st.lastEvent.eventId;
        setDevCardEvent(st.lastEvent);
      }


      // If finished game session, clear it from storage
      if (st.status === 'FINISHED') {
        clearStoredSession();
        refreshProfile();
        refreshMatchHistory(1, false);
      }
    });
    s.on('bot_thinking', (d: { userId: string }) => {
      setBotThinking(d.userId);
    });
    s.on('game_started', () => {
      clearRejoinTimeout();
      setIsRejoining(false);
      setGameStarted(true);
      setView('GAME');
    });
    s.on('action_error', (msg: string) => { 
      clearRejoinTimeout();
      setIsRejoining(false);
      setPendingAction(null);
      setPendingEvent(null);
      pendingEventRef.current = null;
      if (msg.toLowerCase().includes('not found')) {
        resetActiveSession();
        setView('MATCHMAKING');
      }
      setErrorMsg(msg); 
      setTimeout(() => setErrorMsg(null), 3000); 
    });
    return () => {
      clearRejoinTimeout();
      s.close();
    };
  }, [authUser, clearStoredSession, motionMode, refreshMatchHistory, refreshProfile, resetActiveSession]);

  useEffect(() => {
    if (socket && isConnected && view === 'MATCHMAKING') {
      socket.emit('fetch_lobbies');
    }
  }, [socket, isConnected, view]);

  // ── Derived ──
  const gs = gameState;
  const me = gs?.players[userId] ?? null;
  const isMyTurn = gs ? gs.playerOrder[gs.currentTurnIndex] === userId : false;
  const curPid = gs?.playerOrder[gs?.currentTurnIndex] ?? null;
  const isSetup = gs?.phase === 'SETUP_R1' || gs?.phase === 'SETUP_R2';
  const isMySetupTurn = isSetup && gs?.setupInfo?.currentPlayer === userId;
  const mustDiscard = gs?.playersWhoMustDiscard?.includes(userId) ?? false;
  const pIdx = (pid: string) => (gs?.playerOrder.indexOf(pid) ?? -1) + 1;
  const myValidMoves = gs?.validMoves?.[userId] ?? { settlements: [], roads: [], ships: [], movableShips: [], cities: [], robberHexes: [] };
  const isSeafarers = gs?.expansion === 'seafarers';
  const pendingGoldCount = gs?.pendingGoldChoices?.[userId] ?? 0;
  const isActionPending = Boolean(pendingEvent);
  const tradeAdvisor = me ? (() => {
    const offering = resourceTotal(p2pOffer);
    const requesting = resourceTotal(p2pRequest);
    if (offering === 0 || requesting === 0) return { tone: 'neutral', text: 'Build a trade by selecting resources on both sides.' };
    const gain = scoreTrade(me.resources, p2pRequest, p2pOffer);
    const rawBalance = requesting - offering;
    if (gain >= 8 && rawBalance >= -1) return { tone: 'good', text: 'Strong trade: it completes or nearly completes an important build.' };
    if (rawBalance < -1 && gain < 8) return { tone: 'bad', text: 'Risky trade: you give too much without a clear build payoff.' };
    if (gain > 0) return { tone: 'neutral', text: 'Playable trade: it improves your next build path.' };
    return { tone: 'bad', text: 'Weak trade: it does not clearly improve your current plan.' };
  })() : { tone: 'neutral', text: '' };

  const totalVP = () => {
    if (!me || !gs) return 0;
    let vp = me.score;
    if (gs.longestRoadHolder === userId) vp += 2;
    if (gs.largestArmyHolder === userId) vp += 2;
    vp += (me.devCards?.filter(c => c.type === 'victoryPoint').length ?? 0);
    return vp;
  };

  // ── Handlers ──
  const handleVertexClick = useCallback((vid: string) => {
    if (isActionPending) return;
    if (isSetup && isMySetupTurn && gs?.setupInfo?.expectedAction === 'settlement') {
      if (myValidMoves.settlements.includes(vid)) emit('place_settlement', { vertexId: vid });
      return;
    }
    if (buildMode === 'settlement') {
      if (myValidMoves.settlements.includes(vid)) { emit('place_settlement', { vertexId: vid }); setBuildMode(null); }
    } else if (buildMode === 'city') {
      if (myValidMoves.cities.includes(vid)) { emit('upgrade_city', { vertexId: vid }); setBuildMode(null); }
    }
  }, [buildMode, emit, gs, isActionPending, isMySetupTurn, isSetup, myValidMoves]);

  const handleEdgeClick = useCallback((eid: string) => {
    if (isActionPending) return;
    if (isSetup && isMySetupTurn && gs?.setupInfo?.expectedAction === 'road') {
      if (myValidMoves.ships.includes(eid)) emit('place_ship', { edgeId: eid });
      else if (myValidMoves.roads.includes(eid)) emit('place_road', { edgeId: eid });
      return;
    }
    if (buildMode === 'ship') {
      if (myValidMoves.ships.includes(eid)) { emit('place_ship', { edgeId: eid }); setBuildMode(null); }
      return;
    }
    if (buildMode === 'moveShip') {
      if (!selectedShipEdge && myValidMoves.movableShips.includes(eid)) {
        setSelectedShipEdge(eid);
        return;
      }
      if (selectedShipEdge && myValidMoves.ships.includes(eid)) {
        emit('move_ship', { fromEdgeId: selectedShipEdge, toEdgeId: eid });
        setSelectedShipEdge(null);
        setBuildMode(null);
      }
      return;
    }
    if (buildMode === 'road' || (gs?.roadBuildingRemaining ?? 0) > 0) {
      if (myValidMoves.roads.includes(eid)) {
        emit('place_road', { edgeId: eid });
        if (buildMode === 'road') setBuildMode(null);
      } else if ((gs?.roadBuildingRemaining ?? 0) > 0 && myValidMoves.ships.includes(eid)) {
        emit('place_ship', { edgeId: eid });
      }
    }
  }, [buildMode, emit, gs, isActionPending, isMySetupTurn, isSetup, myValidMoves, selectedShipEdge]);

  const handleHexClick = useCallback((hc: string) => {
    if (gs?.turnPhase === 'ROBBER_MOVE' && isMyTurn && !isActionPending && myValidMoves.robberHexes.includes(hc)) {
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
      const targetHex = boardState.hexes.find(hex => `${hex.q},${hex.r}` === hc);
      if (targetHex?.type === 'sea') {
        for (let i = 0; i < 6; i++) {
          const eid = [hexVerts[i], hexVerts[(i + 1) % 6]].sort().join(':');
          const owner = gs?.ships?.[eid];
          if (owner && owner !== userId) targets.add(owner);
        }
      } else {
        hexVerts.forEach(v => {
          const bld = gs?.buildings[v];
          if (bld && bld.owner !== userId) targets.add(bld.owner);
        });
      }
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
  }, [boardState.hexes, emit, gs, isActionPending, isMyTurn, myValidMoves, userId]);

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
    resetActiveSession();
    setMatchHistory([]);
    setMatchHistoryPage(1);
    setHasMoreMatchHistory(false);
    setAuthUser(null);
    setView('AUTH');
    socket?.close();
    setSocket(null);
  };

  // ═══════════════════════════════════════════════════════════
  //  AUTH VIEW
  // ═══════════════════════════════════════════════════════════

  if (authRestoring) {
    return (
      <div className="game-container">
        <motion.div className="glass-panel app-loading-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <div className="golden-spinner"></div>
          <h1>Restoring your session</h1>
          <p>Checking your account and reconnecting to the latest table.</p>
        </motion.div>
      </div>
    );
  }

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

          <div className="mode-create-grid">
            <button className="btn-action btn-lg" onClick={() => socket?.emit('create_lobby', { userId, username: authUser.username, expansion: 'base' })}>
              ➕ Classic Catan
            </button>
            <button className="btn-action btn-lg seafarers-create" onClick={() => socket?.emit('create_lobby', { userId, username: authUser.username, expansion: 'seafarers' })}>
              ⛵ Seafarers
            </button>
          </div>

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
                <span style={{ fontSize: '0.85rem' }}>
                  {l.boardState?.expansion === 'seafarers' || l.gameState?.expansion === 'seafarers' ? '⛵' : '🏰'} {l.roomCode || l.id.substring(0, 8)}
                </span>
                <button className="btn-action" onClick={() => {
                  setCurrentGameId(l.id); setView('LOBBY');
                  socket?.emit('join_game', { gameId: l.id, userId, username: authUser.username });
                }}>Join</button>
              </div>
            ))}
          </div>

          <h3 style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '6px', fontSize: '0.8rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px', marginTop: '1.5rem' }}>
            Recent Matches
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px', maxHeight: '260px', overflowY: 'auto' }}>
            {matchHistory.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>No finished matches yet.</p>}
            {matchHistory.map(match => (
              <div key={match.gameId} style={{ background: 'rgba(0,0,0,0.25)', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)', textAlign: 'left' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, color: match.didWin ? '#86efac' : '#fca5a5' }}>
                    {match.didWin ? 'Win' : 'Loss'}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                    {new Date(match.finishedAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ marginTop: '4px', fontSize: '0.85rem' }}>
                  Winner: <span style={{ fontWeight: 700, color: match.winner?.color || 'var(--accent)' }}>{match.winner?.username || 'Unknown'}</span>
                </div>
                <div style={{ marginTop: '2px', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  Room {match.roomCode} • You finished with {match.finalVp} VP
                </div>
              </div>
            ))}
          </div>
          {hasMoreMatchHistory && (
            <button
              className="btn-action btn-ghost"
              style={{ width: '100%', marginTop: '10px' }}
              onClick={() => refreshMatchHistory(matchHistoryPage + 1, true)}
            >
              Load More Matches
            </button>
          )}
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
          <div className="lobby-expansion-chip">
            {gs?.expansion === 'seafarers' ? '⛵ Seafarers: New Shores' : '🏰 Classic Catan'}
          </div>
          
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
                          {!gs?.players[pid]?.isBot && playerPresence[pid] && !playerPresence[pid].connected ? ' • Offline, session reserved' : ''}
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
            onClick={() => { resetActiveSession(); setView('MATCHMAKING'); }}>← Back to Rooms</button>
        </motion.div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  GAME VIEW
  // ═══════════════════════════════════════════════════════════

  const expectedAction = gs?.setupInfo?.expectedAction;
  const currentPlayer = curPid && gs ? gs.players[curPid] : null;
  const winnerPlayer = gs?.winner ? gs.players[gs.winner] : null;
  const scoreForPlayer = (pid: string) => {
    if (!gs) return 0;
    const player = gs.players[pid];
    if (!player) return 0;
    let score = player.score;
    if (gs.longestRoadHolder === pid) score += 2;
    if (gs.largestArmyHolder === pid) score += 2;
    score += player.devCards?.filter(card => card.type === 'victoryPoint').length ?? 0;
    return score;
  };
  const sortedStandings = gs
    ? [...gs.playerOrder].sort((a, b) => scoreForPlayer(b) - scoreForPlayer(a))
    : [];

  const commandTitle = (() => {
    if (!gs) return 'Loading Match';
    if (gs.phase === 'GAME_OVER') return 'Match Complete';
    if (isSetup) return isMySetupTurn ? `Place ${expectedAction}` : `${currentPlayer?.username || 'Player'} is setting up`;
    if (!isMyTurn) return `${currentPlayer?.username || 'Player'} is thinking`;
    if (gs.turnPhase === 'MUST_ROLL') return 'Roll to begin your turn';
    if (gs.turnPhase === 'ROBBER_DISCARD') return mustDiscard ? 'Discard half your hand' : 'Waiting for discards';
    if (gs.turnPhase === 'ROBBER_MOVE') return 'Move the robber';
    if (gs.turnPhase === 'GOLD_CHOICE') return pendingGoldCount > 0 ? 'Choose gold field resources' : 'Waiting for gold choices';
    return 'Build, trade, or end turn';
  })();

  const commandSubtitle = (() => {
    if (!gs) return 'Restoring board state.';
    if (gs.phase === 'GAME_OVER') return `${winnerPlayer?.username || 'A player'} won the island.`;
    if (isSetup) return isMySetupTurn ? 'The board is highlighted for your next setup action.' : 'Setup uses snake order before the main game starts.';
    if (!isMyTurn) return botThinking ? 'Bot action is being resolved.' : 'Watch the board and timeline for updates.';
    if (gs.turnPhase === 'MUST_ROLL') return 'Dice decide production. Rolling a 7 activates the robber.';
    if (gs.turnPhase === 'ROBBER_DISCARD') return mustDiscard ? 'Choose exactly the required number of cards.' : 'Other players must discard before robber movement.';
    if (gs.turnPhase === 'ROBBER_MOVE') return 'Choose a new hex, then steal from an adjacent opponent if possible.';
    if (gs.turnPhase === 'GOLD_CHOICE') return pendingGoldCount > 0 ? `Choose ${pendingGoldCount} resource${pendingGoldCount > 1 ? 's' : ''} from your gold field production.` : 'Other players are choosing gold field resources.';
    return buildMode ? `Placement mode active: ${buildMode}. Click a valid board spot.` : 'Use the action deck below for your strongest move.';
  })();

  const renderTimelineIcon = (msg: string) => {
    if (msg.includes('rolled')) return '🎲';
    if (msg.includes('robber') || msg.includes('Robber') || msg.includes('stole')) return '🏴‍☠️';
    if (msg.includes('trade') || msg.includes('Trade')) return '🤝';
    if (msg.includes('road') || msg.includes('Road')) return '🛤️';
    if (msg.includes('settlement')) return '🏠';
    if (msg.includes('city')) return '🏰';
    if (msg.includes('card') || msg.includes('Knight') || msg.includes('Monopoly')) return '🃏';
    if (msg.includes('WINS')) return '🏆';
    return '•';
  };

  return (
    <div className={`game-layout ${isFullscreen ? 'fullscreen-mode' : ''}`} ref={gameLayoutRef} onClick={startMusic}>
      {/* DICE ROLL ANIMATION */}
      <AnimatePresence>
        {showDiceAnim && (
          <DiceAnimation d1={animDice.d1} d2={animDice.d2} total={animDice.total}
            motionMode={motionMode}
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

      <AnimatePresence>
        {pendingAction && (
          <motion.div className="action-pending-pill" initial={{ y: -18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -18, opacity: 0 }}>
            <span className="pending-dot" />
            {pendingAction}
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
            transition={{ duration: 1.05, ease: 'easeOut' }}
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
            <div className="victory-kicker">Final Settlement Ledger</div>
            <h1>🏆 {gs.winner === userId ? 'You conquered Catan' : `${winnerPlayer?.username || 'Player'} Wins`}</h1>
            <p className="victory-subtitle">
              {winnerPlayer?.username || 'The winner'} controlled the island with {scoreForPlayer(gs.winner)} victory points.
            </p>
            <div className="victory-standings">
              {sortedStandings.map((pid, index) => {
                const player = gs.players[pid];
                const vp = scoreForPlayer(pid);
                return (
                  <div key={pid} className={`victory-row ${pid === gs.winner ? 'winner' : ''}`}>
                    <span className="victory-rank">#{index + 1}</span>
                    <span className="victory-dot" style={{ backgroundColor: player.color }} />
                    <span className="victory-name">{player.username}</span>
                    <span className="victory-badges">
                      {gs.longestRoadHolder === pid ? '🛤️' : ''}
                      {gs.largestArmyHolder === pid ? '⚔️' : ''}
                    </span>
                    <span className="victory-vp">{vp} VP</span>
                  </div>
                );
              })}
            </div>
            <div className="victory-actions">
              <button className="btn-action btn-lg" onClick={() => emit('create_rematch')}>
                Rematch
              </button>
              <button className="btn-action btn-lg btn-ghost" onClick={() => {
                resetActiveSession();
                setView('MATCHMAKING');
              }}>Back to Lobby</button>
            </div>
          </motion.div>
        </div>
      )}

      {/* TOP BAR */}
      <div className="game-top-bar">
        <div className="topbar-left">
          <button className="btn-action btn-ghost topbar-leave"
            onClick={() => { resetActiveSession(); setView('MATCHMAKING'); }}>← Leave</button>
          <div className="match-chip">
            <span className="match-chip-label">{isSetup ? `Setup ${gs?.phase === 'SETUP_R1' ? 'Round 1' : 'Round 2'}` : gs?.phase === 'GAME_OVER' ? 'Complete' : 'Live Match'}</span>
            <span className="match-chip-user">{authUser.username}</span>
          </div>
          {!isConnected && (
            <span className="connection-warning">Reconnecting... session preserved</span>
          )}
        </div>
        <div className="scoreboard">
          {gs?.playerOrder.map((pid, i) => {
            const hasRoad = gs.longestRoadHolder === pid;
            const hasArmy = gs.largestArmyHolder === pid;
            const player = gs.players[pid];
            const totalCards = Object.values(player.resources).reduce((a: number, b: number) => a + b, 0);
            const hiddenVp = player.devCards?.filter(card => card.type === 'victoryPoint').length ?? 0;
            const visibleVp = player.score
              + (hasRoad ? 2 : 0)
              + (hasArmy ? 2 : 0)
              + hiddenVp;
            return (
              <div key={pid} style={{ position: 'relative' }}>
                <div className={`score-card ${pid === curPid ? 'active-player' : ''} ${pid === userId ? 'self' : ''}`}
                  style={{ borderColor: player.color }}>
                  <div className="score-color" style={{ backgroundColor: player.color }} />
                  <div className="score-main">
                    <div className="score-name-row">
                      <span className="score-name">{player.username || `P${i + 1}`}</span>
                      {pid === userId && <span className="score-you">You</span>}
                      {!player.isBot && playerPresence[pid] && !playerPresence[pid].connected && (
                        <span className="score-offline">offline</span>
                      )}
                    </div>
                    <div className="score-meta">
                      <span>{totalCards} resources</span>
                      <span>{player.devCards?.length ?? 0} dev</span>
                    </div>
                  </div>
                  <div className="score-vp">{visibleVp}<span>VP</span></div>
                  <div className="score-badges">
                    {hasRoad && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} title="Longest Road">🛤️</motion.span>}
                    {hasArmy && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} title="Largest Army">⚔️</motion.span>}
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
                            transition={{ type: 'spring', bounce: 0.28, duration: 0.55 }}
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
        <div className="topbar-right">
          <button className="topbar-tool" onClick={() => setShowLogDrawer(true)}>Log</button>
          <button className="topbar-tool" onClick={() => setMotionMode(mode => mode === 'fast' ? 'cinematic' : 'fast')}>
            {motionMode === 'fast' ? 'Fast' : 'Cinematic'}
          </button>
          <button className="btn-fullscreen" onClick={() => toggleFullscreen()}
            title="Toggle fullscreen (F)">⛶ {isFullscreen ? 'Exit' : 'Full'}</button>
          <div className={`live-pill ${isConnected ? 'connected' : 'disconnected'}`}>
            <span />
            {isConnected ? 'Live' : 'Offline'}
          </div>
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
            robberHex={gs?.robberHex ?? null} pirateHex={gs?.pirateHex ?? null} buildMode={buildMode}
            setupHighlight={isMySetupTurn ? expectedAction ?? null : null}
            validMoves={myValidMoves}
            currentPlayerColor={gs?.players[userId]?.color} />
        ) : <div style={{ color: 'var(--text-dim)' }}>Loading board...</div>}

        {buildMode && (
          <div className="build-mode-coach">
            <div>
              <strong>{buildMode === 'road' ? 'Road placement' : buildMode === 'city' ? 'City upgrade' : 'Settlement placement'}</strong>
              <span>{buildMode === 'road' ? 'Extend from your network. Opponent buildings block paths.' : buildMode === 'city' ? 'Select one of your settlements.' : 'Select a valid connected intersection.'}</span>
            </div>
            <button onClick={() => setBuildMode(null)}>Cancel</button>
          </div>
        )}

        {gs && gs.log && gs.log.length > 0 && (
          <div className="action-timeline">
            <div className="timeline-header">
              <span>Island Timeline</span>
              <small>latest actions</small>
            </div>
            {gs.log.slice(-7).reverse().map((msg, i) => (
              <div key={`${msg}-${i}`} className={`timeline-entry ${i === 0 ? 'latest' : ''}`}>
                <span className="timeline-icon">{renderTimelineIcon(msg)}</span>
                <span className="timeline-text">{msg}</span>
              </div>
            ))}
          </div>
        )}

        {gs?.phase === 'MAIN_GAME' && isMyTurn && gs.turnPhase === 'FREE_ACTION' && (
          <button className="floating-end-turn" disabled={isActionPending} onClick={() => emit('end_turn')}>
            <span>End Turn</span>
            <small>pass to next player</small>
          </button>
        )}
      </div>

      {/* SIDEBAR */}
      <div className="game-sidebar">
        <div className={`turn-command-center ${isMyTurn || isMySetupTurn ? 'actionable' : 'observing'}`}>
          <div className="command-kicker">
            <span className="command-pulse" />
            {isMyTurn || isMySetupTurn ? 'Your Command' : 'Table State'}
          </div>
          <h2>{commandTitle}</h2>
          <p>{commandSubtitle}</p>
          <div className="command-status-row">
            <span>{isSetup ? 'Setup' : gs?.turnPhase?.replace('_', ' ') || 'Loading'}</span>
            {currentPlayer && <span style={{ color: currentPlayer.color }}>{currentPlayer.username}</span>}
          </div>
          {gs?.phase === 'MAIN_GAME' && isMyTurn && gs.turnPhase === 'MUST_ROLL' && (
            <button className="btn-action btn-lg command-primary" disabled={isActionPending} onClick={() => emit('roll_dice')}>
              🎲 Roll Dice
            </button>
          )}
          {gs?.phase === 'MAIN_GAME' && isMyTurn && gs.turnPhase === 'FREE_ACTION' && (
            <button className="btn-action btn-lg command-primary end-turn" disabled={isActionPending} onClick={() => emit('end_turn')}>
              End Turn
            </button>
          )}
          {botThinking && <div className="bot-thinking-chip">Bot is calculating the next move...</div>}
        </div>

        {/* Phase Banner */}
        {isSetup && (
          <div className={`phase-banner ${isMySetupTurn ? 'your-turn' : 'waiting'} ${botThinking ? 'pulsing' : ''}`}>
            {isMySetupTurn ? (
              <><span style={{ fontSize: '1.2rem' }}>{expectedAction === 'settlement' ? '🏠' : isSeafarers ? '⛵' : '🛤️'}</span>
              <span>Place your {expectedAction === 'road' && isSeafarers ? 'route' : expectedAction}</span></>
            ) : (
              <span>{botThinking ? '🤖 Bot is thinking...' : `⏳ P${pIdx(gs?.setupInfo?.currentPlayer ?? '')} is placing`}</span>
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

        {pendingGoldCount > 0 && (
          <div className="discard-panel gold-choice-panel">
            <h4>🏝️ Choose {pendingGoldCount} gold field resource{pendingGoldCount > 1 ? 's' : ''}</h4>
            <div className="gold-choice-grid">
              {(['wood','brick','sheep','wheat','ore'] as ResourceType[]).map(resource => (
                <button key={resource} className={`resource-card ${resource}`} disabled={isActionPending}
                  onClick={() => emit('choose_gold_resource', { resource })}>
                  <span className="rc-icon">{RES[resource]}</span>
                  <span className="rc-name">{resource}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Build & Trade */}
        {gs?.phase === 'MAIN_GAME' && isMyTurn && gs.turnPhase === 'FREE_ACTION' && (
          <>
            <div className="sidebar-section">
              <h3>Build</h3>
              <div className="build-grid">
                <button className={`build-btn ${buildMode === 'settlement' ? 'active' : ''}`}
                  disabled={isActionPending || myValidMoves.settlements.length === 0}
                  onClick={() => setBuildMode(buildMode === 'settlement' ? null : 'settlement')}>
                  <span className="build-icon">🏠</span><span>Settlement</span><span className="build-cost">🪵🧱🐑🌾</span>
                </button>
                <button className={`build-btn ${buildMode === 'road' ? 'active' : ''}`}
                  disabled={isActionPending || myValidMoves.roads.length === 0}
                  onClick={() => setBuildMode(buildMode === 'road' ? null : 'road')}>
                  <span className="build-icon">🛤️</span><span>Road</span><span className="build-cost">🪵🧱</span>
                </button>
                {isSeafarers && (
                  <button className={`build-btn ${buildMode === 'ship' ? 'active' : ''}`}
                    disabled={isActionPending || myValidMoves.ships.length === 0}
                    onClick={() => { setSelectedShipEdge(null); setBuildMode(buildMode === 'ship' ? null : 'ship'); }}>
                    <span className="build-icon">⛵</span><span>Ship</span><span className="build-cost">🪵🐑</span>
                  </button>
                )}
                <button className={`build-btn ${buildMode === 'city' ? 'active' : ''}`}
                  disabled={isActionPending || myValidMoves.cities.length === 0}
                  onClick={() => setBuildMode(buildMode === 'city' ? null : 'city')}>
                  <span className="build-icon">🏰</span><span>City</span><span className="build-cost">🌾🌾🪨🪨🪨</span>
                </button>
                <button className="build-btn" disabled={isActionPending} onClick={() => emit('buy_dev_card')}>
                  <span className="build-icon">🃏</span><span>Dev Card</span><span className="build-cost">🐑🌾🪨</span>
                </button>
                {isSeafarers && (
                  <button className={`build-btn ${buildMode === 'moveShip' ? 'active' : ''}`}
                    disabled={isActionPending || myValidMoves.movableShips.length === 0}
                    onClick={() => { setSelectedShipEdge(null); setBuildMode(buildMode === 'moveShip' ? null : 'moveShip'); }}>
                    <span className="build-icon">🧭</span><span>Move Ship</span><span className="build-cost">1/turn</span>
                  </button>
                )}
              </div>
              {buildMode && <p style={{ fontSize: '0.75rem', color: 'var(--info)', textAlign: 'center', marginTop: '6px' }}>
                {buildMode === 'moveShip'
                  ? selectedShipEdge ? '← Pick the new valid sea route for that ship' : '← Pick an open end ship to move'
                  : `← Click the board to place your ${buildMode}`}</p>}
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
                    disabled={isActionPending}
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
                  <div className={`trade-advisor ${tradeAdvisor.tone}`}>
                    <strong>Advisor</strong>
                    <span>{tradeAdvisor.text}</span>
                  </div>
                  <button className="btn-action" style={{ width: '100%', marginTop: '6px' }}
                    disabled={isActionPending || resourceTotal(p2pOffer) === 0 || resourceTotal(p2pRequest) === 0}
                    onClick={() => { emit('propose_trade', { offering: p2pOffer, requesting: p2pRequest }); setShowP2PTrade(false); setP2pOffer(ZERO_RES()); setP2pRequest(ZERO_RES()); }}>
                    Propose Trade</button>
                </div>
              )}
            </div>
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
                          disabled={isActionPending} onClick={() => emit('accept_trade')}>✅ Accept Trade</button>
                        <button className="btn-action btn-ghost" style={{ flex: 1 }}
                          disabled={isActionPending} onClick={() => emit('reject_trade')}>Dismiss</button>
                      </>
                    ) : (
                      <button className="btn-action btn-ghost" style={{ width: '100%', border: '1px dashed var(--danger)', color: 'var(--danger)' }}
                        disabled={isActionPending} onClick={() => emit('reject_trade')}>❌ Cancel My Offer</button>
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

      <AnimatePresence>
        {showLogDrawer && (
          <motion.div className="log-drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setShowLogDrawer(false)}>
            <motion.div className="log-drawer" initial={{ x: 340 }} animate={{ x: 0 }} exit={{ x: 340 }}
              onClick={(event) => event.stopPropagation()}>
              <div className="log-drawer-header">
                <div>
                  <span>Island Log</span>
                  <small>{gs?.log?.length ?? 0} recorded actions</small>
                </div>
                <button onClick={() => setShowLogDrawer(false)}>Close</button>
              </div>
              <div className="log-drawer-list">
                {(gs?.log ?? []).slice().reverse().map((msg, index) => (
                  <div key={`${msg}-${index}`} className="log-drawer-entry">
                    <span>{renderTimelineIcon(msg)}</span>
                    <p>{msg}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;

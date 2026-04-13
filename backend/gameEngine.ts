import { HexagonState, Port, PortType } from './boardGenerator';

// ═══════════════════════════════════════════════════════════
//  TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════

export type ResourceType = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore';
export type Resources = Record<ResourceType, number>;

export type GamePhase = 'SETUP_R1' | 'SETUP_R2' | 'MAIN_GAME' | 'GAME_OVER';
export type TurnPhase = 'MUST_ROLL' | 'ROBBER_DISCARD' | 'ROBBER_MOVE' | 'FREE_ACTION';

export type DevCardType = 'knight' | 'victoryPoint' | 'yearOfPlenty' | 'monopoly' | 'roadBuilding';

export interface DevCard {
  type: DevCardType;
  boughtThisTurn: boolean;
}

export interface Player {
  id: string;
  username: string;
  color: string;
  resources: Resources;
  score: number;
  devCards: DevCard[];
  knightsPlayed: number;
  hasPlayedDevCardThisTurn: boolean;
  isBot: boolean;
}

export interface TradeOffer {
  fromPlayer: string;
  offering: Partial<Resources>;
  requesting: Partial<Resources>;
  rejectedBy: string[];
}

export interface GameEvent {
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

export interface GameAuditEntry {
  id: string;
  at: string;
  type: string;
  playerId: string | null;
  turn: number;
  phase: GamePhase;
  details?: Record<string, unknown>;
}

export interface GameSnapshot {
  snapshotVersion: number;
  phase: GamePhase;
  turnPhase: TurnPhase;
  setupTurnIndex: number;
  players: Record<string, Player>;
  playerOrder: string[];
  currentTurnIndex: number;
  diceResult: number | null;
  dice1: number;
  dice2: number;
  rollCount: number;
  lastDiceYields: Record<string, ResourceType[]>;
  buildings: Record<string, Building>;
  roads: Record<string, string>;
  robberHex: string;
  playersWhoMustDiscard: string[];
  devCardDeck: DevCardType[];
  longestRoadHolder: string | null;
  longestRoadLength: number;
  largestArmyHolder: string | null;
  largestArmySize: number;
  activeTradeOffer: TradeOffer | null;
  log: string[];
  winner: string | null;
  roadBuildingRemaining: number;
  lastEvent: GameEvent | null;
  setupSettlements: { playerId: string; vertexId: string }[];
  startedAt: string | null;
  finishedAt: string | null;
  actionJournal: GameAuditEntry[];
}

export type BuildingType = 'settlement' | 'city';

export interface Building {
  owner: string;
  type: BuildingType;
}

// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════

const PIECE_LIMITS = { settlement: 5, city: 4, road: 15 };

const BUILD_COSTS: Record<string, Resources> = {
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
  city:       { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 },
  road:       { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
  devCard:    { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 },
};

const INITIAL_DEV_DECK: DevCardType[] = [
  ...Array(14).fill('knight'),
  ...Array(5).fill('victoryPoint'),
  ...Array(2).fill('yearOfPlenty'),
  ...Array(2).fill('monopoly'),
  ...Array(2).fill('roadBuilding'),
];

const RESOURCE_FROM_HEX: Record<string, ResourceType | null> = {
  forest: 'wood', hill: 'brick', pasture: 'sheep', field: 'wheat', mountain: 'ore', desert: null,
};

// ═══════════════════════════════════════════════════════════
//  GEOMETRY — Shared between Server & Frontend
// ═══════════════════════════════════════════════════════════

const HEX_WIDTH = 200;
const SIZE = 115.47;
const GAME_SNAPSHOT_VERSION = 2;

const getPixelPos = (q: number, r: number) => ({
  x: HEX_WIDTH * (q + r / 2),
  y: SIZE * 1.5 * r,
});

const getVerticesForHex = (cx: number, cy: number): string[] => {
  const verts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle_rad = Math.PI / 180 * (30 + 60 * i);
    verts.push(`${Math.round(cx + SIZE * Math.cos(angle_rad))},${Math.round(cy + SIZE * Math.sin(angle_rad))}`);
  }
  return verts;
};

export { getPixelPos, getVerticesForHex, GAME_SNAPSHOT_VERSION };

// ═══════════════════════════════════════════════════════════
//  HELPER: Shuffle array in-place (Fisher-Yates)
// ═══════════════════════════════════════════════════════════

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════
//  GAME ENGINE
// ═══════════════════════════════════════════════════════════

export class GameEngine {
  // Phase tracking
  phase: GamePhase = 'SETUP_R1';
  turnPhase: TurnPhase = 'FREE_ACTION'; // Setup doesn't need dice roll
  setupTurnIndex: number = 0; // Tracks position in snake order

  // Players
  players: Record<string, Player> = {};
  playerOrder: string[] = [];
  currentTurnIndex: number = 0;

  // Dice
  diceResult: number | null = null;
  dice1: number = 0;
  dice2: number = 0;
  rollCount: number = 0;
  lastDiceYields: Record<string, ResourceType[]> = {};

  // Board pieces
  buildings: Record<string, Building> = {};  // vertexId → Building
  roads: Record<string, string> = {};        // edgeId → userId

  // Robber
  robberHex: string = '0,0'; // q,r of hex with robber (starts on desert)
  playersWhoMustDiscard: string[] = [];

  // Development cards
  devCardDeck: DevCardType[] = [];

  // Longest Road & Largest Army tracking
  longestRoadHolder: string | null = null;
  longestRoadLength: number = 0;
  largestArmyHolder: string | null = null;
  largestArmySize: number = 0;

  // Trade
  activeTradeOffer: TradeOffer | null = null;

  // Board reference
  board: HexagonState[] = [];
  ports: Port[] = [];
  adjacencyMap: Record<string, string[]> = {}; // Vertex ID -> Array of Neighbor Vertex IDs
  interiorVertices: Set<string> = new Set(); // Vertices that touch 3+ hexes (valid for setup)
  
  // Track order of setup placements to ensure resources are given correctly
  setupSettlements: { playerId: string, vertexId: string }[] = [];

  // Game log
  log: string[] = [];

  // Winner
  winner: string | null = null;

  // Road building dev card state
  roadBuildingRemaining: number = 0;

  // Domain metadata
  startedAt: string | null = null;
  finishedAt: string | null = null;

  // Server-side audit trail
  actionJournal: GameAuditEntry[] = [];

  // Last game event (dev card play, steal) — emitted once then cleared
  lastEvent: GameEvent | null = null;
  private _lastEventId: number = 0;
  private _mkEventId(): string { return `${Date.now()}-${++this._lastEventId}`; }

  // ─────────────────────────────────────────
  //  INIT & HYDRATION
  // ─────────────────────────────────────────

  setBoard(board: HexagonState[], ports: Port[] = []) {
    this.board = board;
    this.ports = ports;
    
    // Build adjacency map + count how many hexes each vertex touches
    this.adjacencyMap = {};
    const vertexHexCount: Record<string, number> = {};
    board.forEach(hex => {
      const { x, y } = getPixelPos(hex.q, hex.r);
      const verts = getVerticesForHex(x, y);
      for (let i = 0; i < 6; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % 6];
        if (!this.adjacencyMap[v1]) this.adjacencyMap[v1] = [];
        if (!this.adjacencyMap[v2]) this.adjacencyMap[v2] = [];
        if (!this.adjacencyMap[v1].includes(v2)) this.adjacencyMap[v1].push(v2);
        if (!this.adjacencyMap[v2].includes(v1)) this.adjacencyMap[v2].push(v1);
        vertexHexCount[v1] = (vertexHexCount[v1] || 0);
        vertexHexCount[v2] = (vertexHexCount[v2] || 0);
      }
      // Count each vertex of this hex
      verts.forEach(v => { vertexHexCount[v] = (vertexHexCount[v] || 0) + 1; });
    });

    // Interior vertices = those touching 3 hexes (classic Catan rule)
    this.interiorVertices = new Set();
    for (const [vid, count] of Object.entries(vertexHexCount)) {
      if (count >= 3) this.interiorVertices.add(vid);
    }

    // Place robber on desert
    const desert = board.find(h => h.type === 'desert');
    if (desert) this.robberHex = `${desert.q},${desert.r}`;

    // Init dev deck
    this.devCardDeck = shuffle([...INITIAL_DEV_DECK]);
  }

  private makeAuditId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private recordAction(type: string, playerId: string | null, details?: Record<string, unknown>) {
    this.actionJournal.push({
      id: this.makeAuditId(),
      at: new Date().toISOString(),
      type,
      playerId,
      turn: this.currentTurnIndex,
      phase: this.phase,
      details,
    });
    if (this.actionJournal.length > 250) this.actionJournal.shift();
  }

  private isResourceBag(value: any): value is Resources {
    return value
      && typeof value === 'object'
      && ['wood', 'brick', 'sheep', 'wheat', 'ore'].every((key) => typeof value[key] === 'number');
  }

  private normalizePlayer(raw: any, playerId: string, color: string): Player {
    return {
      id: typeof raw?.id === 'string' ? raw.id : playerId,
      username: typeof raw?.username === 'string' ? raw.username : `Player ${this.playerOrder.length + 1}`,
      color: typeof raw?.color === 'string' ? raw.color : color,
      resources: this.isResourceBag(raw?.resources) ? raw.resources : { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
      score: typeof raw?.score === 'number' ? raw.score : 0,
      devCards: Array.isArray(raw?.devCards)
        ? raw.devCards.filter((card: any) => typeof card?.type === 'string').map((card: any) => ({
            type: card.type as DevCardType,
            boughtThisTurn: Boolean(card.boughtThisTurn),
          }))
        : [],
      knightsPlayed: typeof raw?.knightsPlayed === 'number' ? raw.knightsPlayed : 0,
      hasPlayedDevCardThisTurn: Boolean(raw?.hasPlayedDevCardThisTurn),
      isBot: Boolean(raw?.isBot),
    };
  }

  private normalizeSnapshot(state: any): GameSnapshot {
    const raw = state?.snapshotVersion ? state : {
      snapshotVersion: 1,
      ...state,
      devCardDeck: Array.isArray(state?.devCardDeck) ? state.devCardDeck : [],
      lastDiceYields: state?.lastDiceYields || {},
      setupSettlements: Array.isArray(state?.setupSettlements) ? state.setupSettlements : [],
      startedAt: state?.startedAt ?? null,
      finishedAt: state?.finishedAt ?? null,
      actionJournal: Array.isArray(state?.actionJournal) ? state.actionJournal : [],
    };

    if (!Array.isArray(raw.playerOrder)) {
      throw new Error('Invalid game snapshot: missing player order');
    }

    const colors = ['#ef4444', '#3b82f6', '#22c55e', '#f97316'];
    const playerOrder = raw.playerOrder.filter((playerId: any): playerId is string => typeof playerId === 'string');
    const players = Object.fromEntries(
      playerOrder.map((playerId: string, index: number) => [
        playerId,
        this.normalizePlayer(raw.players?.[playerId], playerId, colors[index % colors.length]),
      ])
    );

    return {
      snapshotVersion: GAME_SNAPSHOT_VERSION,
      phase: raw.phase ?? 'SETUP_R1',
      turnPhase: raw.turnPhase ?? 'FREE_ACTION',
      setupTurnIndex: typeof raw.setupTurnIndex === 'number' ? raw.setupTurnIndex : 0,
      players,
      playerOrder,
      currentTurnIndex: typeof raw.currentTurnIndex === 'number' ? raw.currentTurnIndex : 0,
      diceResult: typeof raw.diceResult === 'number' ? raw.diceResult : null,
      dice1: typeof raw.dice1 === 'number' ? raw.dice1 : 0,
      dice2: typeof raw.dice2 === 'number' ? raw.dice2 : 0,
      rollCount: typeof raw.rollCount === 'number' ? raw.rollCount : 0,
      lastDiceYields: typeof raw.lastDiceYields === 'object' && raw.lastDiceYields ? raw.lastDiceYields : {},
      buildings: typeof raw.buildings === 'object' && raw.buildings ? raw.buildings : {},
      roads: typeof raw.roads === 'object' && raw.roads ? raw.roads : {},
      robberHex: typeof raw.robberHex === 'string' ? raw.robberHex : this.robberHex,
      playersWhoMustDiscard: Array.isArray(raw.playersWhoMustDiscard) ? raw.playersWhoMustDiscard.filter((playerId: any) => typeof playerId === 'string') : [],
      devCardDeck: Array.isArray(raw.devCardDeck) ? raw.devCardDeck.filter((card: any) => typeof card === 'string') as DevCardType[] : [],
      longestRoadHolder: typeof raw.longestRoadHolder === 'string' ? raw.longestRoadHolder : null,
      longestRoadLength: typeof raw.longestRoadLength === 'number' ? raw.longestRoadLength : 0,
      largestArmyHolder: typeof raw.largestArmyHolder === 'string' ? raw.largestArmyHolder : null,
      largestArmySize: typeof raw.largestArmySize === 'number' ? raw.largestArmySize : 0,
      activeTradeOffer: raw.activeTradeOffer && typeof raw.activeTradeOffer === 'object'
        ? {
            fromPlayer: raw.activeTradeOffer.fromPlayer,
            offering: raw.activeTradeOffer.offering || {},
            requesting: raw.activeTradeOffer.requesting || {},
            rejectedBy: Array.isArray(raw.activeTradeOffer.rejectedBy) ? raw.activeTradeOffer.rejectedBy.filter((playerId: any) => typeof playerId === 'string') : [],
          }
        : null,
      log: Array.isArray(raw.log) ? raw.log.filter((line: any) => typeof line === 'string').slice(-100) : [],
      winner: typeof raw.winner === 'string' ? raw.winner : null,
      roadBuildingRemaining: typeof raw.roadBuildingRemaining === 'number' ? raw.roadBuildingRemaining : 0,
      lastEvent: raw.lastEvent && typeof raw.lastEvent === 'object' ? raw.lastEvent as GameEvent : null,
      setupSettlements: Array.isArray(raw.setupSettlements)
        ? raw.setupSettlements.filter((item: any) => typeof item?.playerId === 'string' && typeof item?.vertexId === 'string')
        : [],
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
      actionJournal: Array.isArray(raw.actionJournal)
        ? raw.actionJournal.filter((entry: any) => typeof entry?.id === 'string' && typeof entry?.type === 'string')
        : [],
    };
  }

  setState(state: any) {
    const snapshot = this.normalizeSnapshot(state);
    this.phase = snapshot.phase;
    this.turnPhase = snapshot.turnPhase;
    this.setupTurnIndex = snapshot.setupTurnIndex;
    this.players = snapshot.players;
    this.playerOrder = snapshot.playerOrder;
    this.currentTurnIndex = snapshot.currentTurnIndex;
    this.diceResult = snapshot.diceResult;
    this.dice1 = snapshot.dice1;
    this.dice2 = snapshot.dice2;
    this.rollCount = snapshot.rollCount;
    this.lastDiceYields = snapshot.lastDiceYields;
    this.buildings = snapshot.buildings;
    this.roads = snapshot.roads;
    this.robberHex = snapshot.robberHex;
    this.playersWhoMustDiscard = snapshot.playersWhoMustDiscard;
    this.devCardDeck = snapshot.devCardDeck.length > 0 ? snapshot.devCardDeck : shuffle([...INITIAL_DEV_DECK]);
    this.longestRoadHolder = snapshot.longestRoadHolder;
    this.longestRoadLength = snapshot.longestRoadLength;
    this.largestArmyHolder = snapshot.largestArmyHolder;
    this.largestArmySize = snapshot.largestArmySize;
    this.activeTradeOffer = snapshot.activeTradeOffer;
    this.log = snapshot.log;
    this.winner = snapshot.winner;
    this.roadBuildingRemaining = snapshot.roadBuildingRemaining;
    this.lastEvent = snapshot.lastEvent;
    this.setupSettlements = snapshot.setupSettlements;
    this.startedAt = snapshot.startedAt;
    this.finishedAt = snapshot.finishedAt;
    this.actionJournal = snapshot.actionJournal;
  }

  private isBlockedByOpponent(vertexId: string, userId: string) {
    const building = this.buildings[vertexId];
    return Boolean(building && building.owner !== userId);
  }

  addPlayer(userId: string, username: string = '', isBot: boolean = false): string | null {
    if (this.players[userId]) return null;
    if (this.playerOrder.length >= 4) return 'Game is full (max 4 players)';
    if (this.phase !== 'SETUP_R1' || this.setupTurnIndex > 0) return 'Game already started';

    const colors = ['#ef4444', '#3b82f6', '#22c55e', '#f97316'];
    const botNames = ['Gandalf', 'Saruman', 'Vader', 'Sauron', 'Gollum', 'Yoda'];
    let finalUsername = username;
    if (isBot && !finalUsername) {
      finalUsername = botNames[Math.floor(Math.random() * botNames.length)] + ` (Bot)`;
    } else if (!finalUsername) {
      finalUsername = `Player ${this.playerOrder.length + 1}`;
    }

    this.players[userId] = {
      id: userId,
      username: finalUsername,
      color: colors[this.playerOrder.length],
      resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
      score: 0,
      devCards: [],
      knightsPlayed: 0,
      hasPlayedDevCardThisTurn: false,
      isBot,
    };
    this.playerOrder.push(userId);
    this.recordAction('player_joined', userId, { username: finalUsername, isBot });
    return null;
  }

  // ─────────────────────────────────────────
  //  SETUP PHASE LOGIC
  // ─────────────────────────────────────────

  private getSetupCurrentPlayer(): string {
    const n = this.playerOrder.length;
    if (this.phase === 'SETUP_R1') {
      return this.playerOrder[this.setupTurnIndex];
    }
    // SETUP_R2: reverse order (snake draft)
    return this.playerOrder[n - 1 - this.setupTurnIndex];
  }

  private getSetupExpectedAction(): 'settlement' | 'road' {
    // Each setup turn: place settlement first, then road
    const currentPlayer = this.getSetupCurrentPlayer();
    const settlementsInThisRound = Object.values(this.buildings)
      .filter(b => b.owner === currentPlayer && b.type === 'settlement').length;

    const roadsInThisRound = Object.values(this.roads)
      .filter(owner => owner === currentPlayer).length;

    if (this.phase === 'SETUP_R1') {
      return settlementsInThisRound < 1 ? 'settlement' : (roadsInThisRound < 1 ? 'road' : 'settlement');
    }
    // SETUP_R2
    return settlementsInThisRound < 2 ? 'settlement' : (roadsInThisRound < 2 ? 'road' : 'settlement');
  }

  private advanceSetup() {
    const currentPlayer = this.getSetupCurrentPlayer();
    const settlements = Object.values(this.buildings)
      .filter(b => b.owner === currentPlayer && b.type === 'settlement').length;
    const playerRoads = Object.values(this.roads)
      .filter(owner => owner === currentPlayer).length;

    const expectedSettlements = this.phase === 'SETUP_R1' ? 1 : 2;
    const expectedRoads = this.phase === 'SETUP_R1' ? 1 : 2;

    if (settlements >= expectedSettlements && playerRoads >= expectedRoads) {
      this.setupTurnIndex++;

      if (this.setupTurnIndex >= this.playerOrder.length) {
        if (this.phase === 'SETUP_R1') {
          this.phase = 'SETUP_R2';
          this.setupTurnIndex = 0;
          this.addLog('🔄 Setup Round 2 begins (reverse order)');
        } else {
          // Setup complete! Give initial resources from 2nd settlement
          this.giveInitialResources();
          this.phase = 'MAIN_GAME';
          this.turnPhase = 'MUST_ROLL';
          this.currentTurnIndex = 0;
          this.startedAt = this.startedAt || new Date().toISOString();
          this.recordAction('game_started', this.playerOrder[0] ?? null, { playerOrder: [...this.playerOrder] });
          this.addLog(`🎮 Main game begins! ${this.playerName(this.playerOrder[0])} rolls first.`);
        }
      }
    }
  }

  private giveInitialResources() {
    // 2nd settlement (placed in SETUP_R2) gives initial resources
    // The snake draft ensures each player has 2 settlements in setupSettlements
    for (const playerId of this.playerOrder) {
      const playerPlacements = this.setupSettlements.filter(s => s.playerId === playerId);
      if (playerPlacements.length >= 2) {
        // The SECOND settlement placed is the one that gives resources
        const secondSettlementVertex = playerPlacements[1].vertexId;

        this.board.forEach(hex => {
          const { x, y } = getPixelPos(hex.q, hex.r);
          const hexVerts = getVerticesForHex(x, y);
          if (hexVerts.includes(secondSettlementVertex)) {
            const res = RESOURCE_FROM_HEX[hex.type];
            if (res) {
              this.players[playerId].resources[res] += 1;
              this.addLog(`${this.playerName(playerId)} received 1 ${res} from starting settlement`);
            }
          }
        });
      }
    }
  }

  // ─────────────────────────────────────────
  //  SETUP PLACE SETTLEMENT
  // ─────────────────────────────────────────

  placeSettlement(userId: string, vertexId: string): string | null {
    const p = this.players[userId];
    if (!p) return 'Player not found';

    // Already occupied?
    if (this.buildings[vertexId]) return 'Vertex already occupied';

    // STRICT Distance rule: no settlement on any neighboring vertex
    const neighbors = this.adjacencyMap[vertexId] || [];
    for (const neighborId of neighbors) {
      if (this.buildings[neighborId]) return 'Too close to another building (Distance Rule)';
    }

    // ── Setup Phase ──
    if (this.phase === 'SETUP_R1' || this.phase === 'SETUP_R2') {
      if (this.getSetupCurrentPlayer() !== userId) return 'Not your turn in setup';
      if (this.getSetupExpectedAction() !== 'settlement') return 'Place a road first';

      // Block edge vertices — setup settlements must be on interior intersections (touching 3 hexes)
      if (!this.interiorVertices.has(vertexId)) {
        return 'Cannot place on the edge of the island — must be at an interior intersection';
      }

      this.buildings[vertexId] = { owner: userId, type: 'settlement' };
      this.setupSettlements.push({ playerId: userId, vertexId });
      p.score += 1;
      this.recordAction('setup_settlement_placed', userId, { vertexId });
      this.addLog(`${this.playerName(userId)} placed a settlement (setup)`);
      // Don't advance setup yet — road must be placed next
      return null;
    }

    // ── Main Game ──
    if (this.phase !== 'MAIN_GAME') return 'Cannot build right now';
    if (this.turnPhase !== 'FREE_ACTION') return 'Roll dice first';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    // Piece limit
    const settlementCount = Object.values(this.buildings).filter(b => b.owner === userId && b.type === 'settlement').length;
    if (settlementCount >= PIECE_LIMITS.settlement) return 'Max settlements reached (5)';

    // Must be connected to your road
    const hasConnectingRoad = Object.entries(this.roads).some(([edgeId, ownerId]) => {
      if (ownerId !== userId) return false;
      return edgeId.split(':').includes(vertexId);
    });
    if (!hasConnectingRoad) return 'Must be connected to your road network';

    // Cost check
    const cost = BUILD_COSTS.settlement;
    if (!this.canAfford(p, cost)) return 'Not enough resources (need: 🪵🧱🐑🌾)';
    this.deductResources(p, cost);

    this.buildings[vertexId] = { owner: userId, type: 'settlement' };
    p.score += 1;
    this.recordAction('settlement_built', userId, { vertexId });
    this.addLog(`${this.playerName(userId)} built a settlement`);
    this.recalcLongestRoad();
    this.checkVictory(userId);
    return null;
  }

  // ─────────────────────────────────────────
  //  PLACE ROAD
  // ─────────────────────────────────────────

  placeRoad(userId: string, edgeId: string): string | null {
    const p = this.players[userId];
    if (!p) return 'Player not found';
    if (this.roads[edgeId]) return 'Road already built here';

    const [vA, vB] = edgeId.split(':');

    // Connection check: Must touch your settlement or your road
    const hasConnectingBuilding = this.buildings[vA]?.owner === userId || this.buildings[vB]?.owner === userId;
    const hasConnectingRoad = Object.entries(this.roads).some(([id, ownerId]) => {
      if (ownerId !== userId) return false;
      const [oA, oB] = id.split(':');
      const touchesA = (oA === vA || oB === vA) && !this.isBlockedByOpponent(vA, userId);
      const touchesB = (oA === vB || oB === vB) && !this.isBlockedByOpponent(vB, userId);
      return touchesA || touchesB;
    });
    if (!hasConnectingBuilding && !hasConnectingRoad) return 'Must connect to your network';

    // ── Setup Phase ──
    if (this.phase === 'SETUP_R1' || this.phase === 'SETUP_R2') {
      if (this.getSetupCurrentPlayer() !== userId) return 'Not your turn in setup';
      if (this.getSetupExpectedAction() !== 'road') return 'Must place a settlement first';

      // Rule: In setup, road must connect to the settlement JUST placed
      const playerPlacements = this.setupSettlements.filter(s => s.playerId === userId);
      const lastSettlement = playerPlacements[playerPlacements.length - 1].vertexId;
      if (vA !== lastSettlement && vB !== lastSettlement) {
        return 'In setup, road must connect to the settlement you just placed';
      }

      this.roads[edgeId] = userId;
      this.recordAction('setup_road_placed', userId, { edgeId });
      this.addLog(`${this.playerName(userId)} placed starting road`);
      this.advanceSetup();
      return null;
    }

    // ── Main Game ──
    if (this.phase !== 'MAIN_GAME') return 'Cannot build right now';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    // Road Building dev card active?
    if (this.roadBuildingRemaining > 0) {
      this.roads[edgeId] = userId;
      this.roadBuildingRemaining--;
      this.recordAction('road_built_free', userId, { edgeId, remaining: this.roadBuildingRemaining });
      this.addLog(`${this.playerName(userId)} built a free road (Road Building)`);
      this.recalcLongestRoad();
      this.checkVictory(userId);
      return null;
    }

    if (this.turnPhase !== 'FREE_ACTION') return 'Roll dice first';

    // Piece limit
    const roadCount = Object.values(this.roads).filter(v => v === userId).length;
    if (roadCount >= PIECE_LIMITS.road) return 'Max roads reached (15)';

    // Cost
    const cost = BUILD_COSTS.road;
    if (!this.canAfford(p, cost)) return 'Not enough resources (need: 🪵🧱)';
    this.deductResources(p, cost);

    this.roads[edgeId] = userId;
    this.recordAction('road_built', userId, { edgeId });
    this.addLog(`${this.playerName(userId)} built a road`);
    this.recalcLongestRoad();
    this.checkVictory(userId);
    return null;
  }

  // ─────────────────────────────────────────
  //  UPGRADE TO CITY
  // ─────────────────────────────────────────

  upgradeToCity(userId: string, vertexId: string): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Cannot build right now';
    if (this.turnPhase !== 'FREE_ACTION') return 'Roll dice first';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    const building = this.buildings[vertexId];
    if (!building || building.owner !== userId) return 'Not your settlement';
    if (building.type === 'city') return 'Already a city';

    const p = this.players[userId];
    const cityCount = Object.values(this.buildings).filter(b => b.owner === userId && b.type === 'city').length;
    if (cityCount >= PIECE_LIMITS.city) return 'Max cities reached (4)';

    const cost = BUILD_COSTS.city;
    if (!this.canAfford(p, cost)) return 'Not enough resources (need: 🌾🌾🪨🪨🪨)';
    this.deductResources(p, cost);

    building.type = 'city';
    p.score += 1; // was 1VP as settlement, now 2VP as city → net +1
    this.recordAction('city_upgraded', userId, { vertexId });
    this.addLog(`${this.playerName(userId)} upgraded to a city`);
    this.checkVictory(userId);
    return null;
  }

  // ─────────────────────────────────────────
  //  ROLL DICE
  // ─────────────────────────────────────────

  rollDice(userId: string): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Game not in main phase';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';
    if (this.turnPhase !== 'MUST_ROLL') return 'Already rolled this turn';

    this.dice1 = Math.floor(Math.random() * 6) + 1;
    this.dice2 = Math.floor(Math.random() * 6) + 1;
    this.diceResult = this.dice1 + this.dice2;
    this.recordAction('dice_rolled', userId, { dice1: this.dice1, dice2: this.dice2, total: this.diceResult });

    this.addLog(`${this.playerName(userId)} rolled ${this.dice1} + ${this.dice2} = ${this.diceResult}`);

    if (this.diceResult === 7) {
      // Robber! Check who must discard
      this.playersWhoMustDiscard = [];
      for (const pid of this.playerOrder) {
        const total = this.totalResources(this.players[pid]);
        if (total > 7) {
          this.playersWhoMustDiscard.push(pid);
        }
      }

      if (this.playersWhoMustDiscard.length > 0) {
        this.turnPhase = 'ROBBER_DISCARD';
        this.addLog('🏴‍☠️ Robber activated! Players with 8+ cards must discard half.');
      } else {
        this.turnPhase = 'ROBBER_MOVE';
        this.addLog('🏴‍☠️ Robber activated! Move the robber.');
      }
      return null;
    }

    // Distribute resources
    this.distributeResources(this.diceResult);
    this.turnPhase = 'FREE_ACTION';
    return null;
  }

  // ─────────────────────────────────────────
  //  RESOURCE DISTRIBUTION
  // ─────────────────────────────────────────

  private distributeResources(roll: number) {
    this.rollCount++;
    this.lastDiceYields = {};
    for (const pid of this.playerOrder) this.lastDiceYields[pid] = [];

    this.board.forEach(hex => {
      if (hex.number !== roll) return;
      // Skip hex with robber
      if (`${hex.q},${hex.r}` === this.robberHex) return;

      const res = RESOURCE_FROM_HEX[hex.type];
      if (!res) return;

      const { x, y } = getPixelPos(hex.q, hex.r);
      const verts = getVerticesForHex(x, y);

      verts.forEach(vid => {
        const building = this.buildings[vid];
        if (building && this.players[building.owner]) {
          const amount = building.type === 'city' ? 2 : 1;
          this.players[building.owner].resources[res] += amount;
          for (let i = 0; i < amount; i++) {
            this.lastDiceYields[building.owner].push(res);
          }
        }
      });
    });
  }

  // ─────────────────────────────────────────
  //  ROBBER
  // ─────────────────────────────────────────

  robberDiscard(userId: string, discarded: Partial<Resources>): string | null {
    if (this.turnPhase !== 'ROBBER_DISCARD') return 'Not in discard phase';
    if (!this.playersWhoMustDiscard.includes(userId)) return 'You don\'t need to discard';

    const p = this.players[userId];
    const total = this.totalResources(p);
    const mustDiscard = Math.floor(total / 2);

    let discardTotal = 0;
    for (const [res, amount] of Object.entries(discarded)) {
      if (amount && amount > 0) {
        const r = res as ResourceType;
        if (p.resources[r] < amount) return `Not enough ${res} to discard`;
        discardTotal += amount;
      }
    }

    if (discardTotal !== mustDiscard) return `Must discard exactly ${mustDiscard} cards (you chose ${discardTotal})`;

    // Execute discard
    for (const [res, amount] of Object.entries(discarded)) {
      if (amount && amount > 0) {
        p.resources[res as ResourceType] -= amount;
      }
    }

    this.playersWhoMustDiscard = this.playersWhoMustDiscard.filter(id => id !== userId);
    this.recordAction('robber_discarded', userId, { discarded, discardTotal });
    this.addLog(`${this.playerName(userId)} discarded ${discardTotal} cards`);

    if (this.playersWhoMustDiscard.length === 0) {
      this.turnPhase = 'ROBBER_MOVE';
      this.addLog('All players discarded. Move the robber!');
    }
    return null;
  }

  moveRobber(userId: string, hexCoord: string, stealFromPlayer: string | null): string | null {
    if (this.turnPhase !== 'ROBBER_MOVE') return 'Not in robber move phase';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';
    if (hexCoord === this.robberHex) return 'Must move robber to a different hex';

    // Validate hex exists
    const [q, r] = hexCoord.split(',').map(Number);
    const targetHex = this.board.find(h => h.q === q && h.r === r);
    if (!targetHex) return 'Invalid hex';

    this.robberHex = hexCoord;
    this.recordAction('robber_moved', userId, { hexCoord, stealFromPlayer });
    this.addLog(`${this.playerName(userId)} moved the robber`);

    // Steal from adjacent player
    if (stealFromPlayer && stealFromPlayer !== userId) {
      const victim = this.players[stealFromPlayer];
      if (victim && this.totalResources(victim) > 0) {
        // Verify victim has a building adjacent to robber hex
        const { x, y } = getPixelPos(q, r);
        const verts = getVerticesForHex(x, y);
        const hasAdjacent = verts.some(v => this.buildings[v]?.owner === stealFromPlayer);

        if (hasAdjacent) {
          const stolenRes = this.stealRandomResource(victim);
          if (stolenRes) {
            this.players[userId].resources[stolenRes] += 1;
            const vp = this.players[userId];
            this.addLog(`${this.playerName(userId)} stole 1 card from ${this.playerName(stealFromPlayer)}`);
            this.recordAction('resource_stolen', userId, { from: stealFromPlayer, resource: stolenRes, hexCoord });
            this.lastEvent = {
              type: 'steal', eventId: this._mkEventId(),
              playerId: userId, playerName: this.playerName(userId), playerColor: vp.color,
              details: {
                stolenFrom: stealFromPlayer,
                stolenFromName: this.playerName(stealFromPlayer),
                stolenFromColor: victim.color,
                stolenRes,
              }
            };
          }
        }
      }
    }

    this.turnPhase = 'FREE_ACTION';
    return null;
  }

  // Returns player IDs (excluding excludePlayer) who have buildings on hex
  getPlayersOnHex(hexCoord: string, excludePlayer: string): string[] {
    const [q, r] = hexCoord.split(',').map(Number);
    const { x, y } = getPixelPos(q, r);
    const verts = getVerticesForHex(x, y);
    const players = new Set<string>();
    verts.forEach(v => {
      const bld = this.buildings[v];
      if (bld && bld.owner !== excludePlayer && this.totalResources(this.players[bld.owner]) > 0) {
        players.add(bld.owner);
      }
    });
    return Array.from(players);
  }

  private stealRandomResource(victim: Player): ResourceType | null {
    const available: ResourceType[] = [];
    for (const [res, amount] of Object.entries(victim.resources)) {
      for (let i = 0; i < amount; i++) available.push(res as ResourceType);
    }
    if (available.length === 0) return null;
    const stolen = available[Math.floor(Math.random() * available.length)];
    victim.resources[stolen] -= 1;
    return stolen;
  }

  // ─────────────────────────────────────────
  //  END TURN
  // ─────────────────────────────────────────

  endTurn(userId: string): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Game not in main phase';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';
    if (this.turnPhase === 'MUST_ROLL') return 'Must roll dice before ending turn';
    if (this.turnPhase === 'ROBBER_DISCARD' || this.turnPhase === 'ROBBER_MOVE') return 'Must resolve robber first';

    this.currentTurnIndex = (this.currentTurnIndex + 1) % this.playerOrder.length;
    this.diceResult = null;
    this.turnPhase = 'MUST_ROLL';
    this.roadBuildingRemaining = 0;

    // Reset dev card played flag
    const nextPlayer = this.players[this.playerOrder[this.currentTurnIndex]];
    if (nextPlayer) nextPlayer.hasPlayedDevCardThisTurn = false;

    // Unmark "bought this turn" on previous player's cards
    this.players[userId].devCards.forEach(c => { c.boughtThisTurn = false; });

    this.recordAction('turn_ended', userId, { nextPlayerId: this.playerOrder[this.currentTurnIndex] });
    this.addLog(`${this.playerName(userId)} ended their turn`);
    return null;
  }

  // ─────────────────────────────────────────
  //  DEVELOPMENT CARDS
  // ─────────────────────────────────────────

  buyDevCard(userId: string): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Game not in main phase';
    if (this.turnPhase !== 'FREE_ACTION') return 'Roll dice first';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    const p = this.players[userId];
    if (this.devCardDeck.length === 0) return 'No dev cards left in deck';

    const cost = BUILD_COSTS.devCard;
    if (!this.canAfford(p, cost)) return 'Not enough resources (need: 🐑🌾🪨)';
    this.deductResources(p, cost);

    const cardType = this.devCardDeck.pop()!;
    p.devCards.push({ type: cardType, boughtThisTurn: true });

    this.recordAction('dev_card_bought', userId, { cardType });
    this.addLog(`${this.playerName(userId)} bought a development card`);
    if (cardType === 'victoryPoint') {
      this.checkVictory(userId);
    }
    return null;
  }

  playDevCard(userId: string, cardIndex: number, payload?: any): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Game not in main phase';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    const p = this.players[userId];
    if (cardIndex < 0 || cardIndex >= p.devCards.length) return 'Invalid card index';

    const card = p.devCards[cardIndex];
    if (card.boughtThisTurn) return 'Cannot play a card bought this turn';
    if (card.type === 'victoryPoint') return 'Victory Point cards are passive';
    if (p.hasPlayedDevCardThisTurn) return 'Already played a dev card this turn';

    p.hasPlayedDevCardThisTurn = true;

    switch (card.type) {
      case 'knight': {
        p.knightsPlayed++;
        this.addLog(`${this.playerName(userId)} played a Knight (${p.knightsPlayed} total)`);
        this.recalcLargestArmy();
        this.turnPhase = 'ROBBER_MOVE';
        p.devCards.splice(cardIndex, 1);
        this.checkVictory(userId);
        this.recordAction('dev_card_played', userId, { cardType: 'knight' });
        this.lastEvent = {
          type: 'dev_card', eventId: this._mkEventId(),
          playerId: userId, playerName: this.playerName(userId), playerColor: p.color,
          card: 'knight', details: { knightsTotal: p.knightsPlayed }
        };
        return null;
      }

      case 'yearOfPlenty': {
        if (!payload?.res1 || !payload?.res2) return 'Must specify 2 resources';
        p.resources[payload.res1 as ResourceType] += 1;
        p.resources[payload.res2 as ResourceType] += 1;
        this.addLog(`${this.playerName(userId)} played Year of Plenty (${payload.res1}, ${payload.res2})`);
        p.devCards.splice(cardIndex, 1);
        this.recordAction('dev_card_played', userId, { cardType: 'yearOfPlenty', res1: payload.res1, res2: payload.res2 });
        this.lastEvent = {
          type: 'dev_card', eventId: this._mkEventId(),
          playerId: userId, playerName: this.playerName(userId), playerColor: p.color,
          card: 'yearOfPlenty', details: { res1: payload.res1, res2: payload.res2 }
        };
        return null;
      }

      case 'monopoly': {
        if (!payload?.resource) return 'Must specify resource type';
        const res = payload.resource as ResourceType;
        let stolen = 0;
        for (const otherId of this.playerOrder) {
          if (otherId === userId) continue;
          const other = this.players[otherId];
          stolen += other.resources[res];
          other.resources[res] = 0;
        }
        p.resources[res] += stolen;
        this.addLog(`${this.playerName(userId)} played Monopoly on ${res} → stole ${stolen}`);
        p.devCards.splice(cardIndex, 1);
        this.recordAction('dev_card_played', userId, { cardType: 'monopoly', resource: res, stolen });
        this.lastEvent = {
          type: 'dev_card', eventId: this._mkEventId(),
          playerId: userId, playerName: this.playerName(userId), playerColor: p.color,
          card: 'monopoly', details: { resource: res, stolen }
        };
        return null;
      }

      case 'roadBuilding': {
        this.roadBuildingRemaining = 2;
        this.addLog(`${this.playerName(userId)} played Road Building`);
        p.devCards.splice(cardIndex, 1);
        this.recordAction('dev_card_played', userId, { cardType: 'roadBuilding' });
        this.lastEvent = {
          type: 'dev_card', eventId: this._mkEventId(),
          playerId: userId, playerName: this.playerName(userId), playerColor: p.color,
          card: 'roadBuilding', details: {}
        };
        return null;
      }
    }

    return 'Unknown card type';
  }

  // ─────────────────────────────────────────
  //  BANK TRADE (4:1 or Port Rate)
  // ─────────────────────────────────────────

  bankTrade(userId: string, offerRes: string, requestRes: string): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Game not in main phase';
    if (this.turnPhase !== 'FREE_ACTION') return 'Roll dice first';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    const p = this.players[userId];
    const offer = offerRes as ResourceType;
    const request = requestRes as ResourceType;

    // Determine rate based on ports
    let rate = 4;
    
    // Check ports
    const myBuildingVertices = Object.keys(this.buildings).filter(v => this.buildings[v].owner === userId);
    
    for (const port of this.ports) {
      const hasAccess = port.vertices.some(pv => myBuildingVertices.includes(pv));
      if (hasAccess) {
        if (port.type === 'generic' && rate > 3) rate = 3;
        if (port.type === (offer as string) && rate > 2) rate = 2;
      }
    }

    if (p.resources[offer] < rate) return `Not enough ${offerRes} (need ${rate} for this port/bank)`;

    p.resources[offer] -= rate;
    p.resources[request] += 1;
    this.recordAction('bank_trade', userId, { offer, request, rate });
    this.addLog(`${this.playerName(userId)} traded ${rate} ${offerRes} → 1 ${requestRes}`);
    return null;
  }

  // ─────────────────────────────────────────
  //  PLAYER-TO-PLAYER TRADE
  // ─────────────────────────────────────────

  proposeTrade(userId: string, offering: Partial<Resources>, requesting: Partial<Resources>): string | null {
    if (this.phase !== 'MAIN_GAME') return 'Game not in main phase';
    if (this.turnPhase !== 'FREE_ACTION') return 'Roll dice first';
    if (this.playerOrder[this.currentTurnIndex] !== userId) return 'Not your turn';

    const p = this.players[userId];
    for (const [res, amount] of Object.entries(offering)) {
      if (amount && p.resources[res as ResourceType] < amount) return `Not enough ${res}`;
    }

    this.activeTradeOffer = { fromPlayer: userId, offering, requesting, rejectedBy: [] };
    this.recordAction('trade_proposed', userId, { offering, requesting });
    this.addLog(`${this.playerName(userId)} proposed a trade`);
    return null;
  }

  acceptTrade(userId: string): string | null {
    if (!this.activeTradeOffer) return 'No active trade offer';
    if (userId === this.activeTradeOffer.fromPlayer) return 'Cannot accept your own trade';

    const accepter = this.players[userId];
    const proposer = this.players[this.activeTradeOffer.fromPlayer];

    // Check accepter has the requested resources
    for (const [res, amount] of Object.entries(this.activeTradeOffer.requesting)) {
      if (amount && accepter.resources[res as ResourceType] < amount) return `Not enough ${res}`;
    }

    // Execute trade
    for (const [res, amount] of Object.entries(this.activeTradeOffer.offering)) {
      if (amount) {
        proposer.resources[res as ResourceType] -= amount;
        accepter.resources[res as ResourceType] += amount;
      }
    }
    for (const [res, amount] of Object.entries(this.activeTradeOffer.requesting)) {
      if (amount) {
        accepter.resources[res as ResourceType] -= amount;
        proposer.resources[res as ResourceType] += amount;
      }
    }

    this.addLog(`${this.playerName(userId)} accepted trade from ${this.playerName(this.activeTradeOffer.fromPlayer)}`);
    this.recordAction('trade_accepted', userId, { fromPlayer: this.activeTradeOffer.fromPlayer });
    this.activeTradeOffer = null;
    return null;
  }

  rejectTrade(userId: string): string | null {
    if (!this.activeTradeOffer) return null;
    // Proposer cancels their own offer
    if (userId === this.activeTradeOffer.fromPlayer) {
      this.recordAction('trade_cancelled', userId, {});
      this.activeTradeOffer = null;
      return null;
    }
    // Track who has dismissed
    if (!this.activeTradeOffer.rejectedBy.includes(userId)) {
      this.activeTradeOffer.rejectedBy.push(userId);
    }
    // Clear only when ALL non-proposers have dismissed
    const nonProposers = this.playerOrder.filter(pid => pid !== this.activeTradeOffer!.fromPlayer);
    if (nonProposers.every(pid => this.activeTradeOffer!.rejectedBy.includes(pid))) {
      this.addLog(`Trade offer expired — all dismissed`);
      this.recordAction('trade_expired', userId, { fromPlayer: this.activeTradeOffer.fromPlayer });
      this.activeTradeOffer = null;
    }
    return null;
  }

  // ─────────────────────────────────────────
  //  BOT TRADE EVALUATION
  // ─────────────────────────────────────────

  evaluateBotsForTrade(proposerId: string): void {
    if (!this.activeTradeOffer) return;
    const bots = this.playerOrder.filter(pid => this.players[pid]?.isBot && pid !== proposerId);
    for (const botId of bots) {
      if (!this.activeTradeOffer) break; // Already accepted
      if (this.botShouldAcceptTrade(botId)) {
        this.acceptTrade(botId);
        return;
      } else {
        this.rejectTrade(botId);
      }
    }
  }

  private botShouldAcceptTrade(botId: string): boolean {
    if (!this.activeTradeOffer) return false;
    const offer = this.activeTradeOffer;
    const bot = this.players[botId];
    // Can bot fulfill? (has what proposer wants?)
    for (const [res, amount] of Object.entries(offer.requesting)) {
      if ((amount ?? 0) > 0 && bot.resources[res as ResourceType] < (amount ?? 0)) return false;
    }
    // Value function: how much does the bot need this resource?
    const valueForBot = (res: string, amount: number): number => {
      const r = res as ResourceType;
      const p = bot;
      const total = this.totalResources(p);
      const have = p.resources[r];
      const scarcity = total > 0 ? Math.max(0, 1 - (have / Math.max(1, total))) : 1;
      const cityScore = (r === 'wheat' || r === 'ore') ? 2.5 : 0;
      const settlScore = (r === 'wood' || r === 'brick' || r === 'sheep' || r === 'wheat') ? 1.5 : 0;
      const devScore = (r === 'sheep' || r === 'wheat' || r === 'ore') ? 1.5 : 0;
      return amount * (cityScore + settlScore + devScore) * (1 + scarcity);
    };
    let getScore = 0, giveScore = 0;
    for (const [res, amount] of Object.entries(offer.offering)) {
      if (amount) getScore += valueForBot(res, amount);
    }
    for (const [res, amount] of Object.entries(offer.requesting)) {
      if (amount) giveScore += valueForBot(res, amount);
    }
    // Very restrictive: bot only accepts if it gets ≥50% more value than it gives
    return getScore >= giveScore * 1.5;
  }

  getBotTradeOffer(botId: string): { offering: Partial<Resources>; requesting: Partial<Resources> } | null {
    const p = this.players[botId];
    const resTypes: ResourceType[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
    // Need a surplus of 3+ of one resource
    const surplus = resTypes.find(r => p.resources[r] >= 3);
    if (!surplus) return null;
    const needed = this.getMostNeededResources(botId);
    const request = needed.find(r => r !== surplus);
    if (!request) return null;
    // Only offer if a human player has what we need
    const humanHas = this.playerOrder.some(pid =>
      !this.players[pid].isBot && pid !== botId && this.players[pid].resources[request] >= 1
    );
    if (!humanHas) return null;
    return {
      offering: { [surplus]: 2 } as Partial<Resources>,
      requesting: { [request]: 1 } as Partial<Resources>,
    };
  }

  // ─────────────────────────────────────────
  //  LONGEST ROAD (DFS)
  // ─────────────────────────────────────────

  private recalcLongestRoad() {
    let newHolder = this.longestRoadHolder;
    let newLength = this.longestRoadLength;

    for (const playerId of this.playerOrder) {
      const length = this.calcLongestRoadForPlayer(playerId);
      if (length >= 5 && length > newLength) {
        newHolder = playerId;
        newLength = length;
      }
    }

    if (newHolder !== this.longestRoadHolder) {
      if (this.longestRoadHolder) {
        this.addLog(`${this.playerName(this.longestRoadHolder)} lost Longest Road`);
      }
      this.longestRoadHolder = newHolder;
      this.longestRoadLength = newLength;
      if (newHolder) {
        this.addLog(`🛤️ ${this.playerName(newHolder)} has Longest Road (${newLength})`);
      }
    } else {
      this.longestRoadLength = newLength;
    }
  }

  private calcLongestRoadForPlayer(playerId: string): number {
    // Build adjacency list from this player's roads
    const adj: Record<string, string[]> = {};
    for (const [edgeId, owner] of Object.entries(this.roads)) {
      if (owner !== playerId) continue;
      const [a, b] = edgeId.split(':');
      if (!adj[a]) adj[a] = [];
      if (!adj[b]) adj[b] = [];
      adj[a].push(b);
      adj[b].push(a);
    }

    const vertices = Object.keys(adj);
    if (vertices.length === 0) return 0;

    let maxLength = 0;
    for (const start of vertices) {
      const visited = new Set<string>();
      maxLength = Math.max(maxLength, this.dfsRoad(start, visited, adj, playerId));
    }
    return maxLength;
  }

  private dfsRoad(node: string, visited: Set<string>, adj: Record<string, string[]>, playerId: string): number {
    let max = 0;
    for (const neighbor of (adj[node] || [])) {
      const edgeKey = [node, neighbor].sort().join(':');
      if (visited.has(edgeKey)) continue;

      // Road is blocked by opponent's settlement/city
      const building = this.buildings[neighbor];
      if (building && building.owner !== playerId) continue;

      visited.add(edgeKey);
      max = Math.max(max, 1 + this.dfsRoad(neighbor, visited, adj, playerId));
      visited.delete(edgeKey);
    }
    return max;
  }

  // ─────────────────────────────────────────
  //  LARGEST ARMY
  // ─────────────────────────────────────────

  private recalcLargestArmy() {
    let newHolder = this.largestArmyHolder;
    let newSize = this.largestArmySize;

    for (const playerId of this.playerOrder) {
      const knights = this.players[playerId].knightsPlayed;
      if (knights >= 3 && knights > newSize) {
        newHolder = playerId;
        newSize = knights;
      }
    }

    if (newHolder !== this.largestArmyHolder) {
      this.largestArmyHolder = newHolder;
      this.largestArmySize = newSize;
      if (newHolder) {
        this.addLog(`⚔️ ${this.playerName(newHolder)} has Largest Army (${newSize} knights)`);
      }
    }
  }

  // ─────────────────────────────────────────
  //  VICTORY CHECK
  // ─────────────────────────────────────────

  private checkVictory(userId: string) {
    const p = this.players[userId];
    let vp = p.score; // Buildings VP
    if (this.longestRoadHolder === userId) vp += 2;
    if (this.largestArmyHolder === userId) vp += 2;
    vp += p.devCards.filter(c => c.type === 'victoryPoint').length;

    if (vp >= 10) {
      this.phase = 'GAME_OVER';
      this.winner = userId;
       this.finishedAt = new Date().toISOString();
      this.recordAction('game_finished', userId, { winnerId: userId, victoryPoints: vp });
      this.addLog(`🏆 ${this.playerName(userId)} WINS with ${vp} Victory Points!`);
    }
  }

  // ─────────────────────────────────────────
  //  BOT LOGIC (THE INQUISITOR)
  // ─────────────────────────────────────────

  executeBotSetup(botId: string) {
    const action = this.getSetupExpectedAction();
    if (action === 'settlement') {
      const bestVertex = this.getBestVertexForBot(botId);
      if (bestVertex) this.placeSettlement(botId, bestVertex);
    } else {
      const bestEdge = this.getBestEdgeForBot(botId);
      if (bestEdge) this.placeRoad(botId, bestEdge);
    }
  }

  executeBotTurn(botId: string) {
    if (this.turnPhase === 'MUST_ROLL') {
      this.rollDice(botId);
    } else if (this.turnPhase === 'ROBBER_DISCARD') {
      const p = this.players[botId];
      const total = this.totalResources(p);
      const mustDiscard = Math.floor(total / 2);
      const discarded: Partial<Resources> = {};
      let count = 0;
      const resTypes: ResourceType[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
      const availableRes = resTypes.filter(r => p.resources[r] > 0);
      
      while (count < mustDiscard && availableRes.length > 0) {
        const r = availableRes[Math.floor(Math.random() * availableRes.length)];
        p.resources[r]--;
        discarded[r] = (discarded[r] || 0) + 1;
        count++;
        if (p.resources[r] === 0) {
          const idx = availableRes.indexOf(r);
          availableRes.splice(idx, 1);
        }
      }
      this.playersWhoMustDiscard = this.playersWhoMustDiscard.filter(id => id !== botId);
      this.addLog(`🏴‍☠️ ${this.playerName(botId)} (Bot) discarded ${mustDiscard} cards`);
      if (this.playersWhoMustDiscard.length === 0) this.turnPhase = 'ROBBER_MOVE';
    } else if (this.turnPhase === 'ROBBER_MOVE') {
      const bestHex = this.getBestRobberHexForBot(botId);
      const victim = this.getVictimAtHex(bestHex, botId);
      this.moveRobber(botId, bestHex, victim);
    } else if (this.turnPhase === 'FREE_ACTION') {
      // Play dev cards first (before building)
      this.playBotDevCards(botId);

      let builtSomething = true;
      let limit = 0;
      while (builtSomething && limit < 12) {
        limit++;
        builtSomething = false;

        // 1. Upgrade to city
        const mySettlements = Object.entries(this.buildings).filter(([_, b]) => b.owner === botId && b.type === 'settlement');
        for (const [vid] of mySettlements) {
          if (this.upgradeToCity(botId, vid) === null) { builtSomething = true; break; }
        }
        if (builtSomething) continue;

        // 2. Build settlement (only if road is connected)
        const bestVertex = this.getBestVertexForBot(botId);
        if (bestVertex && this.placeSettlement(botId, bestVertex) === null) { builtSomething = true; continue; }

        // 3. Build road (scoring towards longest road)
        const bestEdge = this.getBestEdgeForBot(botId);
        if (bestEdge && this.placeRoad(botId, bestEdge) === null) { builtSomething = true; continue; }

        // 4. Bank trade to get what we need
        if (this.totalResources(this.players[botId]) >= 4) {
          const needed4 = this.getMostNeededResources(botId);
          const botRes = this.players[botId];
          const surplus4 = (['wood', 'brick', 'sheep', 'wheat', 'ore'] as ResourceType[]).find(r => botRes.resources[r] >= 4);
          const missing4 = needed4.find(r => r !== surplus4 && botRes.resources[r] === 0);
          if (missing4 && surplus4) {
            if (this.bankTrade(botId, surplus4, missing4) === null) { builtSomething = true; continue; }
          }
        }

        // 5. Buy dev card (for army strategy)
        const botPlayer = this.players[botId];
        const goingForArmy = this.largestArmyHolder !== botId && botPlayer.knightsPlayed >= 1;
        if (goingForArmy || this.devCardDeck.length > 0) {
          if (this.buyDevCard(botId) === null) { builtSomething = true; continue; }
        }

        // 6. Propose trade if stuck with surplus
        if (!this.activeTradeOffer) {
          const tradeOffer = this.getBotTradeOffer(botId);
          if (tradeOffer) {
            const err = this.proposeTrade(botId, tradeOffer.offering, tradeOffer.requesting);
            if (!err) {
              // Bots auto-evaluate immediately (other bots accept/reject)
              this.evaluateBotsForTrade(botId);
              if (!this.activeTradeOffer) { builtSomething = true; continue; } // Accepted!
            }
          }
        }
      }
      this.endTurn(botId);

    }
  }

  private playBotDevCards(botId: string) {
    const p = this.players[botId];
    if (p.devCards.length === 0 || p.hasPlayedDevCardThisTurn) return;

    // 1. Knight: play aggressively for Largest Army
    const knightIndex = p.devCards.findIndex(c => c.type === 'knight' && !c.boughtThisTurn);
    if (knightIndex !== -1) {
      const robberAffects = this.isBotAffectedByRobber(botId);
      const alreadyHoldsArmy = this.largestArmyHolder === botId;
      const leaderKnights = Math.max(0, ...this.playerOrder.map(pid => this.players[pid].knightsPlayed));
      const goingForArmy = !alreadyHoldsArmy && (p.knightsPlayed >= 2 || p.knightsPlayed >= leaderKnights);
      if (robberAffects || goingForArmy) {
        const bestHex = this.getBestRobberHexForBot(botId);
        const victim = this.getVictimAtHex(bestHex, botId);
        this.playDevCard(botId, knightIndex, { hexCoord: bestHex, victimId: victim || undefined });
        return;
      }
    }

    // 2. Monopoly: steal most-stockpiled resource
    const monoIndex = p.devCards.findIndex(c => c.type === 'monopoly' && !c.boughtThisTurn);
    if (monoIndex !== -1) {
      const resCount: Record<string, number> = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
      this.playerOrder.filter(pid => pid !== botId).forEach(pid => {
        const pr = this.players[pid].resources;
        for (const r of Object.keys(resCount)) resCount[r] += pr[r as ResourceType] || 0;
      });
      const [bestRes, bestAmt] = Object.entries(resCount).sort((a, b) => b[1] - a[1])[0];
      if (bestAmt >= 2) {
        this.playDevCard(botId, monoIndex, { resource: bestRes });
        return;
      }
    }

    // 3. Year of Plenty: grab what we need most
    const yopIndex = p.devCards.findIndex(c => c.type === 'yearOfPlenty' && !c.boughtThisTurn);
    if (yopIndex !== -1) {
      const needed = this.getMostNeededResources(botId);
      if (needed.length >= 1) {
        const res1 = needed[0] || 'wheat';
        const res2 = needed[1] || needed[0] || 'ore';
        this.playDevCard(botId, yopIndex, { res1, res2 });
      }
    }
  }

  private getMostNeededResources(botId: string): ResourceType[] {
    const p = this.players[botId];
    const scores: Partial<Record<ResourceType, number>> = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    const mySettlements = Object.values(this.buildings).filter(b => b.owner === botId);
    const hasCity = mySettlements.some(b => b.type === 'city');
    // City priority
    if (p.resources.wheat < 2) scores.wheat = (scores.wheat ?? 0) + 4;
    if (p.resources.ore < 3) scores.ore = (scores.ore ?? 0) + 4;
    if (!hasCity) {
      // Settlement priority  
      if (p.resources.wood === 0) scores.wood = (scores.wood ?? 0) + 3;
      if (p.resources.brick === 0) scores.brick = (scores.brick ?? 0) + 3;
      if (p.resources.sheep === 0) scores.sheep = (scores.sheep ?? 0) + 3;
    }
    // Road for longest road
    if (p.resources.wood === 0) scores.wood = (scores.wood ?? 0) + 2;
    if (p.resources.brick === 0) scores.brick = (scores.brick ?? 0) + 2;
    // Dev for army
    if (p.resources.sheep === 0) scores.sheep = (scores.sheep ?? 0) + 2;
    const resTypes: ResourceType[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
    return resTypes
      .filter(r => (scores[r] ?? 0) > 0)
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  }

  private isBotAffectedByRobber(botId: string): boolean {
    const { x, y } = getPixelPos(this.board.find(h => `${h.q},${h.r}` === this.robberHex)!.q, this.board.find(h => `${h.q},${h.r}` === this.robberHex)!.r);
    return getVerticesForHex(x, y).some(v => this.buildings[v]?.owner === botId);
  }

  private getBestVertexForBot(botId: string): string | null {
    const vertexScores: Record<string, number> = {};
    const playerResources = new Set<string>();

    // Check what resources the bot already has access to
    Object.values(this.buildings).forEach(b => {
      if (b.owner === botId) {
        this.board.forEach(hex => {
          const { x, y } = getPixelPos(hex.q, hex.r);
          if (getVerticesForHex(x, y).includes(Object.keys(this.buildings).find(k => this.buildings[k] === b)!)) {
            playerResources.add(hex.type);
          }
        });
      }
    });

    this.board.forEach(hex => {
      const { x, y } = getPixelPos(hex.q, hex.r);
      const verts = getVerticesForHex(x, y);
      const dots = hex.number ? (6 - Math.abs(7 - hex.number)) : 0;
      if (hex.type === 'desert') return;

      verts.forEach(vId => {
        if (this.buildings[vId]) return;
        
        // Base score = dots (probability)
        let score = dots;

        // Bonus for resource diversity
        if (!playerResources.has(hex.type)) {
          score += 2; // Value diversification at start
        }

        // STRICT Distance rule check
        const neighbors = this.adjacencyMap[vId] || [];
        const tooClose = neighbors.some(nId => this.buildings[nId]);
        if (tooClose) { score = -10000; }

        // Connection check (if in main game)
        if (this.phase === 'MAIN_GAME') {
          const connected = Object.entries(this.roads).some(([eid, owner]) => owner === botId && eid.split(':').includes(vId));
          if (!connected) return;
        }

        vertexScores[vId] = (vertexScores[vId] || 0) + score;
      });
    });

    const entries = Object.entries(vertexScores).filter(e => e[1] > -5000).sort((a, b) => b[1] - a[1]);
    return entries.length > 0 ? entries[0][0] : null;
  }

  private getBestEdgeForBot(botId: string): string | null {
    const myRoadLength = this.calcLongestRoadForPlayer(botId);
    const scored: Array<{ eid: string; score: number }> = [];

    // During setup, road MUST connect to the settlement just placed
    let requiredVertex: string | null = null;
    if (this.phase === 'SETUP_R1' || this.phase === 'SETUP_R2') {
      const playerPlacements = this.setupSettlements.filter(s => s.playerId === botId);
      if (playerPlacements.length > 0) {
        requiredVertex = playerPlacements[playerPlacements.length - 1].vertexId;
      }
    }

    this.board.forEach(hex => {
      const { x, y } = getPixelPos(hex.q, hex.r);
      const verts = getVerticesForHex(x, y);
      verts.forEach((v1, i, arr) => {
        const v2 = arr[(i + 1) % 6];
        const eid = [v1, v2].sort().join(':');
        if (this.roads[eid]) return;

        if (requiredVertex) {
          if (v1 !== requiredVertex && v2 !== requiredVertex) return;
        } else {
          const connected =
            (this.buildings[v1]?.owner === botId || this.buildings[v2]?.owner === botId) ||
            Object.entries(this.roads).some(([rid, rOwner]) =>
              rOwner === botId && (rid.split(':').includes(v1) || rid.split(':').includes(v2)));
          if (!connected) return;
        }

        let score = 1;
        // Simulate: temporarily add this road and check new road length
        this.roads[eid] = botId;
        const newLen = this.calcLongestRoadForPlayer(botId);
        delete this.roads[eid];
        if (newLen > myRoadLength) score += (newLen - myRoadLength) * 5;

        // Bonus if edge leads toward best settlement vertex
        const bestV = this.getBestVertexForBot(botId);
        if (bestV && (v1 === bestV || v2 === bestV)) score += 3;

        // Add some random noise so bot doesn't become predictable
        score += Math.random();

        scored.push({ eid, score });
      });
    });

    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0].eid;
  }


  private getBestRobberHexForBot(botId: string): string {
    let bestHex = this.robberHex;
    let maxScore = -1;

    this.board.forEach(hex => {
      const hc = `${hex.q},${hex.r}`;
      if (hc === this.robberHex || hex.type === 'desert') return;

      let score = 0;
      const { x, y } = getPixelPos(hex.q, hex.r);
      getVerticesForHex(x, y).forEach(v => {
        const b = this.buildings[v];
        if (b && b.owner !== botId) score += (b.type === 'city' ? 2 : 1);
      });

      if (score > maxScore) {
        maxScore = score;
        bestHex = hc;
      }
    });
    return bestHex;
  }

  private getVictimAtHex(hexCoord: string, botId: string): string | null {
    const [q, r] = hexCoord.split(',').map(Number);
    const { x, y } = getPixelPos(q, r);
    const verts = getVerticesForHex(x, y);
    
    let bestVictim: string | null = null;
    let maxResources = -1;

    for (const v of verts) {
      const b = this.buildings[v];
      if (b && b.owner !== botId) {
        const victimTotal = this.totalResources(this.players[b.owner]);
        if (victimTotal > 0 && victimTotal > maxResources) {
          maxResources = victimTotal;
          bestVictim = b.owner;
        }
      }
    }
    return bestVictim;
  }

  // ─────────────────────────────────────────
  //  UTILITY METHODS
  // ─────────────────────────────────────────

  private canAfford(p: Player, cost: Resources): boolean {
    return (Object.keys(cost) as ResourceType[]).every(r => p.resources[r] >= cost[r]);
  }

  private deductResources(p: Player, cost: Resources) {
    for (const r of Object.keys(cost) as ResourceType[]) {
      p.resources[r] -= cost[r];
    }
  }

  private totalResources(p: Player): number {
    return Object.values(p.resources).reduce((a, b) => a + b, 0);
  }

  public playerName(userId: string): string {
    const idx = this.playerOrder.indexOf(userId);
    const p = this.players[userId];
    if (p && p.username) return p.isBot ? `🤖 ${p.username}` : p.username;
    return `Player ${idx + 1}`;
  }

  public addLog(msg: string) {
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
  }

  getSetupInfo() {
    if (this.phase !== 'SETUP_R1' && this.phase !== 'SETUP_R2') return null;
    return {
      currentPlayer: this.getSetupCurrentPlayer(),
      expectedAction: this.getSetupExpectedAction(),
    };
  }

  getState() {
    return {
      snapshotVersion: GAME_SNAPSHOT_VERSION,
      phase: this.phase,
      turnPhase: this.turnPhase,
      setupTurnIndex: this.setupTurnIndex,
      players: this.players,
      playerOrder: this.playerOrder,
      currentTurnIndex: this.currentTurnIndex,
      diceResult: this.diceResult,
      dice1: this.dice1,
      dice2: this.dice2,
      rollCount: this.rollCount,
      lastDiceYields: this.lastDiceYields,
      buildings: this.buildings,
      roads: this.roads,
      robberHex: this.robberHex,
      playersWhoMustDiscard: this.playersWhoMustDiscard,
      devCardDeck: this.devCardDeck,
      devCardDeckSize: this.devCardDeck.length,
      longestRoadHolder: this.longestRoadHolder,
      longestRoadLength: this.longestRoadLength,
      largestArmyHolder: this.largestArmyHolder,
      largestArmySize: this.largestArmySize,
      activeTradeOffer: this.activeTradeOffer,
      log: this.log.slice(-100),
      winner: this.winner,
      setupInfo: this.getSetupInfo(),
      roadBuildingRemaining: this.roadBuildingRemaining,
      lastEvent: this.lastEvent,
      setupSettlements: this.setupSettlements,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      actionJournal: this.actionJournal,
    };
  }
}

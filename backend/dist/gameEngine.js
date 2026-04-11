"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameEngine = void 0;
// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════
const PIECE_LIMITS = { settlement: 5, city: 4, road: 15 };
const BUILD_COSTS = {
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
    city: { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 },
    road: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
    devCard: { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 },
};
const INITIAL_DEV_DECK = [
    ...Array(14).fill('knight'),
    ...Array(5).fill('victoryPoint'),
    ...Array(2).fill('yearOfPlenty'),
    ...Array(2).fill('monopoly'),
    ...Array(2).fill('roadBuilding'),
];
const RESOURCE_FROM_HEX = {
    forest: 'wood', hill: 'brick', pasture: 'sheep', field: 'wheat', mountain: 'ore', desert: null,
};
// ═══════════════════════════════════════════════════════════
//  GEOMETRY — Shared between Server & Frontend
// ═══════════════════════════════════════════════════════════
const HEX_WIDTH = 200;
const SIZE = 115.47;
const getPixelPos = (q, r) => ({
    x: HEX_WIDTH * (q + r / 2),
    y: SIZE * 1.5 * r,
});
const getVerticesForHex = (cx, cy) => {
    const verts = [];
    for (let i = 0; i < 6; i++) {
        const angle_rad = Math.PI / 180 * (30 + 60 * i);
        verts.push(`${Math.round(cx + SIZE * Math.cos(angle_rad))},${Math.round(cy + SIZE * Math.sin(angle_rad))}`);
    }
    return verts;
};
// ═══════════════════════════════════════════════════════════
//  HELPER: Shuffle array in-place (Fisher-Yates)
// ═══════════════════════════════════════════════════════════
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
// ═══════════════════════════════════════════════════════════
//  GAME ENGINE
// ═══════════════════════════════════════════════════════════
class GameEngine {
    // Phase tracking
    phase = 'SETUP_R1';
    turnPhase = 'FREE_ACTION'; // Setup doesn't need dice roll
    setupTurnIndex = 0; // Tracks position in snake order
    // Players
    players = {};
    playerOrder = [];
    currentTurnIndex = 0;
    // Dice
    diceResult = null;
    dice1 = 0;
    dice2 = 0;
    // Board pieces
    buildings = {}; // vertexId → Building
    roads = {}; // edgeId → userId
    // Robber
    robberHex = '0,0'; // q,r of hex with robber (starts on desert)
    playersWhoMustDiscard = [];
    // Development cards
    devCardDeck = [];
    // Longest Road & Largest Army tracking
    longestRoadHolder = null;
    longestRoadLength = 0;
    largestArmyHolder = null;
    largestArmySize = 0;
    // Trade
    activeTradeOffer = null;
    // Board reference
    board = [];
    ports = [];
    adjacencyMap = {}; // Vertex ID -> Array of Neighbor Vertex IDs
    // Track order of setup placements to ensure resources are given correctly
    setupSettlements = [];
    // Game log
    log = [];
    // Winner
    winner = null;
    // Road building dev card state
    roadBuildingRemaining = 0;
    // ─────────────────────────────────────────
    //  INIT & HYDRATION
    // ─────────────────────────────────────────
    setBoard(board, ports = []) {
        this.board = board;
        this.ports = ports;
        // Build adjacency map
        this.adjacencyMap = {};
        board.forEach(hex => {
            const { x, y } = getPixelPos(hex.q, hex.r);
            const verts = getVerticesForHex(x, y);
            for (let i = 0; i < 6; i++) {
                const v1 = verts[i];
                const v2 = verts[(i + 1) % 6];
                if (!this.adjacencyMap[v1])
                    this.adjacencyMap[v1] = [];
                if (!this.adjacencyMap[v2])
                    this.adjacencyMap[v2] = [];
                if (!this.adjacencyMap[v1].includes(v2))
                    this.adjacencyMap[v1].push(v2);
                if (!this.adjacencyMap[v2].includes(v1))
                    this.adjacencyMap[v2].push(v1);
            }
        });
        // Place robber on desert
        const desert = board.find(h => h.type === 'desert');
        if (desert)
            this.robberHex = `${desert.q},${desert.r}`;
        // Init dev deck
        this.devCardDeck = shuffle([...INITIAL_DEV_DECK]);
    }
    setState(state) {
        Object.assign(this, state);
    }
    addPlayer(userId, isBot = false) {
        if (this.players[userId])
            return null;
        if (this.playerOrder.length >= 4)
            return 'Game is full (max 4 players)';
        if (this.phase !== 'SETUP_R1' || this.setupTurnIndex > 0)
            return 'Game already started';
        const colors = ['#ef4444', '#3b82f6', '#22c55e', '#f97316'];
        this.players[userId] = {
            id: userId,
            color: colors[this.playerOrder.length],
            resources: { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 },
            score: 0,
            devCards: [],
            knightsPlayed: 0,
            hasPlayedDevCardThisTurn: false,
            isBot,
        };
        this.playerOrder.push(userId);
        return null;
    }
    // ─────────────────────────────────────────
    //  SETUP PHASE LOGIC
    // ─────────────────────────────────────────
    getSetupCurrentPlayer() {
        const n = this.playerOrder.length;
        if (this.phase === 'SETUP_R1') {
            return this.playerOrder[this.setupTurnIndex];
        }
        // SETUP_R2: reverse order (snake draft)
        return this.playerOrder[n - 1 - this.setupTurnIndex];
    }
    getSetupExpectedAction() {
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
    advanceSetup() {
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
                }
                else {
                    // Setup complete! Give initial resources from 2nd settlement
                    this.giveInitialResources();
                    this.phase = 'MAIN_GAME';
                    this.turnPhase = 'MUST_ROLL';
                    this.currentTurnIndex = 0;
                    this.addLog('🎮 Main game begins! Player 1 rolls first.');
                }
            }
        }
    }
    giveInitialResources() {
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
    placeSettlement(userId, vertexId) {
        const p = this.players[userId];
        if (!p)
            return 'Player not found';
        // Already occupied?
        if (this.buildings[vertexId])
            return 'Vertex already occupied';
        // STRICT Distance rule: no settlement on any neighboring vertex
        const neighbors = this.adjacencyMap[vertexId] || [];
        for (const neighborId of neighbors) {
            if (this.buildings[neighborId])
                return 'Too close to another building (Distance Rule)';
        }
        // ── Setup Phase ──
        if (this.phase === 'SETUP_R1' || this.phase === 'SETUP_R2') {
            if (this.getSetupCurrentPlayer() !== userId)
                return 'Not your turn in setup';
            if (this.getSetupExpectedAction() !== 'settlement')
                return 'Place a road first';
            this.buildings[vertexId] = { owner: userId, type: 'settlement' };
            this.setupSettlements.push({ playerId: userId, vertexId });
            p.score += 1;
            this.addLog(`${this.playerName(userId)} placed a settlement (setup)`);
            // Don't advance setup yet — road must be placed next
            return null;
        }
        // ── Main Game ──
        if (this.phase !== 'MAIN_GAME')
            return 'Cannot build right now';
        if (this.turnPhase !== 'FREE_ACTION')
            return 'Roll dice first';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        // Piece limit
        const settlementCount = Object.values(this.buildings).filter(b => b.owner === userId && b.type === 'settlement').length;
        if (settlementCount >= PIECE_LIMITS.settlement)
            return 'Max settlements reached (5)';
        // Must be connected to your road
        const hasConnectingRoad = Object.entries(this.roads).some(([edgeId, ownerId]) => {
            if (ownerId !== userId)
                return false;
            return edgeId.split(':').includes(vertexId);
        });
        if (!hasConnectingRoad)
            return 'Must be connected to your road network';
        // Cost check
        const cost = BUILD_COSTS.settlement;
        if (!this.canAfford(p, cost))
            return 'Not enough resources (need: 🪵🧱🐑🌾)';
        this.deductResources(p, cost);
        this.buildings[vertexId] = { owner: userId, type: 'settlement' };
        p.score += 1;
        this.addLog(`${this.playerName(userId)} built a settlement`);
        this.recalcLongestRoad();
        this.checkVictory(userId);
        return null;
    }
    // ─────────────────────────────────────────
    //  PLACE ROAD
    // ─────────────────────────────────────────
    placeRoad(userId, edgeId) {
        const p = this.players[userId];
        if (!p)
            return 'Player not found';
        if (this.roads[edgeId])
            return 'Road already built here';
        const [vA, vB] = edgeId.split(':');
        // Connection check: Must touch your settlement or your road
        const hasConnectingBuilding = this.buildings[vA]?.owner === userId || this.buildings[vB]?.owner === userId;
        const hasConnectingRoad = Object.entries(this.roads).some(([id, ownerId]) => {
            if (ownerId !== userId)
                return false;
            const [oA, oB] = id.split(':');
            return oA === vA || oA === vB || oB === vA || oB === vB;
        });
        if (!hasConnectingBuilding && !hasConnectingRoad)
            return 'Must connect to your network';
        // ── Setup Phase ──
        if (this.phase === 'SETUP_R1' || this.phase === 'SETUP_R2') {
            if (this.getSetupCurrentPlayer() !== userId)
                return 'Not your turn in setup';
            if (this.getSetupExpectedAction() !== 'road')
                return 'Must place a settlement first';
            // Rule: In setup, road must connect to the settlement JUST placed
            const playerPlacements = this.setupSettlements.filter(s => s.playerId === userId);
            const lastSettlement = playerPlacements[playerPlacements.length - 1].vertexId;
            if (vA !== lastSettlement && vB !== lastSettlement) {
                return 'In setup, road must connect to the settlement you just placed';
            }
            this.roads[edgeId] = userId;
            this.addLog(`${this.playerName(userId)} placed starting road`);
            this.advanceSetup();
            return null;
        }
        // ── Main Game ──
        if (this.phase !== 'MAIN_GAME')
            return 'Cannot build right now';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        // Road Building dev card active?
        if (this.roadBuildingRemaining > 0) {
            this.roads[edgeId] = userId;
            this.roadBuildingRemaining--;
            this.addLog(`${this.playerName(userId)} built a free road (Road Building)`);
            this.recalcLongestRoad();
            this.checkVictory(userId);
            return null;
        }
        if (this.turnPhase !== 'FREE_ACTION')
            return 'Roll dice first';
        // Piece limit
        const roadCount = Object.values(this.roads).filter(v => v === userId).length;
        if (roadCount >= PIECE_LIMITS.road)
            return 'Max roads reached (15)';
        // Cost
        const cost = BUILD_COSTS.road;
        if (!this.canAfford(p, cost))
            return 'Not enough resources (need: 🪵🧱)';
        this.deductResources(p, cost);
        this.roads[edgeId] = userId;
        this.addLog(`${this.playerName(userId)} built a road`);
        this.recalcLongestRoad();
        this.checkVictory(userId);
        return null;
    }
    // ─────────────────────────────────────────
    //  UPGRADE TO CITY
    // ─────────────────────────────────────────
    upgradeToCity(userId, vertexId) {
        if (this.phase !== 'MAIN_GAME')
            return 'Cannot build right now';
        if (this.turnPhase !== 'FREE_ACTION')
            return 'Roll dice first';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        const building = this.buildings[vertexId];
        if (!building || building.owner !== userId)
            return 'Not your settlement';
        if (building.type === 'city')
            return 'Already a city';
        const p = this.players[userId];
        const cityCount = Object.values(this.buildings).filter(b => b.owner === userId && b.type === 'city').length;
        if (cityCount >= PIECE_LIMITS.city)
            return 'Max cities reached (4)';
        const cost = BUILD_COSTS.city;
        if (!this.canAfford(p, cost))
            return 'Not enough resources (need: 🌾🌾🪨🪨🪨)';
        this.deductResources(p, cost);
        building.type = 'city';
        p.score += 1; // was 1VP as settlement, now 2VP as city → net +1
        this.addLog(`${this.playerName(userId)} upgraded to a city`);
        this.checkVictory(userId);
        return null;
    }
    // ─────────────────────────────────────────
    //  ROLL DICE
    // ─────────────────────────────────────────
    rollDice(userId) {
        if (this.phase !== 'MAIN_GAME')
            return 'Game not in main phase';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        if (this.turnPhase !== 'MUST_ROLL')
            return 'Already rolled this turn';
        this.dice1 = Math.floor(Math.random() * 6) + 1;
        this.dice2 = Math.floor(Math.random() * 6) + 1;
        this.diceResult = this.dice1 + this.dice2;
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
            }
            else {
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
    distributeResources(roll) {
        this.board.forEach(hex => {
            if (hex.number !== roll)
                return;
            // Skip hex with robber
            if (`${hex.q},${hex.r}` === this.robberHex)
                return;
            const res = RESOURCE_FROM_HEX[hex.type];
            if (!res)
                return;
            const { x, y } = getPixelPos(hex.q, hex.r);
            const verts = getVerticesForHex(x, y);
            verts.forEach(vid => {
                const building = this.buildings[vid];
                if (building && this.players[building.owner]) {
                    const amount = building.type === 'city' ? 2 : 1;
                    this.players[building.owner].resources[res] += amount;
                }
            });
        });
    }
    // ─────────────────────────────────────────
    //  ROBBER
    // ─────────────────────────────────────────
    robberDiscard(userId, discarded) {
        if (this.turnPhase !== 'ROBBER_DISCARD')
            return 'Not in discard phase';
        if (!this.playersWhoMustDiscard.includes(userId))
            return 'You don\'t need to discard';
        const p = this.players[userId];
        const total = this.totalResources(p);
        const mustDiscard = Math.floor(total / 2);
        let discardTotal = 0;
        for (const [res, amount] of Object.entries(discarded)) {
            if (amount && amount > 0) {
                const r = res;
                if (p.resources[r] < amount)
                    return `Not enough ${res} to discard`;
                discardTotal += amount;
            }
        }
        if (discardTotal !== mustDiscard)
            return `Must discard exactly ${mustDiscard} cards (you chose ${discardTotal})`;
        // Execute discard
        for (const [res, amount] of Object.entries(discarded)) {
            if (amount && amount > 0) {
                p.resources[res] -= amount;
            }
        }
        this.playersWhoMustDiscard = this.playersWhoMustDiscard.filter(id => id !== userId);
        this.addLog(`${this.playerName(userId)} discarded ${discardTotal} cards`);
        if (this.playersWhoMustDiscard.length === 0) {
            this.turnPhase = 'ROBBER_MOVE';
            this.addLog('All players discarded. Move the robber!');
        }
        return null;
    }
    moveRobber(userId, hexCoord, stealFromPlayer) {
        if (this.turnPhase !== 'ROBBER_MOVE')
            return 'Not in robber move phase';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        if (hexCoord === this.robberHex)
            return 'Must move robber to a different hex';
        // Validate hex exists
        const [q, r] = hexCoord.split(',').map(Number);
        const targetHex = this.board.find(h => h.q === q && h.r === r);
        if (!targetHex)
            return 'Invalid hex';
        this.robberHex = hexCoord;
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
                        this.addLog(`${this.playerName(userId)} stole 1 card from ${this.playerName(stealFromPlayer)}`);
                    }
                }
            }
        }
        this.turnPhase = 'FREE_ACTION';
        return null;
    }
    stealRandomResource(victim) {
        const available = [];
        for (const [res, amount] of Object.entries(victim.resources)) {
            for (let i = 0; i < amount; i++)
                available.push(res);
        }
        if (available.length === 0)
            return null;
        const stolen = available[Math.floor(Math.random() * available.length)];
        victim.resources[stolen] -= 1;
        return stolen;
    }
    // ─────────────────────────────────────────
    //  END TURN
    // ─────────────────────────────────────────
    endTurn(userId) {
        if (this.phase !== 'MAIN_GAME')
            return 'Game not in main phase';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        if (this.turnPhase === 'MUST_ROLL')
            return 'Must roll dice before ending turn';
        if (this.turnPhase === 'ROBBER_DISCARD' || this.turnPhase === 'ROBBER_MOVE')
            return 'Must resolve robber first';
        this.currentTurnIndex = (this.currentTurnIndex + 1) % this.playerOrder.length;
        this.diceResult = null;
        this.turnPhase = 'MUST_ROLL';
        this.roadBuildingRemaining = 0;
        // Reset dev card played flag
        const nextPlayer = this.players[this.playerOrder[this.currentTurnIndex]];
        if (nextPlayer)
            nextPlayer.hasPlayedDevCardThisTurn = false;
        // Unmark "bought this turn" on previous player's cards
        this.players[userId].devCards.forEach(c => { c.boughtThisTurn = false; });
        this.addLog(`${this.playerName(userId)} ended their turn`);
        return null;
    }
    // ─────────────────────────────────────────
    //  DEVELOPMENT CARDS
    // ─────────────────────────────────────────
    buyDevCard(userId) {
        if (this.phase !== 'MAIN_GAME')
            return 'Game not in main phase';
        if (this.turnPhase !== 'FREE_ACTION')
            return 'Roll dice first';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        const p = this.players[userId];
        if (this.devCardDeck.length === 0)
            return 'No dev cards left in deck';
        const cost = BUILD_COSTS.devCard;
        if (!this.canAfford(p, cost))
            return 'Not enough resources (need: 🐑🌾🪨)';
        this.deductResources(p, cost);
        const cardType = this.devCardDeck.pop();
        p.devCards.push({ type: cardType, boughtThisTurn: true });
        this.addLog(`${this.playerName(userId)} bought a development card`);
        if (cardType === 'victoryPoint') {
            this.checkVictory(userId);
        }
        return null;
    }
    playDevCard(userId, cardIndex, payload) {
        if (this.phase !== 'MAIN_GAME')
            return 'Game not in main phase';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        const p = this.players[userId];
        if (cardIndex < 0 || cardIndex >= p.devCards.length)
            return 'Invalid card index';
        const card = p.devCards[cardIndex];
        if (card.boughtThisTurn)
            return 'Cannot play a card bought this turn';
        if (card.type === 'victoryPoint')
            return 'Victory Point cards are passive';
        if (p.hasPlayedDevCardThisTurn)
            return 'Already played a dev card this turn';
        p.hasPlayedDevCardThisTurn = true;
        switch (card.type) {
            case 'knight': {
                // Knight: move robber (similar to rolling 7 but no discard)
                p.knightsPlayed++;
                this.addLog(`${this.playerName(userId)} played a Knight (${p.knightsPlayed} total)`);
                this.recalcLargestArmy();
                // Set phase to ROBBER_MOVE (skip discard)
                this.turnPhase = 'ROBBER_MOVE';
                p.devCards.splice(cardIndex, 1);
                this.checkVictory(userId);
                return null;
            }
            case 'yearOfPlenty': {
                // Take 2 free resources from bank
                if (!payload?.res1 || !payload?.res2)
                    return 'Must specify 2 resources';
                p.resources[payload.res1] += 1;
                p.resources[payload.res2] += 1;
                this.addLog(`${this.playerName(userId)} played Year of Plenty (${payload.res1}, ${payload.res2})`);
                p.devCards.splice(cardIndex, 1);
                return null;
            }
            case 'monopoly': {
                // Take ALL of one resource type from ALL other players
                if (!payload?.resource)
                    return 'Must specify resource type';
                const res = payload.resource;
                let stolen = 0;
                for (const otherId of this.playerOrder) {
                    if (otherId === userId)
                        continue;
                    const other = this.players[otherId];
                    stolen += other.resources[res];
                    other.resources[res] = 0;
                }
                p.resources[res] += stolen;
                this.addLog(`${this.playerName(userId)} played Monopoly on ${res} → stole ${stolen}`);
                p.devCards.splice(cardIndex, 1);
                return null;
            }
            case 'roadBuilding': {
                // Place 2 free roads
                this.roadBuildingRemaining = 2;
                this.addLog(`${this.playerName(userId)} played Road Building`);
                p.devCards.splice(cardIndex, 1);
                return null;
            }
        }
        return 'Unknown card type';
    }
    // ─────────────────────────────────────────
    //  BANK TRADE (4:1 or Port Rate)
    // ─────────────────────────────────────────
    bankTrade(userId, offerRes, requestRes) {
        if (this.phase !== 'MAIN_GAME')
            return 'Game not in main phase';
        if (this.turnPhase !== 'FREE_ACTION')
            return 'Roll dice first';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        const p = this.players[userId];
        const offer = offerRes;
        const request = requestRes;
        // Determine rate based on ports
        let rate = 4;
        // Check ports
        const myBuildingVertices = Object.keys(this.buildings).filter(v => this.buildings[v].owner === userId);
        for (const port of this.ports) {
            const hasAccess = port.vertices.some(pv => myBuildingVertices.includes(pv));
            if (hasAccess) {
                if (port.type === 'generic' && rate > 3)
                    rate = 3;
                if (port.type === offer && rate > 2)
                    rate = 2;
            }
        }
        if (p.resources[offer] < rate)
            return `Not enough ${offerRes} (need ${rate} for this port/bank)`;
        p.resources[offer] -= rate;
        p.resources[request] += 1;
        this.addLog(`${this.playerName(userId)} traded ${rate} ${offerRes} → 1 ${requestRes}`);
        return null;
    }
    // ─────────────────────────────────────────
    //  PLAYER-TO-PLAYER TRADE
    // ─────────────────────────────────────────
    proposeTrade(userId, offering, requesting) {
        if (this.phase !== 'MAIN_GAME')
            return 'Game not in main phase';
        if (this.turnPhase !== 'FREE_ACTION')
            return 'Roll dice first';
        if (this.playerOrder[this.currentTurnIndex] !== userId)
            return 'Not your turn';
        const p = this.players[userId];
        // Verify player has the offered resources
        for (const [res, amount] of Object.entries(offering)) {
            if (amount && p.resources[res] < amount)
                return `Not enough ${res}`;
        }
        this.activeTradeOffer = { fromPlayer: userId, offering, requesting };
        this.addLog(`${this.playerName(userId)} proposed a trade`);
        return null;
    }
    acceptTrade(userId) {
        if (!this.activeTradeOffer)
            return 'No active trade offer';
        if (userId === this.activeTradeOffer.fromPlayer)
            return 'Cannot accept your own trade';
        const accepter = this.players[userId];
        const proposer = this.players[this.activeTradeOffer.fromPlayer];
        // Check accepter has the requested resources
        for (const [res, amount] of Object.entries(this.activeTradeOffer.requesting)) {
            if (amount && accepter.resources[res] < amount)
                return `Not enough ${res}`;
        }
        // Execute trade
        for (const [res, amount] of Object.entries(this.activeTradeOffer.offering)) {
            if (amount) {
                proposer.resources[res] -= amount;
                accepter.resources[res] += amount;
            }
        }
        for (const [res, amount] of Object.entries(this.activeTradeOffer.requesting)) {
            if (amount) {
                accepter.resources[res] -= amount;
                proposer.resources[res] += amount;
            }
        }
        this.addLog(`${this.playerName(userId)} accepted trade from ${this.playerName(this.activeTradeOffer.fromPlayer)}`);
        this.activeTradeOffer = null;
        return null;
    }
    rejectTrade(userId) {
        this.activeTradeOffer = null;
        return null;
    }
    // ─────────────────────────────────────────
    //  LONGEST ROAD (DFS)
    // ─────────────────────────────────────────
    recalcLongestRoad() {
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
        }
        else {
            this.longestRoadLength = newLength;
        }
    }
    calcLongestRoadForPlayer(playerId) {
        // Build adjacency list from this player's roads
        const adj = {};
        for (const [edgeId, owner] of Object.entries(this.roads)) {
            if (owner !== playerId)
                continue;
            const [a, b] = edgeId.split(':');
            if (!adj[a])
                adj[a] = [];
            if (!adj[b])
                adj[b] = [];
            adj[a].push(b);
            adj[b].push(a);
        }
        const vertices = Object.keys(adj);
        if (vertices.length === 0)
            return 0;
        let maxLength = 0;
        for (const start of vertices) {
            const visited = new Set();
            maxLength = Math.max(maxLength, this.dfsRoad(start, visited, adj, playerId));
        }
        return maxLength;
    }
    dfsRoad(node, visited, adj, playerId) {
        let max = 0;
        for (const neighbor of (adj[node] || [])) {
            const edgeKey = [node, neighbor].sort().join(':');
            if (visited.has(edgeKey))
                continue;
            // Road is blocked by opponent's settlement/city
            const building = this.buildings[neighbor];
            if (building && building.owner !== playerId)
                continue;
            visited.add(edgeKey);
            max = Math.max(max, 1 + this.dfsRoad(neighbor, visited, adj, playerId));
            visited.delete(edgeKey);
        }
        return max;
    }
    // ─────────────────────────────────────────
    //  LARGEST ARMY
    // ─────────────────────────────────────────
    recalcLargestArmy() {
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
    checkVictory(userId) {
        const p = this.players[userId];
        let vp = p.score; // Buildings VP
        if (this.longestRoadHolder === userId)
            vp += 2;
        if (this.largestArmyHolder === userId)
            vp += 2;
        vp += p.devCards.filter(c => c.type === 'victoryPoint').length;
        if (vp >= 10) {
            this.phase = 'GAME_OVER';
            this.winner = userId;
            this.addLog(`🏆 ${this.playerName(userId)} WINS with ${vp} Victory Points!`);
        }
    }
    // ─────────────────────────────────────────
    //  BOT LOGIC (THE INQUISITOR)
    // ─────────────────────────────────────────
    executeBotSetup(botId) {
        const action = this.getSetupExpectedAction();
        if (action === 'settlement') {
            const bestVertex = this.getBestVertexForBot(botId);
            if (bestVertex)
                this.placeSettlement(botId, bestVertex);
        }
        else {
            const bestEdge = this.getBestEdgeForBot(botId);
            if (bestEdge)
                this.placeRoad(botId, bestEdge);
        }
    }
    executeBotTurn(botId) {
        if (this.turnPhase === 'MUST_ROLL') {
            this.rollDice(botId);
        }
        else if (this.turnPhase === 'ROBBER_DISCARD') {
            const p = this.players[botId];
            const total = this.totalResources(p);
            const mustDiscard = Math.floor(total / 2);
            const discarded = {};
            let count = 0;
            const resTypes = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
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
            if (this.playersWhoMustDiscard.length === 0)
                this.turnPhase = 'ROBBER_MOVE';
        }
        else if (this.turnPhase === 'ROBBER_MOVE') {
            const bestHex = this.getBestRobberHexForBot(botId);
            const victim = this.getVictimAtHex(bestHex, botId);
            this.moveRobber(botId, bestHex, victim);
        }
        else if (this.turnPhase === 'FREE_ACTION') {
            // Greedily build what we can
            let builtSomething = true;
            let limit = 0;
            while (builtSomething && limit < 10) {
                limit++;
                builtSomething = false;
                // 1. Upgrade to city
                const mySettlements = Object.entries(this.buildings).filter(([_, b]) => b.owner === botId && b.type === 'settlement');
                for (const [vid] of mySettlements) {
                    if (this.upgradeToCity(botId, vid) === null) {
                        builtSomething = true;
                        break;
                    }
                }
                if (builtSomething)
                    continue;
                // 2. Build settlement
                const bestVertex = this.getBestVertexForBot(botId);
                if (bestVertex && this.placeSettlement(botId, bestVertex) === null) {
                    builtSomething = true;
                    continue;
                }
                // 3. Build road
                const bestEdge = this.getBestEdgeForBot(botId);
                if (bestEdge && this.placeRoad(botId, bestEdge) === null) {
                    builtSomething = true;
                    continue;
                }
                // 4. Bank trade if needed for settlement
                if (this.totalResources(this.players[botId]) >= 4) {
                    const p = this.players[botId];
                    const needed = ['wood', 'brick', 'sheep', 'wheat'];
                    const missing = needed.find(r => p.resources[r] === 0);
                    const surplus = ['wood', 'brick', 'sheep', 'wheat', 'ore'].find(r => p.resources[r] >= 4);
                    if (missing && surplus) {
                        if (this.bankTrade(botId, surplus, missing) === null) {
                            builtSomething = true;
                            continue;
                        }
                    }
                }
                // 5. Buy dev card
                if (this.buyDevCard(botId) === null) {
                    builtSomething = true;
                    continue;
                }
                // 6. Play Dev Cards (Knight, Year of Plenty)
                this.playBotDevCards(botId);
            }
            this.endTurn(botId);
        }
    }
    playBotDevCards(botId) {
        const p = this.players[botId];
        if (p.devCards.length === 0)
            return;
        // 1. Play Knight if robber blocks a high-yield hex
        const knightIndex = p.devCards.findIndex(c => c.type === 'knight' && !c.boughtThisTurn);
        if (knightIndex !== -1) {
            const yieldScore = this.board.find(h => `${h.q},${h.r}` === this.robberHex && this.isBotAffectedByRobber(botId));
            if (yieldScore) {
                const bestHex = this.getBestRobberHexForBot(botId);
                const victim = this.getVictimAtHex(bestHex, botId);
                this.playDevCard(botId, knightIndex, { hexCoord: bestHex, victimId: victim || undefined });
                return; // Only 1 card per turn
            }
        }
        // 2. Year of Plenty if exactly 2 resources away from a Settlement
        const yopIndex = p.devCards.findIndex(c => c.type === 'yearOfPlenty' && !c.boughtThisTurn);
        if (yopIndex !== -1) {
            // Basic check: do we have at least 2 resources but missing others?
            const total = this.totalResources(p);
            if (total >= 2 && total < 4) {
                this.playDevCard(botId, yopIndex, { res1: 'wood', res2: 'brick' });
            }
        }
    }
    isBotAffectedByRobber(botId) {
        const { x, y } = getPixelPos(this.board.find(h => `${h.q},${h.r}` === this.robberHex).q, this.board.find(h => `${h.q},${h.r}` === this.robberHex).r);
        return getVerticesForHex(x, y).some(v => this.buildings[v]?.owner === botId);
    }
    getBestVertexForBot(botId) {
        const vertexScores = {};
        const playerResources = new Set();
        // Check what resources the bot already has access to
        Object.values(this.buildings).forEach(b => {
            if (b.owner === botId) {
                this.board.forEach(hex => {
                    const { x, y } = getPixelPos(hex.q, hex.r);
                    if (getVerticesForHex(x, y).includes(Object.keys(this.buildings).find(k => this.buildings[k] === b))) {
                        playerResources.add(hex.type);
                    }
                });
            }
        });
        this.board.forEach(hex => {
            const { x, y } = getPixelPos(hex.q, hex.r);
            const verts = getVerticesForHex(x, y);
            const dots = hex.number ? (6 - Math.abs(7 - hex.number)) : 0;
            if (hex.type === 'desert')
                return;
            verts.forEach(vId => {
                if (this.buildings[vId])
                    return;
                // Base score = dots (probability)
                let score = dots;
                // Bonus for resource diversity
                if (!playerResources.has(hex.type)) {
                    score += 2; // Value diversification at start
                }
                // STRICT Distance rule check
                const neighbors = this.adjacencyMap[vId] || [];
                const tooClose = neighbors.some(nId => this.buildings[nId]);
                if (tooClose) {
                    score = -10000;
                }
                // Connection check (if in main game)
                if (this.phase === 'MAIN_GAME') {
                    const connected = Object.entries(this.roads).some(([eid, owner]) => owner === botId && eid.split(':').includes(vId));
                    if (!connected)
                        return;
                }
                vertexScores[vId] = (vertexScores[vId] || 0) + score;
            });
        });
        const entries = Object.entries(vertexScores).filter(e => e[1] > -5000).sort((a, b) => b[1] - a[1]);
        return entries.length > 0 ? entries[0][0] : null;
    }
    getBestEdgeForBot(botId) {
        const possibleEdges = [];
        this.board.forEach(hex => {
            const { x, y } = getPixelPos(hex.q, hex.r);
            const verts = getVerticesForHex(x, y);
            verts.forEach((v1, i, arr) => {
                const v2 = arr[(i + 1) % 6];
                const eid = [v1, v2].sort().join(':');
                if (!this.roads[eid]) {
                    const connected = (this.buildings[v1]?.owner === botId || this.buildings[v2]?.owner === botId) ||
                        Object.entries(this.roads).some(([rid, rOwner]) => rOwner === botId && (rid.split(':').includes(v1) || rid.split(':').includes(v2)));
                    if (connected)
                        possibleEdges.push(eid);
                }
            });
        });
        if (possibleEdges.length === 0)
            return null;
        return possibleEdges[Math.floor(Math.random() * possibleEdges.length)];
    }
    getBestRobberHexForBot(botId) {
        let bestHex = this.robberHex;
        let maxScore = -1;
        this.board.forEach(hex => {
            const hc = `${hex.q},${hex.r}`;
            if (hc === this.robberHex || hex.type === 'desert')
                return;
            let score = 0;
            const { x, y } = getPixelPos(hex.q, hex.r);
            getVerticesForHex(x, y).forEach(v => {
                const b = this.buildings[v];
                if (b && b.owner !== botId)
                    score += (b.type === 'city' ? 2 : 1);
            });
            if (score > maxScore) {
                maxScore = score;
                bestHex = hc;
            }
        });
        return bestHex;
    }
    getVictimAtHex(hexCoord, botId) {
        const [q, r] = hexCoord.split(',').map(Number);
        const { x, y } = getPixelPos(q, r);
        const verts = getVerticesForHex(x, y);
        let bestVictim = null;
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
    canAfford(p, cost) {
        return Object.keys(cost).every(r => p.resources[r] >= cost[r]);
    }
    deductResources(p, cost) {
        for (const r of Object.keys(cost)) {
            p.resources[r] -= cost[r];
        }
    }
    totalResources(p) {
        return Object.values(p.resources).reduce((a, b) => a + b, 0);
    }
    playerName(userId) {
        const idx = this.playerOrder.indexOf(userId);
        const p = this.players[userId];
        return p ? (p.isBot ? `🤖 ${userId.substring(0, 5)}` : `Player ${idx + 1}`) : `Player ${idx + 1}`;
    }
    addLog(msg) {
        this.log.push(msg);
        if (this.log.length > 100)
            this.log.shift();
    }
    getSetupInfo() {
        if (this.phase !== 'SETUP_R1' && this.phase !== 'SETUP_R2')
            return null;
        return {
            currentPlayer: this.getSetupCurrentPlayer(),
            expectedAction: this.getSetupExpectedAction(),
        };
    }
    getState() {
        return {
            phase: this.phase,
            turnPhase: this.turnPhase,
            setupTurnIndex: this.setupTurnIndex,
            players: this.players,
            playerOrder: this.playerOrder,
            currentTurnIndex: this.currentTurnIndex,
            diceResult: this.diceResult,
            dice1: this.dice1,
            dice2: this.dice2,
            buildings: this.buildings,
            roads: this.roads,
            robberHex: this.robberHex,
            playersWhoMustDiscard: this.playersWhoMustDiscard,
            devCardDeckSize: this.devCardDeck.length,
            longestRoadHolder: this.longestRoadHolder,
            longestRoadLength: this.longestRoadLength,
            largestArmyHolder: this.largestArmyHolder,
            largestArmySize: this.largestArmySize,
            activeTradeOffer: this.activeTradeOffer,
            log: this.log.slice(-20),
            winner: this.winner,
            setupInfo: this.getSetupInfo(),
            roadBuildingRemaining: this.roadBuildingRemaining,
        };
    }
}
exports.GameEngine = GameEngine;

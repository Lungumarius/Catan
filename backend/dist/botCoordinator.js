"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotCoordinator = void 0;
const gameEngine_1 = require("./gameEngine");
class BotCoordinator {
    performSetup(engine, botId) {
        const setupInfo = engine.getSetupInfo();
        if (!setupInfo)
            return;
        if (setupInfo.expectedAction === 'settlement') {
            const vertexId = this.chooseBestSettlementVertex(engine, botId);
            if (vertexId)
                engine.placeSettlement(botId, vertexId);
            return;
        }
        const placements = engine.setupSettlements.filter((placement) => placement.playerId === botId);
        const anchorVertex = placements[placements.length - 1]?.vertexId ?? null;
        const edgeId = this.chooseBestRoadEdge(engine, botId, anchorVertex);
        if (edgeId)
            engine.placeRoad(botId, edgeId);
    }
    performTurn(engine, botId) {
        if (engine.turnPhase === 'MUST_ROLL') {
            engine.rollDice(botId);
            if (engine.phase === 'GAME_OVER')
                return;
        }
        if (engine.turnPhase === 'ROBBER_DISCARD') {
            this.handleDiscard(engine, botId);
            return;
        }
        if (engine.turnPhase === 'ROBBER_MOVE') {
            const bestHex = this.chooseBestRobberHex(engine, botId);
            const victim = bestHex ? this.chooseVictimAtHex(engine, bestHex, botId) : null;
            if (bestHex)
                engine.moveRobber(botId, bestHex, victim);
            if (engine.phase === 'GAME_OVER')
                return;
        }
        if (engine.turnPhase !== 'FREE_ACTION')
            return;
        this.playDevCard(engine, botId);
        let builtSomething = true;
        let limit = 0;
        while (builtSomething && limit < 12 && engine.phase !== 'GAME_OVER') {
            limit++;
            builtSomething = false;
            const settlementVertex = this.findUpgradeableSettlement(engine, botId);
            if (settlementVertex && engine.upgradeToCity(botId, settlementVertex) === null) {
                builtSomething = true;
                continue;
            }
            const bestSettlement = this.chooseBestSettlementVertex(engine, botId);
            if (bestSettlement && engine.placeSettlement(botId, bestSettlement) === null) {
                builtSomething = true;
                continue;
            }
            const bestRoad = this.chooseBestRoadEdge(engine, botId);
            if (bestRoad && engine.placeRoad(botId, bestRoad) === null) {
                builtSomething = true;
                continue;
            }
            const trade = this.suggestBankTrade(engine, botId);
            if (trade && engine.bankTrade(botId, trade.offer, trade.request) === null) {
                builtSomething = true;
                continue;
            }
            if (engine.buyDevCard(botId) === null) {
                builtSomething = true;
                continue;
            }
            const offer = this.suggestPlayerTrade(engine, botId);
            if (offer && engine.proposeTrade(botId, offer.offering, offer.requesting) === null) {
                engine.evaluateBotsForTrade(botId);
                builtSomething = !engine.activeTradeOffer;
            }
        }
        if (engine.phase !== 'GAME_OVER')
            engine.endTurn(botId);
    }
    handleDiscard(engine, botId) {
        const player = engine.players[botId];
        const totalCards = Object.values(player.resources).reduce((sum, amount) => sum + amount, 0);
        const mustDiscard = Math.floor(totalCards / 2);
        const discarded = {};
        let remaining = mustDiscard;
        const resourcePriority = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
        for (const resource of resourcePriority) {
            while (remaining > 0 && player.resources[resource] - (discarded[resource] || 0) > 0) {
                discarded[resource] = (discarded[resource] || 0) + 1;
                remaining--;
                if (remaining === 0)
                    break;
            }
        }
        engine.robberDiscard(botId, discarded);
    }
    playDevCard(engine, botId) {
        const player = engine.players[botId];
        if (player.hasPlayedDevCardThisTurn)
            return;
        const knightIndex = player.devCards.findIndex((card) => card.type === 'knight' && !card.boughtThisTurn);
        if (knightIndex !== -1) {
            const bestHex = this.chooseBestRobberHex(engine, botId);
            const victim = bestHex ? this.chooseVictimAtHex(engine, bestHex, botId) : null;
            if (bestHex && engine.playDevCard(botId, knightIndex) === null) {
                engine.moveRobber(botId, bestHex, victim);
                return;
            }
        }
        const monopolyIndex = player.devCards.findIndex((card) => card.type === 'monopoly' && !card.boughtThisTurn);
        if (monopolyIndex !== -1) {
            const resource = this.getMostScarceNeededResource(engine, botId);
            if (resource) {
                engine.playDevCard(botId, monopolyIndex, { resource });
                return;
            }
        }
        const yearOfPlentyIndex = player.devCards.findIndex((card) => card.type === 'yearOfPlenty' && !card.boughtThisTurn);
        if (yearOfPlentyIndex !== -1) {
            const wanted = this.getWantedResources(engine, botId);
            engine.playDevCard(botId, yearOfPlentyIndex, {
                res1: wanted[0] || 'wheat',
                res2: wanted[1] || wanted[0] || 'ore',
            });
            return;
        }
    }
    chooseBestSettlementVertex(engine, botId) {
        const scores = new Map();
        for (const hex of engine.board) {
            if (hex.type === 'desert')
                continue;
            const { x, y } = (0, gameEngine_1.getPixelPos)(hex.q, hex.r);
            const vertices = (0, gameEngine_1.getVerticesForHex)(x, y);
            const dots = hex.number ? 6 - Math.abs(7 - hex.number) : 0;
            for (const vertexId of vertices) {
                if (engine.buildings[vertexId])
                    continue;
                const neighbors = engine.adjacencyMap[vertexId] || [];
                if (neighbors.some((neighborId) => engine.buildings[neighborId]))
                    continue;
                if (engine.phase === 'MAIN_GAME') {
                    const connected = Object.entries(engine.roads).some(([edgeId, ownerId]) => {
                        if (ownerId !== botId)
                            return false;
                        return edgeId.split(':').includes(vertexId);
                    });
                    if (!connected)
                        continue;
                }
                scores.set(vertexId, (scores.get(vertexId) || 0) + dots);
            }
        }
        return Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    chooseBestRoadEdge(engine, botId, anchorVertex) {
        const scored = [];
        for (const hex of engine.board) {
            const { x, y } = (0, gameEngine_1.getPixelPos)(hex.q, hex.r);
            const vertices = (0, gameEngine_1.getVerticesForHex)(x, y);
            vertices.forEach((vertexA, index) => {
                const vertexB = vertices[(index + 1) % vertices.length];
                const edgeId = [vertexA, vertexB].sort().join(':');
                if (engine.roads[edgeId])
                    return;
                if (anchorVertex) {
                    if (vertexA !== anchorVertex && vertexB !== anchorVertex)
                        return;
                }
                else {
                    const connectsToOwnBuilding = engine.buildings[vertexA]?.owner === botId || engine.buildings[vertexB]?.owner === botId;
                    const connectsToOwnRoad = Object.entries(engine.roads).some(([existingEdgeId, ownerId]) => {
                        if (ownerId !== botId)
                            return false;
                        const [existingA, existingB] = existingEdgeId.split(':');
                        const sharesA = (existingA === vertexA || existingB === vertexA) && !(engine.buildings[vertexA] && engine.buildings[vertexA].owner !== botId);
                        const sharesB = (existingA === vertexB || existingB === vertexB) && !(engine.buildings[vertexB] && engine.buildings[vertexB].owner !== botId);
                        return sharesA || sharesB;
                    });
                    if (!connectsToOwnBuilding && !connectsToOwnRoad)
                        return;
                }
                let score = 1;
                const settlementVertex = this.chooseBestSettlementVertex(engine, botId);
                if (settlementVertex && (vertexA === settlementVertex || vertexB === settlementVertex))
                    score += 3;
                score += Math.random();
                scored.push({ edgeId, score });
            });
        }
        return scored.sort((a, b) => b.score - a.score)[0]?.edgeId ?? null;
    }
    chooseBestRobberHex(engine, botId) {
        let bestHex = null;
        let bestScore = -1;
        for (const hex of engine.board) {
            const hexCoord = `${hex.q},${hex.r}`;
            if (hexCoord === engine.robberHex || hex.type === 'desert')
                continue;
            const players = engine.getPlayersOnHex(hexCoord, botId);
            if (players.length === 0)
                continue;
            const score = players.reduce((total, playerId) => {
                const player = engine.players[playerId];
                const resources = Object.values(player.resources).reduce((sum, amount) => sum + amount, 0);
                return total + resources;
            }, 0);
            if (score > bestScore) {
                bestScore = score;
                bestHex = hexCoord;
            }
        }
        return bestHex;
    }
    chooseVictimAtHex(engine, hexCoord, botId) {
        const targets = engine.getPlayersOnHex(hexCoord, botId);
        return targets
            .sort((left, right) => {
            const leftResources = Object.values(engine.players[left].resources).reduce((sum, amount) => sum + amount, 0);
            const rightResources = Object.values(engine.players[right].resources).reduce((sum, amount) => sum + amount, 0);
            return rightResources - leftResources;
        })[0] || null;
    }
    findUpgradeableSettlement(engine, botId) {
        return Object.entries(engine.buildings).find(([, building]) => building.owner === botId && building.type === 'settlement')?.[0] ?? null;
    }
    getWantedResources(engine, botId) {
        const player = engine.players[botId];
        const wanted = [
            { resource: 'wheat', score: player.resources.wheat < 2 ? 4 : 1 },
            { resource: 'ore', score: player.resources.ore < 3 ? 4 : 1 },
            { resource: 'wood', score: player.resources.wood === 0 ? 3 : 0 },
            { resource: 'brick', score: player.resources.brick === 0 ? 3 : 0 },
            { resource: 'sheep', score: player.resources.sheep === 0 ? 2 : 0 },
        ];
        return wanted.sort((a, b) => b.score - a.score).map((entry) => entry.resource);
    }
    getMostScarceNeededResource(engine, botId) {
        return this.getWantedResources(engine, botId)[0] ?? null;
    }
    suggestBankTrade(engine, botId) {
        const wanted = this.getWantedResources(engine, botId);
        const player = engine.players[botId];
        const offer = ['wood', 'brick', 'sheep', 'wheat', 'ore'].find((resource) => player.resources[resource] >= 4);
        const request = wanted.find((resource) => resource !== offer && player.resources[resource] === 0);
        return offer && request ? { offer, request } : null;
    }
    suggestPlayerTrade(engine, botId) {
        const player = engine.players[botId];
        const offer = ['wood', 'brick', 'sheep', 'wheat', 'ore'].find((resource) => player.resources[resource] >= 3);
        const request = this.getWantedResources(engine, botId).find((resource) => resource !== offer);
        if (!offer || !request)
            return null;
        return {
            offering: { [offer]: 2 },
            requesting: { [request]: 1 },
        };
    }
}
exports.BotCoordinator = BotCoordinator;

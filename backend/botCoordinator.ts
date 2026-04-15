import { GameEngine, ResourceType, Resources, getPixelPos, getVerticesForHex } from './gameEngine';

const BOT_BUILD_COSTS: Record<string, Resources> = {
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
  city: { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 },
  road: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
  devCard: { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 },
};

export class BotCoordinator {
  performSetup(engine: GameEngine, botId: string) {
    const setupInfo = engine.getSetupInfo();
    if (!setupInfo) return;

    if (setupInfo.expectedAction === 'settlement') {
      const vertexId = this.chooseBestSettlementVertex(engine, botId);
      if (vertexId) engine.placeSettlement(botId, vertexId);
      return;
    }

    const placements = engine.setupSettlements.filter((placement) => placement.playerId === botId);
    const anchorVertex = placements[placements.length - 1]?.vertexId ?? null;
    const edgeId = this.chooseBestRoadEdge(engine, botId, anchorVertex);
    if (edgeId) engine.placeRoad(botId, edgeId);
  }

  performTurn(engine: GameEngine, botId: string) {
    if (engine.turnPhase === 'MUST_ROLL') {
      engine.rollDice(botId);
      if (engine.phase === 'GAME_OVER') return;
    }

    if (engine.turnPhase === 'ROBBER_DISCARD') {
      this.handleDiscard(engine, botId);
      return;
    }

    if (engine.turnPhase === 'ROBBER_MOVE') {
      const bestHex = this.chooseBestRobberHex(engine, botId);
      const victim = bestHex ? this.chooseVictimAtHex(engine, bestHex, botId) : null;
      if (bestHex) engine.moveRobber(botId, bestHex, victim);
      if (engine.phase === 'GAME_OVER') return;
    }

    if (engine.turnPhase === 'GOLD_CHOICE') {
      while ((engine.pendingGoldChoices[botId] || 0) > 0) {
        engine.chooseGoldResource(botId, this.getMostScarceNeededResource(engine, botId) || 'ore');
      }
      if ((engine.turnPhase as string) !== 'FREE_ACTION') return;
    }

    if (engine.turnPhase !== 'FREE_ACTION') return;

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

    if (engine.phase !== 'GAME_OVER') engine.endTurn(botId);
  }

  private handleDiscard(engine: GameEngine, botId: string) {
    const player = engine.players[botId];
    const totalCards = Object.values(player.resources).reduce((sum, amount) => sum + amount, 0);
    const mustDiscard = Math.floor(totalCards / 2);
    const discarded: Partial<Resources> = {};
    let remaining = mustDiscard;
    const resourcePriority: ResourceType[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

    for (const resource of resourcePriority) {
      while (remaining > 0 && player.resources[resource] - (discarded[resource] || 0) > 0) {
        discarded[resource] = (discarded[resource] || 0) + 1;
        remaining--;
        if (remaining === 0) break;
      }
    }

    engine.robberDiscard(botId, discarded);
  }

  private playDevCard(engine: GameEngine, botId: string) {
    const player = engine.players[botId];
    if (player.hasPlayedDevCardThisTurn) return;

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

  private chooseBestSettlementVertex(engine: GameEngine, botId: string) {
    const scores = new Map<string, number>();

    for (const hex of engine.board) {
      if (hex.type === 'desert') continue;
      const { x, y } = getPixelPos(hex.q, hex.r);
      const vertices = getVerticesForHex(x, y);
      const dots = hex.number ? 6 - Math.abs(7 - hex.number) : 0;

      for (const vertexId of vertices) {
        if (engine.buildings[vertexId]) continue;
        const neighbors = engine.adjacencyMap[vertexId] || [];
        if (neighbors.some((neighborId) => engine.buildings[neighborId])) continue;

        if (engine.phase === 'MAIN_GAME') {
          const connected = Object.entries(engine.roads).some(([edgeId, ownerId]) => {
            if (ownerId !== botId) return false;
            return edgeId.split(':').includes(vertexId);
          });
          if (!connected) continue;
        }

        scores.set(vertexId, (scores.get(vertexId) || 0) + dots);
      }
    }

    return Array.from(scores.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  private chooseBestRoadEdge(engine: GameEngine, botId: string, anchorVertex?: string | null) {
    const scored: Array<{ edgeId: string; score: number }> = [];

    for (const hex of engine.board) {
      const { x, y } = getPixelPos(hex.q, hex.r);
      const vertices = getVerticesForHex(x, y);

      vertices.forEach((vertexA, index) => {
        const vertexB = vertices[(index + 1) % vertices.length];
        const edgeId = [vertexA, vertexB].sort().join(':');
        if (engine.roads[edgeId]) return;

        if (anchorVertex) {
          if (vertexA !== anchorVertex && vertexB !== anchorVertex) return;
        } else {
          const connectsToOwnBuilding = engine.buildings[vertexA]?.owner === botId || engine.buildings[vertexB]?.owner === botId;
          const connectsToOwnRoad = Object.entries(engine.roads).some(([existingEdgeId, ownerId]) => {
            if (ownerId !== botId) return false;
            const [existingA, existingB] = existingEdgeId.split(':');
            const sharesA = (existingA === vertexA || existingB === vertexA) && !(engine.buildings[vertexA] && engine.buildings[vertexA].owner !== botId);
            const sharesB = (existingA === vertexB || existingB === vertexB) && !(engine.buildings[vertexB] && engine.buildings[vertexB].owner !== botId);
            return sharesA || sharesB;
          });
          if (!connectsToOwnBuilding && !connectsToOwnRoad) return;
        }

        let score = 1;
        const settlementVertex = this.chooseBestSettlementVertex(engine, botId);
        if (settlementVertex && (vertexA === settlementVertex || vertexB === settlementVertex)) score += 3;
        score += Math.random();
        scored.push({ edgeId, score });
      });
    }

    return scored.sort((a, b) => b.score - a.score)[0]?.edgeId ?? null;
  }

  private chooseBestRobberHex(engine: GameEngine, botId: string) {
    let bestHex: string | null = null;
    let bestScore = -1;

    for (const hex of engine.board) {
      const hexCoord = `${hex.q},${hex.r}`;
      if (hexCoord === engine.robberHex || hex.type === 'desert') continue;

      const players = engine.getPlayersOnHex(hexCoord, botId);
      if (players.length === 0) continue;

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

  private chooseVictimAtHex(engine: GameEngine, hexCoord: string, botId: string) {
    const targets = engine.getPlayersOnHex(hexCoord, botId);
    return targets
      .sort((left, right) => {
        const leftResources = Object.values(engine.players[left].resources).reduce((sum, amount) => sum + amount, 0);
        const rightResources = Object.values(engine.players[right].resources).reduce((sum, amount) => sum + amount, 0);
        return rightResources - leftResources;
      })[0] || null;
  }

  private findUpgradeableSettlement(engine: GameEngine, botId: string) {
    return Object.entries(engine.buildings).find(([, building]) => building.owner === botId && building.type === 'settlement')?.[0] ?? null;
  }

  private getWantedResources(engine: GameEngine, botId: string): ResourceType[] {
    const player = engine.players[botId];
    const resources: ResourceType[] = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
    const currentPlanScore = this.planScore(player.resources);
    const wanted = resources.map((resource) => {
      const nextResources = { ...player.resources, [resource]: player.resources[resource] + 1 };
      return {
        resource,
        score: this.resourceNeedValue(player.resources, resource) + Math.max(0, this.planScore(nextResources) - currentPlanScore),
      };
    });

    return wanted
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.resource);
  }

  private getMostScarceNeededResource(engine: GameEngine, botId: string) {
    return this.getWantedResources(engine, botId)[0] ?? null;
  }

  private suggestBankTrade(engine: GameEngine, botId: string) {
    const wanted = this.getWantedResources(engine, botId);
    const player = engine.players[botId];
    const offer = (['wood', 'brick', 'sheep', 'wheat', 'ore'] as ResourceType[]).find((resource) => player.resources[resource] >= 4);
    const request = wanted.find((resource) => resource !== offer && player.resources[resource] === 0);
    return offer && request ? { offer, request } : null;
  }

  private suggestPlayerTrade(engine: GameEngine, botId: string): { offering: Partial<Resources>; requesting: Partial<Resources> } | null {
    const player = engine.players[botId];
    const wanted = this.getWantedResources(engine, botId);
    const surplus = (['wood', 'brick', 'sheep', 'wheat', 'ore'] as ResourceType[])
      .filter((resource) => player.resources[resource] >= 3)
      .sort((left, right) => this.resourceNeedValue(player.resources, left) - this.resourceNeedValue(player.resources, right));
    const offer = surplus[0];
    const request = wanted.find((resource) =>
      resource !== offer
      && this.resourceNeedValue(player.resources, resource) > this.resourceNeedValue(player.resources, offer) + 0.75
      && engine.playerOrder.some((pid) => pid !== botId && engine.players[pid].resources[resource] > 0)
    );
    if (!offer || !request) return null;
    return {
      offering: { [offer]: 2 },
      requesting: { [request]: 1 },
    };
  }

  private planScore(resources: Resources): number {
    let score = 0;
    if (this.canAfford(resources, BOT_BUILD_COSTS.city)) score += 12;
    if (this.canAfford(resources, BOT_BUILD_COSTS.settlement)) score += 9;
    if (this.canAfford(resources, BOT_BUILD_COSTS.devCard)) score += 5;
    if (this.canAfford(resources, BOT_BUILD_COSTS.road)) score += 4;
    return score;
  }

  private canAfford(resources: Resources, cost: Resources): boolean {
    return (Object.keys(cost) as ResourceType[]).every((resource) => resources[resource] >= cost[resource]);
  }

  private resourceNeedValue(resources: Resources, resource: ResourceType): number {
    const buildPlans: Array<{ cost: Resources; weight: number }> = [
      { cost: BOT_BUILD_COSTS.city, weight: 7 },
      { cost: BOT_BUILD_COSTS.settlement, weight: 5 },
      { cost: BOT_BUILD_COSTS.devCard, weight: 3 },
      { cost: BOT_BUILD_COSTS.road, weight: 2 },
    ];

    let value = 0;
    for (const plan of buildPlans) {
      const missingForResource = plan.cost[resource] - resources[resource];
      if (missingForResource <= 0) continue;
      const missingTotal = (Object.keys(plan.cost) as ResourceType[])
        .reduce((sum, res) => sum + Math.max(0, plan.cost[res] - resources[res]), 0);
      value += plan.weight / Math.max(1, missingTotal);
    }
    value += Math.max(0, 2 - resources[resource]) * 0.35;
    return value;
  }
}

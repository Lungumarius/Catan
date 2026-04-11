const HEX_COUNTS = {
  desert: 1,
  forest: 4,
  pasture: 4,
  field: 4,
  hill: 3,
  mountain: 3
};

const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

export interface HexagonState {
  q: number;
  r: number;
  type: string;
  number: number | null;
}

export type PortType = 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore' | 'generic';

export interface Port {
  id: string;
  type: PortType;
  vertices: string[]; // Vertex IDs "x,y"
  q: number; // For rendering positioning (near this water hex)
  r: number;
}

// ═══════════════════════════════════════════════════════════
//  GEOMETRY HELPERS (Shared with Engine)
// ═══════════════════════════════════════════════════════════
const HEX_WIDTH = 200;
const SIZE = 115.47;
const getPixelPos = (q: number, r: number) => ({ x: HEX_WIDTH * (q + r / 2), y: SIZE * 1.5 * r });
const getVerticesForHex = (cx: number, cy: number): string[] => {
  const verts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle_rad = Math.PI / 180 * (30 + 60 * i);
    verts.push(`${Math.round(cx + SIZE * Math.cos(angle_rad))},${Math.round(cy + SIZE * Math.sin(angle_rad))}`);
  }
  return verts;
};

export function generateBoard(): { hexes: HexagonState[], ports: Port[] } {
  const hexes: HexagonState[] = [];
  const terrainPool: string[] = [];

  for (const [type, count] of Object.entries(HEX_COUNTS)) {
    for (let i = 0; i < count; i++) {
        terrainPool.push(type);
    }
  }

  // Shuffle terrain
  terrainPool.sort(() => Math.random() - 0.5);

  // Shuffle number tokens
  const numberPool = [...NUMBER_TOKENS];
  numberPool.sort(() => Math.random() - 0.5);

  const radius = 2;
  let terrainIndex = 0;
  let numberIndex = 0;

  // Generate grid
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      const type = terrainPool[terrainIndex++];
      const number = type === 'desert' ? null : numberPool[numberIndex++];
      hexes.push({ q, r, type, number });
    }
  }

  // ─────────────────────────────────────────
  //  GENERATE PORTS (Fixed positions on edge)
  // ─────────────────────────────────────────
  const portTypes: PortType[] = ['generic', 'wood', 'generic', 'brick', 'generic', 'sheep', 'generic', 'wheat', 'ore'];
  const portConfigs = [
    { q: -2, r: 0, vIdx: [4, 5], type: 'generic' as PortType },
    { q: -1, r: -1, vIdx: [5, 0], type: 'wood' as PortType },
    { q: 1, r: -2, vIdx: [0, 1], type: 'generic' as PortType },
    { q: 2, r: -2, vIdx: [1, 2], type: 'brick' as PortType },
    { q: 2, r: -1, vIdx: [1, 2], type: 'generic' as PortType },
    { q: 1, r: 1, vIdx: [2, 3], type: 'sheep' as PortType },
    { q: 0, r: 2, vIdx: [2, 3], type: 'generic' as PortType },
    { q: -2, r: 2, vIdx: [3, 4], type: 'wheat' as PortType },
    { q: -2, r: 1, vIdx: [4, 5], type: 'ore' as PortType },
  ];

  const ports: Port[] = portConfigs.map((config, i) => {
    const { x, y } = getPixelPos(config.q, config.r);
    const hexVerts = getVerticesForHex(x, y);
    return {
      id: `port-${i}`,
      type: config.type,
      vertices: [hexVerts[config.vIdx[0]], hexVerts[config.vIdx[1]]],
      q: config.q,
      r: config.r
    };
  });

  return { hexes, ports };
}


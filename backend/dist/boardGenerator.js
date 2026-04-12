"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBoard = generateBoard;
const HEX_COUNTS = {
    desert: 1,
    forest: 4,
    pasture: 4,
    field: 4,
    hill: 3,
    mountain: 3
};
const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
// Official Catan spiral order (clockwise from top-left edge, spiraling inward)
const SPIRAL_COORDS = [
    [0, -2], [1, -2], [2, -2],
    [2, -1], [2, 0],
    [1, 1], [0, 2], [-1, 2],
    [-2, 2], [-2, 1], [-2, 0],
    [-1, -1], [0, -1], [1, -1],
    [1, 0], [0, 1], [-1, 1],
    [-1, 0], [0, 0]
];
// ═══════════════════════════════════════════════════════════
//  GEOMETRY HELPERS (Shared with Engine)
// ═══════════════════════════════════════════════════════════
const HEX_WIDTH = 200;
const SIZE = 115.47;
const getPixelPos = (q, r) => ({ x: HEX_WIDTH * (q + r / 2), y: SIZE * 1.5 * r });
const getVerticesForHex = (cx, cy) => {
    const verts = [];
    for (let i = 0; i < 6; i++) {
        const angle_rad = Math.PI / 180 * (30 + 60 * i);
        verts.push(`${Math.round(cx + SIZE * Math.cos(angle_rad))},${Math.round(cy + SIZE * Math.sin(angle_rad))}`);
    }
    return verts;
};
// ═══════════════════════════════════════════════════════════
//  HEX ADJACENCY (for balancing constraints)
// ═══════════════════════════════════════════════════════════
const HEX_DIRECTIONS = [
    [1, 0], [1, -1], [0, -1],
    [-1, 0], [-1, 1], [0, 1]
];
function getHexNeighborCoords(q, r) {
    return HEX_DIRECTIONS.map(([dq, dr]) => `${q + dq},${r + dr}`);
}
// ═══════════════════════════════════════════════════════════
//  BALANCED BOARD GENERATION
// ═══════════════════════════════════════════════════════════
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function isHighProbNumber(n) {
    return n === 6 || n === 8;
}
/**
 * Check if placing the given number at hexIndex violates the "no 6-8 adjacent" rule.
 */
function violates68Rule(hexes, hexIndex, numberVal) {
    if (!isHighProbNumber(numberVal))
        return false;
    const hex = hexes[hexIndex];
    const neighborCoords = getHexNeighborCoords(hex.q, hex.r);
    for (const nc of neighborCoords) {
        const neighbor = hexes.find(h => `${h.q},${h.r}` === nc);
        if (neighbor && isHighProbNumber(neighbor.number)) {
            return true;
        }
    }
    return false;
}
/**
 * Check if placing the given terrain type at hexIndex creates 3+ adjacent same-type cluster.
 */
function violatesResourceCluster(hexes, hexIndex, terrainType) {
    if (terrainType === 'desert')
        return false;
    const hex = hexes[hexIndex];
    const neighborCoords = getHexNeighborCoords(hex.q, hex.r);
    // Count same-type neighbors
    let sameTypeNeighbors = 0;
    for (const nc of neighborCoords) {
        const neighbor = hexes.find(h => `${h.q},${h.r}` === nc);
        if (neighbor && neighbor.type === terrainType) {
            sameTypeNeighbors++;
        }
    }
    // Allow max 1 same-type neighbor (so max 2 touching = ok, 3+ = bad)
    return sameTypeNeighbors >= 2;
}
/**
 * Generate a balanced terrain layout with max attempts.
 */
function generateBalancedTerrain(coords) {
    const MAX_ATTEMPTS = 200;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const terrainPool = [];
        for (const [type, count] of Object.entries(HEX_COUNTS)) {
            for (let i = 0; i < count; i++)
                terrainPool.push(type);
        }
        const shuffled = shuffle(terrainPool);
        const hexes = coords.map(([q, r], i) => ({
            q, r, type: shuffled[i], number: null,
        }));
        // Validate resource clustering
        let valid = true;
        for (let i = 0; i < hexes.length; i++) {
            if (violatesResourceCluster(hexes, i, hexes[i].type)) {
                valid = false;
                break;
            }
        }
        if (valid)
            return hexes;
    }
    // Fallback: return last attempt anyway
    const terrainPool = [];
    for (const [type, count] of Object.entries(HEX_COUNTS)) {
        for (let i = 0; i < count; i++)
            terrainPool.push(type);
    }
    return coords.map(([q, r], i) => ({
        q, r, type: shuffle(terrainPool)[i], number: null,
    }));
}
/**
 * Assign numbers using spiral order, enforcing the no-6-8-adjacent rule.
 * Uses a swap-based approach: if placing a number would violate the rule,
 * swap it with a future number that doesn't violate.
 */
function assignBalancedNumbers(hexes) {
    // Find the desert index
    const desertIdx = hexes.findIndex(h => h.type === 'desert');
    // Build spiral-ordered indices (excluding desert)
    const spiralIndices = [];
    for (const [sq, sr] of SPIRAL_COORDS) {
        const idx = hexes.findIndex(h => h.q === sq && h.r === sr);
        if (idx !== -1 && idx !== desertIdx)
            spiralIndices.push(idx);
    }
    // Shuffle the number tokens
    let numbers = shuffle([...NUMBER_TOKENS]);
    const MAX_RETRIES = 100;
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
        // Try assigning in spiral order
        let valid = true;
        // Reset all numbers
        hexes.forEach(h => h.number = null);
        for (let i = 0; i < spiralIndices.length; i++) {
            const hexIdx = spiralIndices[i];
            const num = numbers[i];
            hexes[hexIdx].number = num;
            if (violates68Rule(hexes, hexIdx, num)) {
                // Try to swap with a later number
                let swapped = false;
                for (let j = i + 1; j < numbers.length; j++) {
                    // Temporarily swap
                    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
                    hexes[hexIdx].number = numbers[i];
                    if (!violates68Rule(hexes, hexIdx, numbers[i])) {
                        swapped = true;
                        break;
                    }
                    // Swap back
                    [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
                    hexes[hexIdx].number = num;
                }
                if (!swapped) {
                    valid = false;
                    break;
                }
            }
        }
        if (valid)
            return;
        numbers = shuffle([...NUMBER_TOKENS]);
    }
    // Fallback: assign whatever we have
    hexes.forEach(h => h.number = null);
    let ni = 0;
    for (const idx of spiralIndices) {
        hexes[idx].number = numbers[ni++];
    }
}
// ═══════════════════════════════════════════════════════════
//  MAIN GENERATOR
// ═══════════════════════════════════════════════════════════
function generateBoard() {
    // Generate hex coordinates
    const radius = 2;
    const coords = [];
    for (let q = -radius; q <= radius; q++) {
        const r1 = Math.max(-radius, -q - radius);
        const r2 = Math.min(radius, -q + radius);
        for (let r = r1; r <= r2; r++) {
            coords.push([q, r]);
        }
    }
    // Step 1: Balanced terrain placement
    const hexes = generateBalancedTerrain(coords);
    // Step 2: Balanced number assignment (spiral + no-6-8-adjacent)
    assignBalancedNumbers(hexes);
    // ─────────────────────────────────────────
    //  GENERATE PORTS (Fixed positions on edge)
    // ─────────────────────────────────────────
    const portConfigs = [
        { q: -2, r: 0, vIdx: [4, 5], type: 'generic' },
        { q: -1, r: -1, vIdx: [5, 0], type: 'wood' },
        { q: 1, r: -2, vIdx: [0, 1], type: 'generic' },
        { q: 2, r: -2, vIdx: [1, 2], type: 'brick' },
        { q: 2, r: -1, vIdx: [1, 2], type: 'generic' },
        { q: 1, r: 1, vIdx: [2, 3], type: 'sheep' },
        { q: 0, r: 2, vIdx: [2, 3], type: 'generic' },
        { q: -2, r: 2, vIdx: [3, 4], type: 'wheat' },
        { q: -2, r: 1, vIdx: [4, 5], type: 'ore' },
    ];
    const ports = portConfigs.map((config, i) => {
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

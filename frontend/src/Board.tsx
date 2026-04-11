import { motion } from 'framer-motion';
import { type GameState } from './App';

export interface HexData {
  q: number; r: number; type: string; number: number | null;
}

export interface PortData {
  id: string;
  type: 'wood' | 'brick' | 'sheep' | 'wheat' | 'ore' | 'generic';
  vertices: string[];
  q: number;
  r: number;
}

interface BoardProps {
  hexes: HexData[];
  ports: PortData[];
  gameState: GameState | null;
  onVertexClick: (vertexId: string) => void;
  onEdgeClick: (edgeId: string) => void;
  onHexClick: (hexCoord: string) => void;
  robberHex: string | null;
  buildMode: 'settlement' | 'road' | 'city' | null;
  setupHighlight: string | null; // 'settlement' | 'road' | null
}

const HEX_WIDTH = 200;
const SIZE = 115.47;

const PORT_RES: Record<string, string> = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨', generic: '❓' };

export function Board({ hexes, ports, gameState, onVertexClick, onEdgeClick, onHexClick, robberHex, buildMode, setupHighlight }: BoardProps) {
  const getPixelPos = (q: number, r: number) => ({
    x: HEX_WIDTH * (q + r / 2),
    y: SIZE * 1.5 * r,
  });

  const getVerticesForHex = (cx: number, cy: number) => {
    const verts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (30 + 60 * i);
      verts.push({ id: `${Math.round(cx + SIZE * Math.cos(a))},${Math.round(cy + SIZE * Math.sin(a))}`, x: cx + SIZE * Math.cos(a), y: cy + SIZE * Math.sin(a) });
    }
    return verts;
  };

  const allVertices: Record<string, { id: string; x: number; y: number }> = {};
  const edgesMap = new Map<string, { id: string; x: number; y: number; angle: number }>();

  hexes.forEach(hex => {
    const { x, y } = getPixelPos(hex.q, hex.r);
    const corners = getVerticesForHex(x, y);
    corners.forEach(c => allVertices[c.id] = c);
    for (let i = 0; i < 6; i++) {
      const c1 = corners[i], c2 = corners[(i + 1) % 6];
      const eid = [c1.id, c2.id].sort().join(':');
      if (!edgesMap.has(eid)) {
        edgesMap.set(eid, {
          id: eid, x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2,
          angle: Math.atan2(c2.y - c1.y, c2.x - c1.x) * (180 / Math.PI),
        });
      }
    }
  });

  const isRobberMove = gameState?.turnPhase === 'ROBBER_MOVE';
  const showVertexHover = buildMode === 'settlement' || buildMode === 'city' || setupHighlight === 'settlement';
  const showEdgeHover = buildMode === 'road' || (gameState?.roadBuildingRemaining ?? 0) > 0 || setupHighlight === 'road';

  return (
    <div className="board-wrapper">
      <div className="board-inner">
        {/* PORTS */}
        {ports?.map(port => {
          const { x, y } = getPixelPos(port.q, port.r);
          // Offset the port icon slightly outwards from the hex center
          const angle = Math.atan2(y, x);
          const dist = SIZE * 1.1;
          const px = x + Math.cos(angle) * dist;
          const py = y + Math.sin(angle) * dist;

          return (
            <div key={port.id} className="port-badge" style={{ position: 'absolute', left: `calc(50% + ${px}px)`, top: `calc(50% + ${py}px)`, transform: 'translate(-50%, -50%)' }}>
              <div className="port-icon">{PORT_RES[port.type]}</div>
              <div className="port-rate">{port.type === 'generic' ? '3:1' : '2:1'}</div>
              {/* Connection lines to vertices */}
              {port.vertices.map(vid => {
                const v = allVertices[vid];
                if (!v) return null;
                return (
                  <div key={vid} className="port-line" style={{
                    position: 'absolute',
                    top: '50%', left: '50%',
                    width: Math.hypot(v.x - px, v.y - py),
                    transform: `rotate(${Math.atan2(v.y - py, v.x - px) * 180 / Math.PI}deg)`,
                    transformOrigin: '0 50%'
                  }} />
                );
              })}
            </div>
          );
        })}

        {/* HEXAGONS */}
        {hexes.map((hex, idx) => {
          const { x, y } = getPixelPos(hex.q, hex.r);
          const hc = `${hex.q},${hex.r}`;
          const hasRobber = hc === robberHex;

          return (
            <div key={hc} style={{ position: 'absolute', left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }}>
              <motion.div
                className={`hexagon ${hex.type} ${isRobberMove ? 'hex-clickable' : ''}`}
                style={{ position: 'absolute', marginLeft: '-98px', marginTop: '-113px', cursor: isRobberMove ? 'pointer' : 'default' }}
                initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: idx * 0.025, type: 'spring', bounce: 0.25 }}
                onClick={() => isRobberMove && onHexClick(hc)}>
                {hex.number && <div className={`token ${hex.number === 6 || hex.number === 8 ? 'high-prob' : ''}`}>{hex.number}</div>}
                {hasRobber && <div className="robber-icon">🏴‍☠️</div>}
              </motion.div>
            </div>
          );
        })}

        {/* EDGES */}
        {Array.from(edgesMap.values()).map(edge => {
          const ownerId = gameState?.roads?.[edge.id];
          const ownerColor = ownerId ? gameState?.players[ownerId]?.color : null;

          let classes = 'road-edge';
          if (ownerId) classes += ' built';
          if (showEdgeHover && !ownerId) classes += ' road-hover';
          if (setupHighlight === 'road' && !ownerId) classes += ' setup-highlight';

          return (
            <div key={edge.id} style={{ position: 'absolute', left: `calc(50% + ${edge.x}px)`, top: `calc(50% + ${edge.y}px)` }}>
              <div className={classes}
                style={{ transform: `translate(-50%, -50%) rotate(${edge.angle}deg)`, backgroundColor: ownerColor || 'transparent' }}
                onClick={() => onEdgeClick(edge.id)} />
            </div>
          );
        })}

        {/* VERTICES */}
        {Object.values(allVertices).map(v => {
          const bld = gameState?.buildings?.[v.id];
          const color = bld ? gameState?.players[bld.owner]?.color : null;
          const isCity = bld?.type === 'city';
          const sz = isCity ? 28 : bld ? 22 : 14;

          let classes = 'vertex-point';
          if (bld) classes += isCity ? ' city' : ' settled';
          if (showVertexHover && !bld) classes += ' vertex-hover';
          if (setupHighlight === 'settlement' && !bld) classes += ' setup-highlight';

          return (
            <div key={v.id} style={{ position: 'absolute', left: `calc(50% + ${v.x}px)`, top: `calc(50% + ${v.y}px)` }}>
              <div className={classes}
                style={{
                  position: 'absolute',
                  marginLeft: -sz / 2, marginTop: -sz / 2,
                  width: sz, height: sz,
                  borderRadius: isCity ? '4px' : '50%',
                  backgroundColor: color || 'rgba(255,255,255,0.12)',
                }}
                onClick={() => onVertexClick(v.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

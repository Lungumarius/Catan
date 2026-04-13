import { motion } from 'framer-motion';
import { useRef, useEffect, useState } from 'react';
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
  setupHighlight: string | null;
  currentPlayerColor?: string;
}

const HEX_WIDTH = 200;
const SIZE = 115.47;

const PORT_RES: Record<string, string> = { wood: '🪵', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨', generic: '❓' };

// ═══════════════════════════════════════════════════════════
//  SVG PIECE COMPONENTS
// ═══════════════════════════════════════════════════════════

function SettlementSVG({ color, size = 36, ghost = false }: { color: string; size?: number; ghost?: boolean }) {
  const opacity = ghost ? 0.45 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" style={{ opacity, filter: ghost ? 'none' : 'drop-shadow(1px 3px 5px rgba(0,0,0,0.6))' }}>
      {/* 3D Base/Shadow */}
      <polygon points="20,4 36,16 36,36 4,36 4,16" fill={color} stroke="rgba(255,255,255,0.85)" strokeWidth="1.5" strokeLinejoin="round" />
      {/* Roof detail */}
      <polygon points="20,4 36,16 20,20 4,16" fill="rgba(255,255,255,0.25)" />
      {/* Wooden Door */}
      <path d="M16,36 L16,24 Q20,21 24,24 L24,36 Z" fill="rgba(60,30,10,0.6)" />
      {/* Door handle */}
      <circle cx="22" cy="30" r="1" fill="#d4a574" />
      {/* Circular Window */}
      <circle cx="20" cy="14" r="3" fill="rgba(255,240,160,0.8)" />
    </svg>
  );
}

function CitySVG({ color, size = 46, ghost = false }: { color: string; size?: number; ghost?: boolean }) {
  const opacity = ghost ? 0.45 : 1;
  return (
    <svg width={size} height={size} viewBox="0 0 50 50" style={{ opacity, filter: ghost ? 'none' : 'drop-shadow(1px 4px 6px rgba(0,0,0,0.7))' }}>
      {/* City Base */}
      <path d="M8,26 L42,26 L42,46 L8,46 Z" fill={color} stroke="rgba(255,255,255,0.9)" strokeWidth="1.5" strokeLinejoin="round" />
      {/* Main Tower */}
      <path d="M14,6 L26,0 L36,6 L36,26 L14,26 Z" fill={color} stroke="rgba(255,255,255,0.9)" strokeWidth="1.5" strokeLinejoin="round" />
      {/* Smaller side tower */}
      <path d="M36,16 L44,11 L48,16 L48,26 L36,26 Z" fill={color} stroke="rgba(255,255,255,0.7)" strokeWidth="1" strokeLinejoin="round" />
      
      {/* Shading / 3D depth */}
      <path d="M14,6 L26,0 L26,46 L8,46 L8,26 Z" fill="rgba(0,0,0,0.15)" />
      
      {/* Medieval Gate */}
      <path d="M20,46 L20,32 C20,28 30,28 30,32 L30,46 Z" fill="rgba(40,20,5,0.8)" />
      
      {/* Cathedral-style Windows */}
      <path d="M25,12 L22,12 L22,7 Q25,4 28,7 L28,12 Z" fill="rgba(255,240,160,0.85)" />
      <rect x="12" y="32" width="4" height="6" rx="1" fill="rgba(255,240,160,0.8)" />
      <rect x="34" y="32" width="4" height="6" rx="1" fill="rgba(255,240,160,0.8)" />
    </svg>
  );
}

function RoadSVG({ color, length, ghost = false }: { color: string; length: number; ghost?: boolean }) {
  const opacity = ghost ? 0.45 : 1;
  const h = 14;
  return (
    <svg width={length} height={h} viewBox={`0 0 ${length} ${h}`} style={{ opacity, filter: ghost ? 'none' : 'drop-shadow(1px 2px 3px rgba(0,0,0,0.6))', display: 'block' }}>
      <rect x="2" y="2" width={length - 4} height={h - 4} rx="3" fill={color} stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" />
      {/* Planks styling for Catan feel */}
      <line x1="12" y1="2" x2="12" y2={h-2} stroke="rgba(0,0,0,0.3)" strokeWidth="1.5" />
      <line x1={length/2} y1="2" x2={length/2} y2={h-2} stroke="rgba(0,0,0,0.3)" strokeWidth="1.5" />
      <line x1={length - 12} y1="2" x2={length - 12} y2={h-2} stroke="rgba(0,0,0,0.3)" strokeWidth="1.5" />
      <rect x="2" y="2" width={length - 4} height={h/2 - 2} rx="2" fill="rgba(255,255,255,0.2)" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
//  BOARD COMPONENT
// ═══════════════════════════════════════════════════════════

export function Board({ hexes, ports, gameState, onVertexClick, onEdgeClick, onHexClick, robberHex, buildMode, setupHighlight, currentPlayerColor }: BoardProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [hoveredVertex, setHoveredVertex] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

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

  // Auto-scale board to fit container
  useEffect(() => {
    function handleResize() {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const boardW = 1100;
      const boardH = 1000;
      const s = Math.min(cw / boardW, ch / boardH, 1.2);
      setScale(Math.max(s, 0.3));
    }
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const allVertices: Record<string, { id: string; x: number; y: number }> = {};
  const edgesMap = new Map<string, { id: string; x: number; y: number; angle: number; len: number }>();

  hexes.forEach(hex => {
    const { x, y } = getPixelPos(hex.q, hex.r);
    const corners = getVerticesForHex(x, y);
    corners.forEach(c => allVertices[c.id] = c);
    for (let i = 0; i < 6; i++) {
      const c1 = corners[i], c2 = corners[(i + 1) % 6];
      const eid = [c1.id, c2.id].sort().join(':');
      if (!edgesMap.has(eid)) {
        edgesMap.set(eid, {
          id: eid,
          x: (c1.x + c2.x) / 2,
          y: (c1.y + c2.y) / 2,
          angle: Math.atan2(c2.y - c1.y, c2.x - c1.x) * (180 / Math.PI),
          len: Math.hypot(c2.x - c1.x, c2.y - c1.y),
        });
      }
    }
  });

  const isRobberMove = gameState?.turnPhase === 'ROBBER_MOVE';
  const canPlaceSettlement = buildMode === 'settlement' || setupHighlight === 'settlement';
  const canPlaceCity = buildMode === 'city';
  const canPlaceRoad = buildMode === 'road' || (gameState?.roadBuildingRemaining ?? 0) > 0 || setupHighlight === 'road';
  const showVertexHover = canPlaceSettlement || canPlaceCity;
  const showEdgeHover = canPlaceRoad;
  const previewColor = currentPlayerColor || '#ffffff';

  return (
    <div className="board-wrapper" ref={containerRef}>
      <div className="board-inner" style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}>

        {/* OCEAN WATER BACKGROUND */}
        <div className="ocean-water" />

        {/* WOODEN BOARD FRAME */}
        <svg className="board-frame" viewBox="-620 -560 1240 1120" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="woodTexture" patternUnits="userSpaceOnUse" width="600" height="600">
              <image href="/assets/wood_texture.png" x="0" y="0" width="600" height="600" preserveAspectRatio="none" />
            </pattern>
            <filter id="darkenInner">
              <feColorMatrix type="matrix" values="0.6 0 0 0 0   0 0.6 0 0 0   0 0 0.6 0 0  0 0 0 1 0"/>
            </filter>
            <filter id="frameShadow">
              <feDropShadow dx="0" dy="6" stdDeviation="12" floodColor="#000" floodOpacity="0.5"/>
            </filter>
          </defs>
          {/* Solid wooden board tray base */}
          <polygon 
            points="620,0 310,537 -310,537 -620,0 -310,-537 310,-537"
            fill="url(#woodTexture)" stroke="#3a1a06" strokeWidth="8"
            filter="url(#frameShadow)"
          />
          {/* Corner ornaments */}
          <circle cx="620" cy="0" r="14" fill="#d4a853" stroke="#8B5E3C" strokeWidth="4" />
          <circle cx="310" cy="537" r="14" fill="#d4a853" stroke="#8B5E3C" strokeWidth="4" />
          <circle cx="-310" cy="537" r="14" fill="#d4a853" stroke="#8B5E3C" strokeWidth="4" />
          <circle cx="-620" cy="0" r="14" fill="#d4a853" stroke="#8B5E3C" strokeWidth="4" />
          <circle cx="-310" cy="-537" r="14" fill="#d4a853" stroke="#8B5E3C" strokeWidth="4" />
          <circle cx="310" cy="-537" r="14" fill="#d4a853" stroke="#8B5E3C" strokeWidth="4" />
        </svg>

        {/* PORTS */}
        {ports?.map(port => {
          if (!port.vertices || port.vertices.length < 2) return null;
          const v1 = allVertices[port.vertices[0]];
          const v2 = allVertices[port.vertices[1]];
          if (!v1 || !v2) return null;
          
          const mx = (v1.x + v2.x) / 2;
          const my = (v1.y + v2.y) / 2;

          // Vector of the edge itself
          const ex = v2.x - v1.x;
          const ey = v2.y - v1.y;
          
          // Calculate perpendicular normal vector (the exact normal of the flat hex edge)
          let nx = -ey;
          let ny = ex;
          
          // We want the normal vector that points OUTWARD from the center of the board
          if (nx * mx + ny * my < 0) {
            nx = -nx;
            ny = -ny;
          }
          
          // Get the precise angle of the normal vector (it will perfectly match the 30/90/150 deg angles of the hex)
          const angleRad = Math.atan2(ny, nx);
          
          // Push the dock directly away from the edge, exactly perpendicular
          const pushOut = 28; 
          const px = mx + Math.cos(angleRad) * pushOut;
          const py = my + Math.sin(angleRad) * pushOut;
          
          // Rotate dock so its top points into the water (away from center)
          const rotateAngle = (angleRad * 180) / Math.PI;

          return (
            <div key={port.id} className="port-dock" 
              style={{ 
                position: 'absolute', 
                left: `calc(50% + ${px}px)`, 
                top: `calc(50% + ${py}px)`, 
                // rotateAngle + 90 makes the CSS "top" (which is -90deg) point out to rotateAngle
                transform: `translate(-50%, -50%) rotate(${rotateAngle + 90}deg)`,
                zIndex: 20
              }}>
              <div style={{ transform: `rotate(${-(rotateAngle + 90)}deg)`, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div className="port-icon-ship">⛵</div>
                <div className="port-badge-new">
                  <span className="port-item">{PORT_RES[port.type]}</span>
                  <span className="port-rate">{port.type === 'generic' ? '3:1' : '2:1'}</span>
                </div>
              </div>
            </div>
          );
        })}

        {/* HEXAGONS */}
        {hexes.map((hex, idx) => {
          const { x, y } = getPixelPos(hex.q, hex.r);
          const hc = `${hex.q},${hex.r}`;
          const hasRobber = hc === robberHex;
          const dots = hex.number ? (6 - Math.abs(7 - hex.number)) : 0;

          return (
            <div key={hc} style={{ position: 'absolute', left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }}>
              <motion.div
                className={`hexagon ${hex.type} ${isRobberMove ? 'hex-clickable' : ''}`}
                style={{ position: 'absolute', marginLeft: '-98px', marginTop: '-113px', cursor: isRobberMove ? 'pointer' : 'default' }}
                initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: idx * 0.03, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
                onClick={() => isRobberMove && onHexClick(hc)}>
                {hex.number && (
                  <div className={`token ${hex.number === 6 || hex.number === 8 ? 'high-prob' : ''}`} style={{ position: 'relative', zIndex: 10 }}>
                    <span className="token-number">{hex.number}</span>
                    <span className="token-dots">{'•'.repeat(dots)}</span>
                  </div>
                )}
                {hasRobber && <div className="robber-icon" style={{ zIndex: 20 }}>🏴‍☠️</div>}
              </motion.div>
            </div>
          );
        })}

        {/* ROADS */}
        {Array.from(edgesMap.values()).map(edge => {
          const ownerId = gameState?.roads?.[edge.id];
          const ownerColor = ownerId ? gameState?.players[ownerId]?.color : null;
          const isHovered = hoveredEdge === edge.id;

          return (
            <div key={edge.id}
              className="road-wrapper"
              style={{
                left: `calc(50% + ${edge.x}px)`,
                top: `calc(50% + ${edge.y}px)`,
                transform: `translate(-50%, -50%) rotate(${edge.angle}deg)`,
              }}
              onMouseEnter={() => showEdgeHover && !ownerId && setHoveredEdge(edge.id)}
              onMouseLeave={() => setHoveredEdge(null)}
              onClick={() => onEdgeClick(edge.id)}>
              
              {ownerId && ownerColor ? (
                <motion.div
                  initial={{ scaleX: 0 }} animate={{ scaleX: 1 }}
                  transition={{ duration: 0.35, ease: [0.34, 1.56, 0.64, 1] }}>
                  <RoadSVG color={ownerColor} length={edge.len * 0.75} />
                </motion.div>
              ) : (
                <div style={{ position: 'relative' }} className={showEdgeHover || setupHighlight === 'road' ? 'road-visual road-hover' : ''}>
                  {/* Invisible hit-box area for hovering edges easier */}
                  <div style={{ width: edge.len * 0.6, height: 20, backgroundColor: 'transparent' }} />
                  
                  {isHovered && showEdgeHover && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                      <RoadSVG color={previewColor} length={edge.len * 0.75} ghost />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* VERTICES */}
        {Object.values(allVertices).map(v => {
          const bld = gameState?.buildings?.[v.id];
          const color = bld ? gameState?.players[bld.owner]?.color : null;
          const isCity = bld?.type === 'city';
          const isHovered = hoveredVertex === v.id;

          return (
            <div key={v.id}
              style={{
                position: 'absolute',
                left: `calc(50% + ${v.x}px)`,
                top: `calc(50% + ${v.y}px)`,
                transform: 'translate(-50%, -50%)',
                zIndex: bld ? 60 : 50,
                cursor: (showVertexHover || bld) ? 'pointer' : 'default',
              }}
              onMouseEnter={() => showVertexHover && !bld && setHoveredVertex(v.id)}
              onMouseLeave={() => setHoveredVertex(null)}
              onClick={() => onVertexClick(v.id)}>

              {/* Built piece */}
              {bld && color ? (
                <div style={{ position: 'absolute', transform: 'translate(-50%, -50%)' }}>
                  <motion.div
                    initial={{ scale: 0, y: -20 }} animate={{ scale: 1, y: 0 }}
                    transition={{ duration: 0.45, type: "spring", stiffness: 200, damping: 15 }}>
                    {isCity
                      ? <CitySVG color={color} size={46} />
                      : <SettlementSVG color={color} size={36} />
                    }
                  </motion.div>
                </div>
              ) : (
                <>
                  {/* Empty vertex dot */}
                  <div className={`vertex-dot ${showVertexHover ? 'hoverable' : ''} ${setupHighlight === 'settlement' ? 'setup-pulse' : ''}`} />

                  {/* Ghost piece preview on hover */}
                  {isHovered && canPlaceSettlement && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
                      <SettlementSVG color={previewColor} size={36} ghost />
                    </div>
                  )}
                  {isHovered && canPlaceCity && (
                    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
                      <CitySVG color={previewColor} size={46} ghost />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

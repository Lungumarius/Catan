# Catan Web - Changelog

Acest document va urmări progresul tehnic pentru proiectul Catan, creat pas cu pas, păstrând contextul pentru sesiunile viitoare.

## [Visual Overhaul] - 2026-04-12
### Changed
- **Balanced Board Generation:** Rewrote `boardGenerator.ts` with spiral number placement, no-6-8-adjacent constraint, and max-2-same-type-adjacent rule. Boards are now tournament-fair.
- **Ocean Theme:** Replaced dark cyber background with warm ocean gradient (turquoise → deep blue). Added breathing ocean ring animation around the island.
- **Classic Catan Pieces (SVG):** Settlements are now house-shaped SVGs with roofs, cities are castles with towers. All pieces animate in with spring physics on placement.
- **Roads:** Thicker, bordered, with white edge glow. Animated scaleX on placement.
- **Number Tokens:** Now show probability dots (•••) under the number, with red styling for 6/8.
- **Hover Effects:** Changed from cold blue to warm gold for vertex/road highlights and setup pulse.
- **Fullscreen Mode:** Added ⛶ toggle button + keyboard shortcut (F to toggle, Esc to exit). Hides sidebar and top-bar for immersive play.
- **Board Auto-Scale:** Board now dynamically scales to fit the container. No more clipped hexagons at edges.

## [Production Ready] - 2026-04-12
### Added
- **Strict Rules Engine (Graph Model):** Refactored the entire collision/distance logic to use a mathematical adjacency map. No more settlement overlaps; rules are now tournament-compliant.
- **Maritime Trade (Ports):** Implemented full port logic (2:1 for specific resources, 3:1 generic) with visual connectors on the board.
- **Advanced Bot AI ("The Strategist"):**
    - NPC logic now evaluates intersections based on resource yield (dots/probability) and variety.
    - Smart Robber targeting: Bots now move the robber to block the leader and steal from the wealthiest target.
    - Dev Card Mastery: Bots now play Knights tactically and use Year of Plenty for critical builds.
    - UI Feedback: Added "Bot is thinking..." pulsing indicator for a more immersive feel.
- **Lobby Redesign & Security:**
    - **Room Codes:** Every game generates a 6-character private code for secure invites.
    - **UX Fixes:** Added scrolling support for matchmaking and lobby, plus a "Copy Code" function.
    - **Integrity Guard:** Fixed "Auto-Start" bug; game now only starts when host explicitly clicks "Start Game".
- **Cloud Infrastructure (Supabase):** Full migration to production PostgreSQL. Configured for Transaction (Port 6543) and Session (Port 5432) poolers for stability.
- **Health Monitoring:** Added `/health` endpoint for Render cluster monitoring.

## [Unreleased]
- **Arhitectură Generală:** S-a stabilit arhitectura distribuită Backend (Node.js + Socket.io) și Frontend (React + Vite).
- **Frontend Assets:** Integrare texturi premium și sisteme de coordonate axiale pentru hexagoane.
- **Core Game Logic:** 4:1 Bank Trade și Dice Rolling logic.

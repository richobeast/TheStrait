# Iraq Warfare

A multiplayer first-person team deathmatch shooter set in Iraq, built for Steam on Windows.
Coalition vs Insurgents on **Baghdad Outskirts**: a mirrored desert town with a market plaza, enterable mud-brick buildings with rooftop access, an insurgent compound in the north and a Coalition FOB in the south.

## Run it
```
npm install
npm start            # desktop app (the Steam build)
npm run server       # dedicated server + browser version at http://localhost:3000
npm run package      # Windows release build in dist\IraqWarfare-win32-x64\
```
Press **F11** in the desktop app for fullscreen.

## Playing with friends
- **Over Steam (desktop app):** Host game → Esc → Invite friends. Friends accept the invite in Steam. Traffic is relayed through Steam, so no port forwarding is needed.
- **Practice vs bots:** offline, no Steam required.
- **Dedicated server:** `npm run server -- --port 3000 --bots 8` on any PC, then players use **Direct connect** with that PC's IP and port (or open the URL in a browser).

## Gameplay
- Team Deathmatch: first team to 75 kills, or the most kills after 10 minutes. Next match starts automatically.
- Weapons: Assault Rifle (M4A1 / AK-47), Shotgun (M1014 / Saiga-12), Sniper (M24 / Dragunov) and Pistol (M9 / Makarov). 2 grenades per life.
- Headshots, damage falloff, recoil, aim down sights, sniper scope, health regen, spawn protection, killfeed, minimap (enemies show when they fire), scoreboard, chat.
- Bots fill empty slots (configurable 0–14) and step aside as real players join.

| Key | Action |
|---|---|
| WASD / Shift / Space / C | Move / Sprint / Jump / Crouch |
| Left / Right mouse | Fire / Aim down sights |
| R, 1, 2, Q, wheel | Reload, switch weapons |
| G | Throw grenade |
| Tab / Enter / Esc | Scoreboard / Chat / Pause menu |

## Project layout
| Path | What it is |
|---|---|
| `shared/common.js` | Map, weapons, hitboxes and collision, shared by server and client |
| `server.js` | Authoritative game server: hit validation, damage, grenades, respawns, scoring, bot AI with A* pathfinding |
| `public/` | Game client: Three.js rendering, movement, weapons, effects, HUD, synthesized audio |
| `desktop/main.js` | Electron app: runs a local server, window, Steam IPC |
| `desktop/steam.js` | Steamworks: lobbies, invites, rich presence, achievements, P2P relay |
| `steam/` | SteamPipe upload script and the release checklist (`steam/RELEASE.md`) |

## Steam setup
The game uses Valve's test App ID **480** until you have your own. See `steam/RELEASE.md` for the full release checklist.

## Known limits
- Hit detection is client-reported with server-side checks (line of sight, range, fire rate, teams). That's fine among friends; public servers would need stronger anti-cheat.
- Steam P2P hosting and joining haven't been tested end to end yet. That needs two Steam accounts on two PCs.
- Everything is procedural (no texture or sound files), so it has a stylized, blocky look. Real 3D models and audio would be the next big upgrade.

# The Strait! (Beta 0.0.1)

A multiplayer first-person team deathmatch shooter for Steam on Windows. **U.S. Marines vs Iranian Forces** fight over **Hormuz Port**, a fictional harbor town on the Strait of Hormuz. It has an old quarter with Persian wind towers, a bazaar square, a container yard with gantry cranes, a warehouse, fuel tanks and a quay facing the strait, with tankers and warships out on the water.

## Run it
```
npm install
npm start            # desktop app (the Steam build)
npm run server       # dedicated server + browser version at http://localhost:3000
npm run package      # Windows release build in dist\TheStrait-win32-x64\
```
Press **F11** in the desktop app for fullscreen.

## Playing with friends
- **Over Steam (desktop app):** Host game → Esc → Invite friends. Friends accept the invite in Steam. Traffic is relayed through Steam, so no port forwarding is needed.
- **Practice vs bots:** offline, no Steam required.
- **Dedicated server:** `npm run server -- --port 3000 --bots 8` on any PC, then players use **Direct connect** with that PC's IP and port (or open the URL in a browser).

## Gameplay
- Team Deathmatch: first team to 75 kills, or the most kills after 10 minutes.
- Weapons (Marines / Iran): Assault Rifle M4A1 / KL-7.62, Shotgun M1014 / Saiga-12, Sniper M24 / Nakhjir, Pistol M18 / ZOAF PC-9. 2 grenades per life.
- **Attachments** (menu → Attachments, or Esc → Attachments; they apply on your next spawn):
  - Optic: iron sights, red dot, holographic, 4x ACOG
  - Muzzle: suppressor (quiet, keeps you off the enemy minimap, shorter range), compensator (−28% recoil)
  - Underbarrel: vertical grip (−15% recoil), laser (−35% hip-fire spread)
  - Magazine: extended (+50% ammo, slower reload)
- Bots fill empty slots (0–14) with random attachments, and step aside as real players join.

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
| `shared/common.js` | Map, weapons, attachment rules, hitboxes and collision, shared by server and client |
| `server.js` | Authoritative game server: hit validation, damage, grenades, respawns, scoring, bot AI with A* pathfinding |
| `public/game.js` | Game client: rendering, movement, weapons, effects, HUD, gunsmith menu, synthesized audio |
| `public/models.js` | Procedural models: guns from real side profiles, attachments, soldiers, first-person arms, camo |
| `desktop/main.js` | Electron app: runs a local server, window, Steam IPC |
| `desktop/steam.js` | Steamworks: lobbies, invites, rich presence, achievements, P2P relay |
| `steam/` | SteamPipe upload script and the release checklist (`steam/RELEASE.md`) |

## Steam setup
The game uses Valve's test App ID **480** until you have your own. See `steam/RELEASE.md` for the release checklist.

## Known limits
- Hit detection is client-reported with server-side checks (line of sight, range, fire rate, teams). That's fine among friends; public servers would need stronger anti-cheat.
- Steam P2P hosting and joining haven't been tested end to end yet. That needs two Steam accounts on two PCs.
- Models and textures are generated in code (no asset files). They're much more detailed than the first version but still stylized; artist-made models and recorded audio would be the next big upgrade.

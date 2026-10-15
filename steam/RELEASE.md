# Putting The Strait! on Steam

These are the steps only you can do (they need your Steamworks account), in order.

## 1. Get an App ID
1. Sign up at https://partner.steamgames.com (Steamworks), fill in the bank and tax forms.
2. Pay the Steam Direct fee (US$100 per game). You get an **App ID** and a **Depot ID**.

## 2. Point the game at your App ID
- In `package.json`, change `"steamAppId": 480` to your App ID.
  (480 is Valve's public test app "Spacewar". It's what the game uses until you have your own.)
- In `steam/app_build.vdf`, replace `REPLACE_WITH_YOUR_APP_ID` and `REPLACE_WITH_YOUR_WINDOWS_DEPOT_ID`.

## 3. Configure the app in Steamworks
- **Installation → General → Launch Options:** executable `TheStrait.exe`, OS Windows.
- **Stats & Achievements:** create these API names (the game already unlocks them):
  - `FIRST_BLOOD` – Get your first kill
  - `HEADSHOT` – Kill an enemy with a headshot
  - `GRENADIER` – Kill an enemy with a grenade
  - `WIN_MATCH` – Win a match
- **Matchmaking/lobbies and P2P networking** need no extra setup.
- Publish the changes in Steamworks (the "Publish" tab).

## 4. Build and upload
```
npm install
npm run package
```
This makes `dist\TheStrait-win32-x64\`. Then upload with SteamCMD from the Steamworks SDK
(`sdk\tools\ContentBuilder\builder\steamcmd.exe`):
```
steamcmd.exe +login YOUR_STEAM_BUILD_ACCOUNT +run_app_build "C:\path\to\this\project\steam\app_build.vdf" +quit
```
In Steamworks → SteamPipe → Builds, set the new build live on the `default` branch (or a beta branch to test first).

## 5. Store page (required before release)
- Capsule art (header 920×430, small 462×174, main 1232×706, vertical 748×896), library art, at least 5 screenshots, a trailer is strongly recommended.
- Description, tags (FPS, Multiplayer, Military, Shooter, PvP), system requirements.
- **Mature content survey:** answer the violence questions honestly (realistic military setting based on a real-world conflict, gun violence, blood effects).
- Store page and build each go through Valve review (a few business days). The "Coming Soon" page must be live at least 2 weeks before launch.

## 6. Test with friends before launch
- Give testers Steam keys (Steamworks → Request Steam Product Keys) or use a beta branch.
- One person clicks **Host game**, then **Invite friends** in the pause menu (or Shift+Tab → invite). Friends accept the invite in Steam and join automatically.

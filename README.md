# MyTV+ for LG webOS TV (unofficial)

The same client as the [desktop](../desktop-client) and [Android](../mobile)
versions, packaged as a webOS TV web app (`.ipk`). One UI codebase, three platforms.

## Features

Everything from the desktop client: profiles, favorites, watch later, resume
with the continue prompt, per-episode progress bars, subtitles, filters —
plus TV-specific behavior:

- **Remote-first UI** — D-pad moves focus (spatial navigation), OK/Enter
  activates, the Magic Remote Back key closes overlays/player
- **TV controls** (Settings ⚙ → on by default) — CH+ / CH− switch channels,
  FF / REW seek ±10 s in movies and episodes, OK pauses. Volume keys stay
  with the TV system volume (webOS gives apps no control there)
- Live channels play through the TV's native media pipeline (hardware
  decode), with automatic hls.js fallback

## Install on your LG TV

Sideloaded apps require LG **Developer Mode** (free):

1. On the TV: install the **Developer Mode** app from the LG Content Store,
   sign in with your LG account, enable Dev Mode and key server, note the TV's
   IP (Settings → Network).
2. On your PC: install the webOS CLI (`npm install -g @webos-tools/cli`) and
   the TV's passphrase (Developer Mode app shows a passphrase):
   ```bash
   ares-setup-device --add tv --username prisoner --password <PASSPHRASE> -i <TV-IP>
   ```
3. Install and launch:
   ```bash
   ares-install --device tv com.mytvplus.tv_1.1.0_all.ipk
   ares-launch --device tv com.mytvplus.tv
   ```

Notes:
- Developer Mode sessions expire (renew in the Dev Mode app every ~50 h or
  250 h with paid "Dev Manager" style tools). The app keeps working; only
  re-installs need the session.
- In the **webOS TV Simulator**, load the app via File → Launch App and pick
  the `pkg/` folder (this is how it's developed).

## Build from source

```bash
cd webos
node scripts/build-web.js     # assembles pkg/ from ../desktop-client/renderer
npm install @webos-tools/cli
npx ares-package pkg -o out   # → out/com.mytvplus.tv_<version>_all.ipk
```

## Architecture

```
scripts/build-web.js     copies ../desktop-client/renderer + injects TV bits
www-shim/native-shim.js  window.mytv on webOS: plain fetch (packaged TV apps
                         are not CORS-restricted), CryptoJS channel decryption,
                         localStorage profiles, IndexedDB catalog caches,
                         series-year index crawl, D-pad/remote key handling
appinfo.json             webOS app manifest (id com.mytvplus.tv)
```

Min target: webOS TV 4.x+ (older models have older WebKit; the app uses
widely-supported APIs — IndexedDB, MSE via hls.js, WebVTT tracks).

# SmartTwitchTV Desktop

A Linux desktop build of [SmartTwitchTV](https://github.com/fgl27/SmartTwitchTV) — the Twitch
client made for TVs — packaged as a Flatpak and meant to be driven by a **remote or game
controller** (keyboard and mouse work too). It runs full screen and fits nicely into Steam's
Gaming Mode / Big Picture.

## Download

Ready-made builds are on the **Releases** page (or, for the latest commit, under
*Actions → Build → Artifacts*):

- **Flatpak** (recommended, best Steam integration):
  `flatpak install --user SmartTwitchTV.flatpak`
- **AppImage**: `chmod +x SmartTwitchTV-x86_64.AppImage && ./SmartTwitchTV-x86_64.AppImage`

CI rebuilds every Monday with the latest upstream SmartTwitchTV web app. Push a tag like
`v0.1.1` to publish a release.

## Build it yourself

You need `flatpak` (preinstalled on SteamOS, Fedora, Mint, …) and `git`. Then:

```sh
./scripts/build-flatpak.sh
```

The first build downloads the Flatpak runtime (~1 GB, once) and takes a few minutes. Start
it from your app menu or with `flatpak run io.github.smarttwitchtv.Desktop`.

**Add to Steam:** Steam → *Games* → *Add a Non-Steam Game to My Library* → *SmartTwitchTV*.

**Another PC:** `./scripts/build-flatpak.sh --bundle` also writes `SmartTwitchTV.flatpak`;
install it there with `flatpak install --user SmartTwitchTV.flatpak`.

AppImage: `./scripts/build-appimage.sh` (needs node ≥ 18, npm, git, curl).

## Update

Download the newest release, or run `./scripts/build-flatpak.sh` again. Every build pulls the latest SmartTwitchTV web app
from upstream, so new features and fixes from the original project come along automatically.

## Controls

| Remote / keyboard | Controller (Xbox layout) | Action |
| --- | --- | --- |
| Arrows | D-pad / left stick | Move |
| Enter | A, Menu | Select · hold for options |
| Back, Esc, Backspace | B, View | Back |
| Space, Play/Pause | X | Play / pause |
| 3 | Y | Show / hide chat |
| Page Up / Down | LB / RB | Switch screen · chat position/size in player |
| 1 | LT | Picture-in-picture / multistream |
| 2 | RT | Chat side |
| F11 | | Toggle full screen |

The mouse pointer hides itself while you use the remote/controller and comes back when you move
the mouse. The app's own *Controls* screen (side menu) lists every shortcut.

**Logging in:** side menu → *Add User*. Twitch's login page opens inside the app; use keyboard
and mouse there. Esc goes back to the app.

**Options:** `flatpak run io.github.smarttwitchtv.Desktop --windowed` starts in a window.
`STV_WAYLAND=1` uses native Wayland instead of XWayland.

## How it works

SmartTwitchTV is a web app (HTML/JS) that the Android APK shows in a WebView. When the web app
finds a global `Android` object it switches into its full TV mode and hands playback, networking
and system tasks to the APK through ~110 bridge functions.

This project provides that object for the desktop:

- `src/renderer/android-shim.js` — the `Android` bridge. Video uses `<video>` + hls.js instead of
  ExoPlayer, with the same player slots (main, picture-in-picture, 4× multistream, previews),
  layouts and retry/end callbacks as `PlayerActivity.java`. Gamepads become remote key presses.
- `src/main.js` — Electron main process: serves the bundled web app from `app://stv/`, does the
  CORS-free HTTP the APK did natively, maps Esc/Back to the app's back key, handles the Twitch
  login redirect, keeps the screen awake while playing.
- `src/renderer/theme.css` — the desktop look: dark palette with a purple accent, rounded cards,
  glow focus ring, card-style dialogs. CSS only, layered over the upstream UI.
- `scripts/prepare-web.mjs` — copies upstream's prebuilt `release/` web app, strips analytics and
  injects the bridge + theme.

## Development

```sh
npm install                       # also fetches the Electron binary
git clone --depth 1 https://github.com/fgl27/SmartTwitchTV upstream
npm run dev                       # windowed + devtools (F12)
```

Offline UI work: `./scripts/make-dev-assets.sh` once, then `STV_MOCK=1 npm run dev` serves a fake
Live screen and a local test stream instead of Twitch.

## Not done yet

- Live-channel notifications (the Android notification service) are not implemented.
- The APK's ExoPlayer has Twitch-specific tweaks; hls.js is generic, so live latency may be a
  few seconds higher than on Android.
- Updating requires a rebuild (`build-flatpak.sh`); there is no in-app updater.

## License

GPL-3.0-or-later, like SmartTwitchTV. This is an unofficial, community-made app with no
affiliation with Twitch.

# Changelog

All notable changes to SoundControl. Versions follow [semantic versioning](https://semver.org);
1.0.0 will follow wider real-world testing (HTTPS and the first security scan's fixes landed in 0.7.0).

## [0.11.0] - 2026-11-07
- Update check: SoundControl compares itself with the latest release on GitHub (every few hours; public data only; UPDATE_CHECK=off disables it)
- When a newer version exists: a ⬆ marker next to the version for everyone, and a banner for admins (dismiss until the next version)
- Help → Updating: live status, what changed since your version, Check now (admins) and step-by-step update instructions

## [0.10.0] - 2026-11-07
- Named presets: the preset buttons show your HEOS Favourites by name (and logo), read live from the amp; empty slots are gone
- ☆ Save as preset next to every TuneIn station (saved without interrupting playback) and next to what is playing (only when HEOS allows it)
- Presets → Edit → ✕ removes a favourite; every change is read back from the amp
- Verified on a Marantz PM7000N: add by station, remove, playback untouched

## [0.9.1] - 2026-11-07
- Help brought up to date: new "Accounts & roles" section, admin-only settings marked, HTTPS address, Bluesound/NAD radio, five new troubleshooting answers, links to the guides
- docs/HTTPS.md: create your own certificate and trust it on Windows, macOS, Linux, iPhone/iPad, Android and Firefox

## [0.9.0] - 2026-11-07
- Settings → 🔌 Devices (admins): add an amp by IP with automatic detection (read-only "who are you?" queries for HEOS, Denon/Marantz, Yamaha, Onkyo/Pioneer and BluOS), or scan a home network (/24) to find amps; remove devices; changes are saved to config/devices.json with a backup and applied without a restart
- Detection and scans only target home-network (private) addresses; scans run one at a time and are logged
- Detection confirmed on a real Marantz PM7000N (HEOS + network control)

## [0.8.0] - 2026-11-07
- New experimental drivers: Yamaha MusicCast (`yamaha`), Onkyo / Pioneer / Integra (`onkyo`, eISCP) and Bluesound / NAD (`bluos`), written from the published protocols and tested against fake devices; not yet confirmed on real hardware
- Open-directory radio stations can play on BluOS players too
- Config examples for each brand in docs/DRIVERS.md

## [0.7.0] - 2026-11-07
Security release: every finding from the first SAST/DAST scan fixed and retested.
- HTTPS built in: `npm run cert` makes a local certificate authority and certificate; plain HTTP redirects to HTTPS; Secure session cookie and HSTS
- Admin and user roles: Spotify setup, the HEOS account and renaming are admin-only (existing accounts stay admin; `npm run user:create -- NAME --user` makes a regular user)
- Commands to the amp can no longer carry an extra line (HEOS sign-in and both device protocols refuse line breaks)
- Errors no longer show device addresses ("the amp is not answering"; details stay in the server log)
- Sessions survive a restart and expired ones are cleaned up (file-based session store)
- Bad or oversized requests get 400/413 instead of 500
- Stations are only sent to the amp if their address cannot be switched to a home-network address (DNS re-binding guard)
- Stricter Content Security Policy (no inline styles)
- nodemon removed (dev mode uses `node --watch`); npm audit: 0 vulnerabilities

## [0.6.0] - 2026-11-07
- Help centre: a Help button in the top bar opens a searchable guide to every feature, troubleshooting and privacy notes
- Version number and "What's new" shown in the app (signed-in users only)
- Fix: open-directory stations and stream addresses now play on HEOS amps (the address was over-encoded, so the amp accepted it but never started)
- Stream addresses containing line breaks are refused

## [0.5.0] - 2026-11-07
- Spotify: connect your own Spotify app (PKCE, no client secret), paste a playlist, album or track link or pick one of your playlists, and play it on any Spotify Connect speaker
- Speakers: a pair of bookshelf speakers slides out beside the amp; tap to take the grilles off; cones and tweeters move with the beat
- Translucent glass look for accent buttons, the active tab and selected day chips
- Pasting a Spotify, YouTube, Apple Music or other service link into the stream box now explains what to do instead
- Long station names no longer scroll the radio list sideways

## [0.4.0] - 2026-11-07
- Ten equaliser looks in the digital face display (tap to cycle): glow bars, faders, halo, terrain, capsules, scope, mirror, LED, waterfall, silk
- Smarter radio search: abbreviations such as ASOT and ABGT, and genre tags as well as names
- Open-directory stations listed under TuneIn results on a real amp, played on the amp
- ☰ button to show or hide the remote
- README screenshots

## [0.3.0] - 2026-11-07
- Three original digital front panels: Neon glass, Retro VU and Minimal pro
- Virtual amp: works with no hardware (default when no device config exists)
- Browser radio from the open Radio Browser directory, with the visualiser following the real audio
- Ghost clock over the visualiser (or docked under it), alarms with radio wake-up and gentle fade-up, timers with standby, reminders, wake-up radio quick setting
- Rename a device in the app; accent colour can follow the visualiser

## [0.2.0] - 2026-11-07
- Interactive photo front panel and clickable RC004PM handset (photos not included in the repository)
- TuneIn browse, search and play through HEOS; HEOS account sign-in from the app
- Sound visualiser with live microphone mode
- Tabs on phones, columns on wide screens; Source Direct and sleep timer with read-back
- First public release on GitHub (MIT)

## [0.1.0] - 2026-10-25
- Web remote for the Marantz PM7000N: power, volume with a per-device cap, mute, inputs
- Local accounts (bcrypt), sessions, CSRF protection, login lockout, activity log

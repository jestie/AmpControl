# Changelog

All notable changes to SoundControl. Versions follow [semantic versioning](https://semver.org);
1.0.0 will follow HTTPS support and the open security fixes.

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

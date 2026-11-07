# Photos (not included)

The interactive front panel and the clickable remote are drawn over photos of
the real Marantz PM7000N and its RC004PM remote. Those are Marantz's product
images, so they are not part of this repository.

Without them the app works normally with its standard controls. To get the
front panel and the remote, add your own images here:

| File | What | Size the hotspots expect |
|---|---|---|
| `pm7000n-face.png` | Front of the amp, cropped to the faceplate, transparent background | 1140 x 384 |
| `rc004pm.png` | The RC004PM remote, front on, transparent background | 203 x 817 |

The button positions are measured for those exact sizes and framings
(`public/faceplate.js` and `public/handset.js`). With a different photo, adjust
the coordinates at the top of those files. Restart the server after adding the
files; the device needs `"faceplate": "pm7000n"` in `config/devices.json`.

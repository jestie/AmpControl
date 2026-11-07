# HTTPS for SoundControl

SoundControl can encrypt the connection between your browser and the server
with HTTPS. You create your **own small certificate authority (CA)** once,
trust it on your devices, and the browser shows a padlock with no warnings.

Why bother: passwords and the session cookie are then encrypted on your
network, cookies get the `Secure` flag, HSTS is switched on, and phone
features such as the microphone mode (🎤) work.

> Your CA belongs to you alone. Everyone who installs SoundControl makes their
> own; never share `data/tls/ca.key`, and only trust CAs you created yourself.

## 1. Create the certificate

On the machine that runs SoundControl:

```bash
npm run cert
```

That creates, in `data/tls/` (ignored by git, files readable only by you):

| File | What it is | Share it? |
|---|---|---|
| `ca.crt` | Your CA's public certificate: what devices trust | Yes, copy it to your own devices |
| `ca.key` | Your CA's private key | **Never** |
| `server.crt`, `server.key` | The server's certificate and key | No (they stay on the server) |

By default the certificate is valid for `localhost`, `127.0.0.1` and the
machine's name. **If phones or other computers will connect by IP or by a
name, add those**:

```bash
npm run cert -- 192.168.1.40 soundcontrol.lan
```

Running it again keeps the same CA (so devices stay trusted) and issues a
fresh server certificate.

## 2. Switch HTTPS on

Add these lines to `.env`, then restart SoundControl:

```bash
TLS_CERT=./data/tls/server.crt
TLS_KEY=./data/tls/server.key
HTTPS_PORT=8443
```

SoundControl now serves `https://<server>:8443`. The old `http://<server>:8095`
only redirects to HTTPS. Check it:

```bash
curl --cacert data/tls/ca.crt https://localhost:8443/healthz      # {"ok":true}
```

If you use Spotify, set the Redirect URI in your Spotify app to
`https://127.0.0.1:8443/spotify/callback`.

## 3. Trust your CA on each device

Copy **`data/tls/ca.crt`** (only that file) to the device, then:

### Windows (Chrome, Edge, Brave)
- **Click-through:** double-click `ca.crt` → *Install Certificate* → *Current User* →
  *Place all certificates in the following store* → *Trusted Root Certification Authorities* → *Finish*.
- **Command (PowerShell, no admin needed):**
  ```powershell
  certutil -user -addstore Root C:\path\to\ca.crt
  ```
Windows shows a security prompt with the certificate's thumbprint. Compare it
with `openssl x509 -in data/tls/ca.crt -noout -fingerprint -sha1` on the server,
then click *Yes*. Restart the browser.

**Running SoundControl in WSL?** The file is reachable from Windows at
`\\wsl.localhost\<distro>\home\<you>\<path-to-SoundControl>\data\tls\ca.crt`.

### macOS (Safari, Chrome, Edge)
- **Click-through:** double-click `ca.crt` (opens Keychain Access, *login* keychain) →
  double-click "SoundControl Local CA" → *Trust* → *When using this certificate: Always Trust*.
- **Command:**
  ```bash
  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ca.crt
  ```

### Linux
- **System-wide (curl, most tools; Debian/Ubuntu):**
  ```bash
  sudo cp ca.crt /usr/local/share/ca-certificates/soundcontrol-local-ca.crt && sudo update-ca-certificates
  ```
  (Fedora/RHEL: copy to `/etc/pki/ca-trust/source/anchors/` and run `sudo update-ca-trust`.)
- **Chrome/Chromium on Linux** use their own store: *Settings → Privacy and security →
  Security → Manage certificates → Authorities → Import* → tick *Trust this certificate for identifying websites*.

### iPhone / iPad
1. Send `ca.crt` to the device (AirDrop, mail or a file share) and open it → *Allow* → install the profile in *Settings → Profile Downloaded*.
2. Then switch full trust on: *Settings → General → About → Certificate Trust Settings* → turn on "SoundControl Local CA".

### Android
*Settings → Security (and privacy) → More security settings → Encryption & credentials →
Install a certificate → CA certificate* → pick `ca.crt`. (Menu names vary by maker.)
Chrome on Android uses this store.

### Firefox (any desktop)
Firefox keeps its own list. Either
- open `about:config` and set `security.enterprise_roots.enabled` to `true` (Firefox then follows the system store), or
- *Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import* → tick *Trust this CA to identify websites*.

## Renewing, moving, removing

- **Server certificate** is valid for 825 days (the browser maximum). Renew any
  time with `npm run cert` (same CA, nothing to re-trust), then restart.
- **New IP or name?** Run `npm run cert -- <new IP or name>` and restart.
- **Start over** (new CA): delete `data/tls/`, run `npm run cert` again, and
  re-trust the new `ca.crt` everywhere. Remove the old one from devices.
- **Remove trust:** Windows `certmgr.msc` → *Trusted Root Certification Authorities* →
  delete "SoundControl Local CA" (or `certutil -user -delstore Root "SoundControl Local CA"`);
  macOS Keychain Access → delete it; iOS/Android → remove the profile/certificate.
- **Lost or leaked `ca.key`?** Delete `data/tls/`, create a new CA, and remove the
  old CA from every device: anyone with the old key could impersonate sites to them.

## Notes

- The CA can sign certificates, so it is limited (`pathlen:0`) and only ever used
  by `scripts/make-cert.sh` on your own machine.
- HTTPS covers browser ↔ SoundControl. The amplifier's own control protocols
  (HEOS, Denon/Marantz, Yamaha, Onkyo, BluOS) have no encryption, so the
  server ↔ amp link stays plain on your home network.
- Prefer a reverse proxy (Caddy, nginx, Traefik) with your existing certificates?
  Leave `TLS_CERT`/`TLS_KEY` unset, run SoundControl on HTTP behind the proxy, and
  set `COOKIE_SECURE=true`.

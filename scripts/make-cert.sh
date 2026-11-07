#!/usr/bin/env bash
# Create a local certificate authority and a server certificate for HTTPS on
# your home network (SC-01). Everything goes to data/tls/ (not in git).
#
#   npm run cert                      # localhost, 127.0.0.1, this hostname
#   npm run cert -- 192.168.1.45 amp.lan   # plus extra names/IPs phones will use
#
# Then trust data/tls/ca.crt once on each device (see Help > Using it on your phone).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=data/tls
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

if [ ! -f "$DIR/ca.key" ]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
    -keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
    -subj "/CN=SoundControl Local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  echo "Created local CA: $DIR/ca.crt (valid 10 years)"
fi

SAN="DNS:localhost,IP:127.0.0.1,DNS:$(hostname)"
for extra in "$@"; do
  if [[ "$extra" =~ ^[0-9.]+$ || "$extra" == *:* ]]; then SAN="$SAN,IP:$extra"; else SAN="$SAN,DNS:$extra"; fi
done

openssl req -newkey rsa:2048 -sha256 -nodes -keyout "$DIR/server.key" -out "$DIR/server.csr" \
  -subj "/CN=SoundControl" >/dev/null 2>&1
printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN" > "$DIR/server.ext"
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -out "$DIR/server.crt" -days 825 -sha256 -extfile "$DIR/server.ext" >/dev/null 2>&1
rm -f "$DIR/server.csr" "$DIR/server.ext"
chmod 600 "$DIR"/*.key
echo "Server certificate: $DIR/server.crt for $SAN (valid 825 days)"
echo "Add to .env:  TLS_CERT=./$DIR/server.crt  TLS_KEY=./$DIR/server.key  HTTPS_PORT=8443"

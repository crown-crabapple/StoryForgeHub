#!/bin/sh
# Install or upgrade StoryForge on a Debian/Ubuntu server, in shared mode, behind Caddy (which gets the HTTPS certificate).
#
#   sudo sh install-server.sh --zip storyforge-0.1.0.zip --domain app.example.org --owner alice
#
# Options:
#   --zip <file>          the release zip (required)
#   --domain <name>       the address people type, without https:// (required on the first install; kept in storyforge.env afterwards)
#   --owner <user name>   the first owner's user name (first install only; the setup link is printed at the end)
#   --port <n>            the local port StoryForge listens on, 127.0.0.1 only (default 4317)
#   --caddy-sites <dir>   where Caddy's site files go (default /etc/caddy/sites; the main Caddyfile must `import` it)
#   --no-caddy            do not write or reload a Caddy site (use your own reverse proxy)
#
#   sudo sh install-server.sh --setup-link
#                         a new one-time setup link for the first owner (each lasts 30 minutes), while that owner has not chosen a password yet.
#                         StoryForge is stopped for a few seconds. Once the owner has a password, use `shared reset-owner` (docs/self-hosting.md).
#
# What it does, every step safe to run again:
#   - a system user `storyforge`; the program in /opt/storyforge-<version> with /opt/storyforge pointing at it (root owned, read-only to the service)
#   - production dependencies only (npm ci --omit=dev); the release ships the built app, so nothing is built here
#   - /etc/storyforge/storyforge.env, written once (an existing one is kept): shared mode, 127.0.0.1, the public https address, a generated secrets key
#   - the library in /srv/storyforge/library, accounts and audit in /var/lib/storyforge/shared-data
#   - the systemd unit storyforge.service, enabled and (re)started
#   - a Caddy site file, checked with `caddy validate` before Caddy is reloaded (never restarted, so other sites stay up); on a failed check it is removed
# An upgrade is the same command with a newer zip. The previous /opt/storyforge-<version> folder is kept, so going back is: point /opt/storyforge at it and restart.
# It never touches the firewall, other Caddy sites, or anything in the library.
set -eu

ZIP=""; DOMAIN=""; OWNER=""; PORT=4317; CADDY_SITES=/etc/caddy/sites; USE_CADDY=1; SETUP_LINK=0
ENV_FILE=/etc/storyforge/storyforge.env
UNIT=/etc/systemd/system/storyforge.service
LIBRARY=/srv/storyforge/library
STATE=/var/lib/storyforge

say() { printf 'storyforge-install: %s\n' "$*"; }
die() { printf 'storyforge-install: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --owner) OWNER="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --caddy-sites) CADDY_SITES="${2:-}"; shift 2 ;;
    --no-caddy) USE_CADDY=0; shift ;;
    --setup-link) SETUP_LINK=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# --- checks before anything changes ---
[ "$(id -u)" -eq 0 ] || die "run this as root (sudo sh $0 ...)"
command -v systemctl >/dev/null 2>&1 || die "systemd is needed"

envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

if [ "$SETUP_LINK" -eq 1 ]; then
  [ -f "$ENV_FILE" ] && [ -e /opt/storyforge ] || die "StoryForge is not installed here yet (no $ENV_FILE)"
  NODE=$(command -v node) || die "node is not on PATH"
  OWNER=$(envval STORYFORGE_OWNER)
  say "stopping StoryForge for a moment to issue a new setup link for $OWNER"
  systemctl stop storyforge
  set +e
  OUT=$(cd /opt/storyforge && runuser -u storyforge -- env XDG_CONFIG_HOME="$STATE/config" "$NODE" apps/server/src/main.mjs shared init \
    --owner "$OWNER" --library "$LIBRARY" --shared-data "$STATE/shared-data" --public-url "$(envval STORYFORGE_PUBLIC_URL)" --port "$(envval STORYFORGE_PORT)" 2>&1)
  RC=$?
  set -e
  systemctl start storyforge
  printf '%s\n' "$OUT"
  [ "$RC" -eq 0 ] || die "no new link: $OWNER may already have a password. Then use: systemctl stop storyforge, then (in /opt/storyforge, as the storyforge user) node apps/server/src/main.mjs shared reset-owner --owner $OWNER --library $LIBRARY --shared-data $STATE/shared-data --public-url <url>, then systemctl start storyforge"
  say "StoryForge started again; the link above lasts 30 minutes"
  exit 0
fi
[ -n "$ZIP" ] && [ -f "$ZIP" ] || die "--zip <release zip> is required and must exist"
ZIP=$(readlink -f "$ZIP")
NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js 22 or newer is needed (https://nodejs.org or NodeSource)"
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22 or newer is needed; this is $("$NODE" -v)"
command -v npm >/dev/null 2>&1 || die "npm is needed (it comes with Node.js)"
case "$PORT" in ''|*[!0-9]*) die "--port must be a number" ;; esac

if [ -f "$ENV_FILE" ]; then
  # an existing install: the domain comes from its env file unless given again
  OLD_URL=$(envval STORYFORGE_PUBLIC_URL)
  [ -n "$DOMAIN" ] || DOMAIN=${OLD_URL#https://}
  [ -n "$OWNER" ] && say "note: --owner is used on the first install only; $ENV_FILE already exists"
else
  [ -n "$DOMAIN" ] || die "--domain is required on the first install"
  [ -n "$OWNER" ] || die "--owner is required on the first install"
  printf '%s' "$OWNER" | grep -Eq '^[a-z0-9._-]{3,32}$' || die "--owner must be 3-32 characters: a-z, 0-9, dot, underscore, hyphen"
fi
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || die "--domain must be a host name like app.example.org (no https://, no path)"

if [ "$USE_CADDY" -eq 1 ]; then
  command -v caddy >/dev/null 2>&1 || die "Caddy is not installed. Install it (https://caddyserver.com/docs/install) or use --no-caddy with your own proxy"
  [ -d "$CADDY_SITES" ] || die "$CADDY_SITES does not exist. Create it and add 'import $CADDY_SITES/*.caddy' to /etc/caddy/Caddyfile, or pass --caddy-sites"
  grep -Eq "^[[:space:]]*import[[:space:]]+$CADDY_SITES/" /etc/caddy/Caddyfile 2>/dev/null \
    || say "warning: /etc/caddy/Caddyfile does not seem to import $CADDY_SITES/*.caddy; the site will not be served until it does"
fi
if command -v getent >/dev/null 2>&1 && ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
  say "warning: $DOMAIN does not resolve yet. Add its DNS record; Caddy gets the certificate once it resolves to this server."
fi

# --- unpack the release ---
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
say "unpacking $ZIP"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP" -d "$WORK"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$ZIP" "$WORK"
else
  die "unzip or python3 is needed to unpack the zip (apt install unzip)"
fi
TOP=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'storyforge-*' | head -n 1)
[ -n "$TOP" ] && [ -f "$TOP/package.json" ] && [ -f "$TOP/apps/web/dist/index.html" ] || die "$ZIP is not a StoryForge release zip"
VERSION=$("$NODE" -p "require('$TOP/package.json').version")
DEST=/opt/storyforge-$VERSION

if [ -d "$DEST" ]; then
  say "$DEST exists; reinstalling it"
  rm -rf "$DEST.new"
fi
mv "$TOP" "$DEST.new"
say "installing production dependencies (npm ci --omit=dev)"
(cd "$DEST.new" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || die "npm ci failed; nothing was switched over (the running version is unchanged)"
chown -R root:root "$DEST.new"
chmod -R go-w "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

# --- user and folders ---
if ! id storyforge >/dev/null 2>&1; then
  say "creating the system user storyforge"
  useradd --system --home-dir "$STATE" --create-home --shell /usr/sbin/nologin storyforge
fi
mkdir -p /etc/storyforge "$LIBRARY" "$STATE/shared-data" "$STATE/config"
chown storyforge:storyforge /srv/storyforge "$LIBRARY" "$STATE" "$STATE/shared-data" "$STATE/config"
chmod 750 "$STATE" "$STATE/shared-data"

# --- settings, written once ---
if [ ! -f "$ENV_FILE" ]; then
  say "writing $ENV_FILE"
  KEY=$("$NODE" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")
  umask 027
  cat > "$ENV_FILE" <<EOF
# StoryForge settings (written by install-server.sh). Restart after a change: systemctl restart storyforge
STORYFORGE_MODE=shared
STORYFORGE_OWNER=$OWNER
STORYFORGE_PUBLIC_URL=https://$DOMAIN
STORYFORGE_HOST=127.0.0.1
STORYFORGE_PORT=$PORT
# Encrypts stored AI keys and webhook secrets. Back it up apart from the data backups; without it those keys must be entered again.
STORYFORGE_SECRETS_KEY=$KEY
EOF
  umask 022
  chown root:storyforge "$ENV_FILE"
  chmod 640 "$ENV_FILE"
else
  PORT=$(envval STORYFORGE_PORT); PORT=${PORT:-4317}
fi

# --- switch over and start ---
PREVIOUS=$(readlink /opt/storyforge 2>/dev/null || true)
ln -sfn "$DEST" /opt/storyforge.tmp && mv -T /opt/storyforge.tmp /opt/storyforge
# node:sqlite prints an ExperimentalWarning on every start; NODE_OPTIONS reaches the server process the entrypoint starts too
sed -e "s#^ExecStart=.*#ExecStart=$NODE deploy/entrypoint.mjs#" \
  -e "/^ExecStart=/i Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning" \
  /opt/storyforge/deploy/storyforge.service > "$UNIT"
systemctl daemon-reload
systemctl enable storyforge >/dev/null 2>&1
say "starting StoryForge $VERSION${PREVIOUS:+ (was $PREVIOUS)}"
systemctl restart storyforge

i=0
# node:http, not fetch: fetch drops a Host header, and StoryForge answers only for its public host name
until "$NODE" -e "require('node:http').get({host:'127.0.0.1',port:$PORT,path:'/api/health',headers:{Host:'$DOMAIN'},timeout:3000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    journalctl -u storyforge -n 30 --no-pager >&2 || true
    die "StoryForge did not answer on 127.0.0.1:$PORT within 60 s (log above)${PREVIOUS:+. To go back: ln -sfn $PREVIOUS /opt/storyforge && systemctl restart storyforge}"
  fi
  sleep 1
done
say "StoryForge answers on 127.0.0.1:$PORT"

# --- Caddy ---
if [ "$USE_CADDY" -eq 1 ]; then
  SITE="$CADDY_SITES/storyforge.caddy"
  BACKUP=""
  [ -f "$SITE" ] && BACKUP="$WORK/storyforge.caddy.bak" && cp "$SITE" "$BACKUP"
  cat > "$SITE" <<EOF
# StoryForge (written by install-server.sh). Caddy gets and renews the certificate.
$DOMAIN {
	encode zstd gzip
	# book restores (up to 512 MB) and attachments are uploaded through here
	request_body {
		max_size 512MB
	}
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$WORK/validate.log" 2>&1; then
    systemctl reload caddy
    say "Caddy reloaded with $SITE"
  else
    cat "$WORK/validate.log" >&2
    if [ -n "$BACKUP" ]; then cp "$BACKUP" "$SITE"; else rm -f "$SITE"; fi
    die "caddy validate failed (above); $SITE was put back as it was and Caddy was not reloaded. StoryForge itself is running."
  fi
fi

# --- done ---
LINK=$(journalctl -u storyforge --no-pager -o cat 2>/dev/null | grep -Eo 'https://[^ ]*/setup[^ ]*' | tail -n 1 || true)
say "done: StoryForge $VERSION at https://$DOMAIN"
if [ -n "$LINK" ]; then
  say "first owner: open this one-time link to choose the password: $LINK"
else
  say "if this is the first install, the one-time setup link is in: journalctl -u storyforge | grep setup"
fi
say "the setup link lasts 30 minutes; for a new one: sh $0 --setup-link"
say "library: $LIBRARY   accounts and audit: $STATE/shared-data   settings: $ENV_FILE"

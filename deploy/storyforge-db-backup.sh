#!/usr/bin/env bash
# Nightly backup of the StoryForge database (H0 section 4), for a bare server with a local PostgreSQL. Run by storyforge-db-backup.timer.
#
#   - pg_dump --format=custom of the whole database, over the local socket as the postgres user (peer auth: no password anywhere)
#   - plus a tar of the server's config folder (per-machine settings and the secrets key file, if any)
#   - both encrypted with age to a PUBLIC key; the private key is never on this server, so the server cannot read its own backups
#   - kept: 7 daily, 4 weekly (Sunday), 3 monthly (the 1st), as hard links, newest kept
#   - optionally copied off the server with rsync (never with --delete: the far side keeps its own history)
#
# Settings: /etc/storyforge/backup.env (see storyforge-backup.env.example). Nothing is written unencrypted; a missing recipient stops the backup.
set -euo pipefail
umask 077

ENV_FILE="${STORYFORGE_BACKUP_ENV:-/etc/storyforge/backup.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

DB_NAME="${STORYFORGE_BACKUP_DBNAME:-storyforge}"
DIR="${STORYFORGE_BACKUP_DIR:-/var/backups/storyforge}"
CONFIG_DIR="${STORYFORGE_BACKUP_CONFIG_DIR:-/var/lib/storyforge/config}"
RECIPIENT="${STORYFORGE_BACKUP_AGE_RECIPIENT:-}"
COPY_TO="${STORYFORGE_BACKUP_COPY_TO:-}"
KEEP_DAILY="${STORYFORGE_BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${STORYFORGE_BACKUP_KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${STORYFORGE_BACKUP_KEEP_MONTHLY:-3}"

say() { printf 'storyforge-db-backup: %s\n' "$*"; }
die() { say "$*" >&2; exit 1; }

case "$RECIPIENT" in
  age1*) ;;
  "") die "STORYFORGE_BACKUP_AGE_RECIPIENT is not set in $ENV_FILE: refusing to write an unencrypted backup (make a key pair OFF this server with age-keygen and put the public key here)" ;;
  *) die "STORYFORGE_BACKUP_AGE_RECIPIENT must be an age public key (age1...)" ;;
esac
for n in KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY; do
  [[ "${!n}" =~ ^[1-9][0-9]*$ ]] || die "STORYFORGE_BACKUP_$n must be a whole number of at least 1"
done
command -v pg_dump >/dev/null || die "pg_dump is not installed"
command -v age >/dev/null || die "age is not installed (apt install age)"
command -v runuser >/dev/null || die "runuser is not available"

mkdir -p "$DIR/daily" "$DIR/weekly" "$DIR/monthly"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d "$DIR/.partial-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. the database. pipefail makes a pg_dump failure fail the pipe; the size check catches an empty stream.
runuser -u postgres -- pg_dump --format=custom --no-password "$DB_NAME" | age --encrypt --recipient "$RECIPIENT" --output "$TMP/db.dump.age"
[ -s "$TMP/db.dump.age" ] || die "the database dump is empty"

# 2. the config folder (absent is fine: a server without per-machine settings yet)
if [ -d "$CONFIG_DIR" ]; then
  tar --create --gzip --directory "$CONFIG_DIR" . | age --encrypt --recipient "$RECIPIENT" --output "$TMP/config.tar.gz.age"
fi

sync -f "$TMP" 2>/dev/null || sync
NAME="storyforge-$STAMP"
mkdir "$DIR/daily/$NAME"
mv "$TMP"/* "$DIR/daily/$NAME/"
# weekly and monthly sets share the daily files (hard links: no extra space)
[ "$(date -u +%u)" = 7 ] && cp -al "$DIR/daily/$NAME" "$DIR/weekly/$NAME"
[ "$(date -u +%d)" = 01 ] && cp -al "$DIR/daily/$NAME" "$DIR/monthly/$NAME"

# 3. retention: the newest N of each set (names sort by time)
prune() {
  local set="$1" keep="$2"
  find "$DIR/$set" -mindepth 1 -maxdepth 1 -type d -name 'storyforge-*' -printf '%f\n' | sort -r | tail -n "+$((keep + 1))" |
    while IFS= read -r old; do rm -rf -- "${DIR:?}/$set/$old"; done
}
prune daily "$KEEP_DAILY"
prune weekly "$KEEP_WEEKLY"
prune monthly "$KEEP_MONTHLY"

say "wrote $DIR/daily/$NAME ($(du -sh "$DIR/daily/$NAME" | cut -f1))"

# 4. off the server
if [ -n "$COPY_TO" ]; then
  command -v rsync >/dev/null || die "STORYFORGE_BACKUP_COPY_TO is set but rsync is not installed"
  rsync -a --hard-links "$DIR/" "$COPY_TO" || die "the copy to $COPY_TO failed (the local backup is fine)"
  say "copied to $COPY_TO"
else
  say "STORYFORGE_BACKUP_COPY_TO is not set: this backup is on this server only (H0 section 4 wants a copy off the server)"
fi

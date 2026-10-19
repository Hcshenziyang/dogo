#!/usr/bin/env bash
# Code-only update for the existing personal ECS installation. Never rotates credentials.
set -euo pipefail
archive=${1:?code-only archive required}
digest=${2:?expected sha256 required}
release=${3:?release label required}
enable_memory=${4:-no}
public_origin=${5:-}
[[ $(id -u) == 0 && "$release" =~ ^[0-9]{8}-[a-z0-9-]+$ ]]
[[ "$enable_memory" == yes || "$enable_memory" == no ]]
[[ -z "$public_origin" || "$public_origin" =~ ^https://[a-zA-Z0-9.-]+$ ]]
[[ -f "$archive" && -f /etc/dogo/config.json && -L /opt/dogo/current ]]
printf '%s  %s\n' "$digest" "$archive" | sha256sum -c -
old=$(readlink -f /opt/dogo/current)
[[ "$old" == /opt/dogo/releases/* && -d "$old/node_modules" ]]
next="/opt/dogo/releases/$release"
[[ ! -e "$next" && ! -e /opt/dogo/current.next ]]
node=/opt/dogo/node-v24.22.0-linux-x64/bin/node
backup="/var/lib/dogo/backups/config-$release.json"
[[ ! -e "$backup" ]]
systemctl start dogo-backup.service
cp -p /etc/dogo/config.json "$backup"
chmod 600 "$backup"
cp -a "$old" "$next"
tar -xzf "$archive" -C "$next" --no-same-owner
cd "$next"
"$node" --test test/*.test.ts
rollback() {
  systemctl stop dogo-relay || true
  cp -p "$backup" /etc/dogo/config.json
  chown root:dogo /etc/dogo/config.json
  chmod 640 /etc/dogo/config.json
  ln -sfn "$old" /opt/dogo/current
  systemctl start dogo-relay || true
  printf 'Update failed; prior code/config restored. Additive DB tables retained.\n' >&2
}
trap rollback ERR
systemctl stop dogo-relay
if [[ "$enable_memory" == yes ]]; then
  "$node" --input-type=module -e '
    import fs from "node:fs";
    const p="/etc/dogo/config.json", c=JSON.parse(fs.readFileSync(p,"utf8"));
    c.services=[...new Set([...c.services,"memory"])];
    for(const d of c.devices) if(["mac","phone"].includes(d.id)) d.memory=true;
    fs.writeFileSync(p+".next",JSON.stringify(c,null,2),{mode:0o640,flag:"wx"});
    fs.renameSync(p+".next",p);
  '
  chown root:dogo /etc/dogo/config.json
fi
if [[ -n "$public_origin" ]]; then
  [[ -f "$next/web/index.html" ]]
  "$node" --input-type=module - "$public_origin" <<'JS'
    import fs from 'node:fs';
    const p='/etc/dogo/config.json', c=JSON.parse(fs.readFileSync(p,'utf8'));
    c.publicOrigin=process.argv[2]; c.webRoot='/opt/dogo/current/web';
    fs.writeFileSync(p+'.next',JSON.stringify(c,null,2),{mode:0o640,flag:'wx'});
    fs.renameSync(p+'.next',p);
JS
  chown root:dogo /etc/dogo/config.json
fi
chown -R root:root "$next"
ln -s "$next" /opt/dogo/current.next
mv -Tf /opt/dogo/current.next /opt/dogo/current
systemctl start dogo-relay
for attempt in {1..20}; do
  status=$(curl --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/v1/identity || true)
  if [[ "$status" == 401 || "$status" == 403 ]]; then break; fi
  sleep 1
done
# The API has no anonymous health endpoint: an HTTP auth rejection proves the listener is up.
status=$(curl --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/v1/identity)
[[ "$status" == 401 || "$status" == 403 ]]
systemctl is-active --quiet dogo-relay
if [[ -n "$public_origin" ]]; then
  [[ "$(curl --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/)" == 200 ]]
fi
trap - ERR
printf 'DEPLOYED %s\nROLLBACK %s\nCONFIG_BACKUP %s\n' "$next" "$old" "$backup"

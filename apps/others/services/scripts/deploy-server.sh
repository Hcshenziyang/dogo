#!/usr/bin/env bash
set -euo pipefail
umask 077
domain=${1:?Pass the approved DogO hostname}
phase=${2:-prepare}
[[ "$domain" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || exit 2
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 2; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
node_version=v24.22.0
node_sha=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
node_root=/opt/dogo/node-$node_version-linux-x64
release=/opt/dogo/releases/20261016-relay-v1

if [[ "$phase" == prepare ]]; then
  test ! -e /etc/nginx/sites-available/dogo
  test ! -e /etc/dogo/credentials.env
  test ! -e "$release"
  systemctl is-active --quiet nginx
  nginx -t
  install -d -m 0755 /opt/dogo /opt/dogo/releases
  if [[ ! -x "$node_root/bin/node" ]]; then
    curl --fail --show-error --location --retry 2 --max-time 300 \
      "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz" -o node.tar.xz
    printf '%s  %s\n' "$node_sha" node.tar.xz | sha256sum -c -
    tar -xJf node.tar.xz -C /opt/dogo --no-same-owner
  fi
  "$node_root/bin/node" --version
  if ! id dogo >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/dogo --shell /usr/sbin/nologin dogo
  fi
  install -d -o dogo -g dogo -m 0700 /var/lib/dogo
  install -d -o root -g dogo -m 0750 /etc/dogo
  install -d -m 0755 "$release"
  cp -a app/. "$release/"
  chown -R root:root "$release"
  chmod -R a+rX "$release"
  install -m 0600 credentials.env /etc/dogo/credentials.env
  install -m 0644 backup.mjs /opt/dogo/backup.mjs
  cat > /etc/dogo/config.json <<EOF
{"host":"127.0.0.1","port":8787,"allowedHosts":["127.0.0.1","localhost","$domain"],"database":"/var/lib/dogo/services.sqlite","services":["tasks"],"devices":[{"id":"mac","tokenEnv":"DOGO_MAC_TOKEN","publishTo":["/tasks/phone"],"memory":false},{"id":"phone","tokenEnv":"DOGO_PHONE_TOKEN","publishTo":["/tasks/mac"],"memory":false}],"mailboxes":{"/tasks/mac":"mac","/tasks/phone":"phone"}}
EOF
  chown root:dogo /etc/dogo/config.json
  chmod 0640 /etc/dogo/config.json
  ln -s "$release" /opt/dogo/current
  cat > /etc/systemd/system/dogo-relay.service <<EOF
[Unit]
Description=DogO authenticated task relay
After=network.target
[Service]
User=dogo
Group=dogo
WorkingDirectory=/opt/dogo/current
EnvironmentFile=/etc/dogo/credentials.env
Environment=DOGO_CONFIG=/etc/dogo/config.json
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=$node_root/bin/node /opt/dogo/current/src/main.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dogo
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=384M
TasksMax=64
CPUQuota=75%
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/dogo-backup.service <<EOF
[Unit]
Description=DogO local SQLite backup (14 snapshots)
[Service]
Type=oneshot
User=dogo
Group=dogo
ExecStart=$node_root/bin/node /opt/dogo/backup.mjs
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dogo
MemoryMax=128M
EOF
  cat > /etc/systemd/system/dogo-backup.timer <<'EOF'
[Unit]
Description=Daily DogO SQLite backup
[Timer]
OnCalendar=*-*-* 04:15:00
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
EOF
  install -d -m 0755 /var/www/dogo-acme /var/www/dogo-acme/.well-known /var/www/dogo-acme/.well-known/acme-challenge
  cat > /etc/nginx/sites-available/dogo <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    access_log off;
    location ^~ /.well-known/acme-challenge/ { root /var/www/dogo-acme; default_type text/plain; }
    location / { return 404; }
}
EOF
  chmod 0644 /etc/nginx/sites-available/dogo
  ln -s /etc/nginx/sites-available/dogo /etc/nginx/sites-enabled/dogo
  nginx -t
  systemctl reload nginx
  systemctl daemon-reload
  systemctl enable --now dogo-relay.service dogo-backup.timer
  for attempt in {1..30}; do
    [[ $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/v1/identity) == 401 ]] && break
    sleep 1
  done
  test -f /var/lib/dogo/services.sqlite
  systemctl start dogo-backup.service
  systemctl is-active dogo-relay nginx
  echo 'Prepared. HTTP only serves ACME; task service remains loopback-only.'
elif [[ "$phase" == tls ]]; then
  test -f /etc/letsencrypt/live/"$domain"/fullchain.pem
  test -f /etc/nginx/sites-available/dogo
  cp -p /etc/nginx/sites-available/dogo /etc/nginx/sites-available/dogo.pre-tls
  cat > /etc/nginx/sites-available/dogo <<EOF
limit_req_zone \$binary_remote_addr zone=dogo_api:1m rate=10r/s;
limit_conn_zone \$binary_remote_addr zone=dogo_conn:1m;
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    access_log off;
    location ^~ /.well-known/acme-challenge/ { root /var/www/dogo-acme; default_type text/plain; }
    location / { return 301 https://$domain\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $domain;
    server_tokens off;
    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    access_log off;
    client_max_body_size 1m;
    client_body_timeout 15s;
    add_header Strict-Transport-Security "max-age=86400" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control no-store always;
    limit_req zone=dogo_api burst=30 nodelay;
    limit_req_status 429;
    limit_conn dogo_conn 20;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $domain;
        proxy_set_header Connection "";
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 75s;
        proxy_send_timeout 15s;
    }
}
EOF
  chmod 0644 /etc/nginx/sites-available/dogo
  if ! nginx -t; then
    cp -p /etc/nginx/sites-available/dogo.pre-tls /etc/nginx/sites-available/dogo
    exit 1
  fi
  systemctl reload nginx
  cat > /etc/letsencrypt/renewal-hooks/deploy/dogo-nginx-reload <<'EOF'
#!/bin/sh
set -eu
/usr/sbin/nginx -t && /bin/systemctl reload nginx
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/dogo-nginx-reload
  echo 'DogO HTTPS configured; blog and system Node unchanged.'
else
  echo 'Phase must be prepare or tls'; exit 2
fi

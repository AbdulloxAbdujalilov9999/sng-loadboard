#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 server. Run as root:   bash setup-server.sh
# Installs Docker, enables the firewall (22/80/443 only), adds 2 GB swap and automatic security updates.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw unattended-upgrades fail2ban

if ! command -v docker >/dev/null; then
  # Docker's own installer first; brand-new Ubuntu releases are sometimes not supported yet -> Ubuntu's own packages
  curl -fsSL https://get.docker.com | sh || {
    echo "get.docker.com failed - using Ubuntu's docker packages instead"
    apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
  }
fi
docker compose version >/dev/null 2>&1 || apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin
systemctl enable --now docker

# keep container logs from filling the disk
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker

# firewall: only SSH + web
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# swap (a safety net against out-of-memory kills)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

dpkg-reconfigure -f noninteractive unattended-upgrades || true
systemctl enable --now fail2ban
mkdir -p /opt/sng/backups
# nightly database backup at 03:15 server time
cat > /etc/cron.d/sng-backup <<'CRON'
15 3 * * * root bash /opt/sng/app/deploy/backup.sh >> /var/log/sng-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/sng-backup
echo "Server ready. Next: clone the repo into /opt/sng/app (see deploy/README.md)."

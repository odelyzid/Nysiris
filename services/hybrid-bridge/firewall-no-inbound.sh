#!/usr/bin/env bash
# Host firewall for a mixnet-only web service: default-deny INBOUND,
# allow OUTBOUND (bridge must reach Nym gateways + nym-api over 443/WSS).
#
# Pick ONE backend. UFW is simplest on Mint/Debian/Ubuntu.
set -euo pipefail

if [[ "${1:-}" == "--nft" ]]; then
cat <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    # no tcp/udp accept rules: NOTHING inbound
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output { type filter hook output priority 0; policy accept; }
}
EOF
  echo "# saved: apply with: sudo nft -f <(./firewall-no-inbound.sh --nft)" >&2
  exit 0
fi

# --- UFW path ---
command -v ufw >/dev/null || { echo "install ufw: sudo apt install ufw"; exit 1; }
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
# SSH: keep ONLY if you need remote admin; otherwise skip this line.
# sudo ufw allow 22/tcp
sudo ufw --force enable
sudo ufw status verbose
echo
echo "Inbound blocked. Outbound open (required for gateway WSS + nym-api)."
echo "Verify with: ./verify-no-clearnet.sh docker-compose.mixnet-only.yml"

#!/usr/bin/env bash
# Repariert ein abgelaufenes/nicht erneuertes HTTPS-Zertifikat des Dashboards.
# Aufruf auf der VM:   bash ~/Gambino-Bot/deploy/fix-https.sh
# Ändert keine Konfiguration: startet nur den vorhandenen Webserver neu bzw. stößt die Zertifikats-Erneuerung an.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="$(grep -E '^DASHBOARD_PUBLIC_URL=' "$APP_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"'"'"' ')"
HOST="${URL#https://}"; HOST="${HOST%%/*}"; HOST="${HOST:-$(curl -fsS --max-time 10 https://api.ipify.org)}"
say() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

cert_info() { echo | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null; }
valid_now() { curl -fsS --max-time 20 -o /dev/null "https://$HOST/health"; }

say "Adresse: https://$HOST"
say "Zertifikat vorher"
cert_info || echo "Kein Zertifikat auf Port 443 gefunden."
if valid_now; then echo "✅ Das Zertifikat ist bereits gültig – nichts zu tun. (Evtl. Browser-Cache: Seite mit Strg+F5 neu laden.)"; exit 0; fi

if systemctl is-active --quiet caddy; then
  say "Caddy gefunden – Neustart (holt ein neues Zertifikat)"
  sudo systemctl restart caddy
  sleep 20
  sudo journalctl -u caddy --since "2 min ago" --no-pager | grep -iE "error|obtain|certificate" | tail -15
elif systemctl is-active --quiet nginx; then
  say "nginx gefunden – Zertifikat mit certbot erneuern"
  if command -v certbot >/dev/null 2>&1; then sudo certbot renew --no-random-sleep-on-renew; sudo systemctl reload nginx; else echo "certbot ist nicht installiert."; fi
else
  echo "Weder Caddy noch nginx laufen. Laufende Dienste auf Port 443:"; sudo ss -ltnp 'sport = :443' || true
fi

say "Zertifikat nachher"
cert_info || true
if valid_now; then
  echo "✅ HTTPS ist wieder gültig: https://$HOST"
else
  echo "❌ Immer noch ungültig."
  echo "   Häufigste Ursache: Port 80 ist von außen nicht erreichbar (Let's Encrypt prüft darüber)."
  echo "   Prüfen: sudo iptables -L INPUT -n | grep -E 'dpt:(80|443)'  und in der Oracle-Konsole die Security List (Ingress TCP 80 und 443)."
  echo "   Bitte die komplette Ausgabe dieses Skripts an Claude schicken."
fi

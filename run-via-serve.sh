#!/bin/bash
# Starts swamp serve just long enough to run one method call through it,
# then tears it down — avoids the ~400MB idle RSS cost of a persistent
# swamp serve daemon (see the other fun-stuff extensions for why that
# matters on this 8GB Pi) while still going through swamp serve as
# requested.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9095
INSTANCE=washing
METHOD=forecast

cd "$REPO_DIR"
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule --no-telemetry \
  >/tmp/can-i-hang-my-washing-out-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

# Wait for the server to actually be listening rather than a fixed sleep.
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

swamp model method run "$INSTANCE" "$METHOD" --server "ws://127.0.0.1:${PORT}"

# Export a small Prometheus textfile snippet for the Fun Stuff Grafana
# dashboard. Written atomically (tmp file + mv) since node_exporter may
# be scraping the textfile directory concurrently.
PROM_DIR=/var/lib/prometheus/node-exporter
PROM_TMP="$(mktemp "${PROM_DIR}/.can-i-hang-my-washing-out.prom.XXXXXX")"
swamp data get "$INSTANCE" today --server "ws://127.0.0.1:${PORT}" --json | python3 -c "
import json, sys
d = json.load(sys.stdin)['content']
morning = d['morning']['score']
afternoon = d['afternoon']['score']
best_score = max(morning, afternoon)
best_period = 'afternoon' if afternoon >= morning else 'morning'
answer = 1 if best_score >= 6 else 0
print('# HELP can_i_hang_my_washing_out_score Washing-drying score out of 10 for a given period (morning 06:00-12:00, afternoon 12:00-18:00).')
print('# TYPE can_i_hang_my_washing_out_score gauge')
print(f'can_i_hang_my_washing_out_score{{period=\"morning\"}} {morning}')
print(f'can_i_hang_my_washing_out_score{{period=\"afternoon\"}} {afternoon}')
print('# HELP can_i_hang_my_washing_out_answer 1 if the best of morning/afternoon scores at least 6/10 (worth hanging washing out today), else 0. Labeled with which period is best.')
print('# TYPE can_i_hang_my_washing_out_answer gauge')
print(f'can_i_hang_my_washing_out_answer{{best_period=\"{best_period}\"}} {answer}')
" > "$PROM_TMP"
chmod 644 "$PROM_TMP"
mv "$PROM_TMP" "${PROM_DIR}/can-i-hang-my-washing-out.prom"

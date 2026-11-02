#!/usr/bin/env bash
# DEV-001 主机自检：无需 ESP-IDF 或硬件。
set -euo pipefail
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/dev001-host-tests"
mkdir -p "$OUT"

cc -std=c11 -Wall -Wextra -I../../main test_button_logic.c ../../main/button_logic.c -o "$OUT/test_button_logic"
"$OUT/test_button_logic"

cc -std=c11 -Wall -Wextra -I../../main test_render.c ../../main/display_render.c -o "$OUT/test_render"
"$OUT/test_render"

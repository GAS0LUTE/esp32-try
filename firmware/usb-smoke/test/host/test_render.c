#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "display_render.h"

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "RGB565 byte-order test expects a little-endian host"
#endif

#define W 172
#define H 320
#define GUARD 64

#define C_RED 0xF800
#define C_GREEN 0x07E0
#define C_BLUE 0x001F
#define C_YELLOW 0xFFE0
#define C_WHITE 0xFFFF

static render_status_t status(bool pressed)
{
    render_status_t st = {
        .build_id = "dev-001",
        .uptime_s = 12,
        .count = 3,
        .pressed = pressed,
        .lcd_ok = true,
    };
    return st;
}

static void render_with(uint16_t *fb, int w, int h, bool pressed)
{
    render_status_t st = status(pressed);
    render_frame(fb, w, h, &st);
}

static uint16_t px(const uint16_t *fb, int x, int y)
{
    return fb[y * W + x];
}

static void test_frame_contents(void)
{
    const size_t count = (size_t)W * H;
    uint16_t *raw = malloc((count + 2 * GUARD) * sizeof(uint16_t));
    assert(raw != NULL);
    for (size_t i = 0; i < count + 2 * GUARD; i++) raw[i] = 0xDEAD;

    uint16_t *fb = raw + GUARD;
    render_with(fb, W, H, false);

    for (int i = 0; i < GUARD; i++) {
        assert(raw[i] == 0xDEAD);                    // 越界写前哨
        assert(raw[GUARD + count + i] == 0xDEAD);    // 越界写后哨
    }

    assert(px(fb, 0, 0) == C_WHITE);
    assert(px(fb, W - 1, H - 1) == C_WHITE);
    assert(px(fb, 2, 2) == C_RED);
    assert(px(fb, W - 3, 2) == C_GREEN);
    assert(px(fb, 2, H - 3) == C_BLUE);
    assert(px(fb, W - 3, H - 3) == C_YELLOW);
    assert(px(fb, 32, 92) == C_RED);
    assert(px(fb, 86, 92) == C_GREEN);
    assert(px(fb, 140, 92) == C_BLUE);

    // 小端内存中的 RGB565 字节序，与 panel_config.data_endian=LITTLE 对应。
    const uint8_t *red = (const uint8_t *)&fb[92 * W + 32];
    const uint8_t *green = (const uint8_t *)&fb[92 * W + 86];
    const uint8_t *blue = (const uint8_t *)&fb[92 * W + 140];
    assert(red[0] == 0x00 && red[1] == 0xF8);
    assert(green[0] == 0xE0 && green[1] == 0x07);
    assert(blue[0] == 0x1F && blue[1] == 0x00);

    // IDLE 与 PRESSED 的状态区必须不同
    uint16_t *fb2 = malloc(count * sizeof(uint16_t));
    assert(fb2 != NULL);
    render_with(fb2, W, H, true);
    int diff = 0;
    for (int y = 190; y < 235; y++)
        for (int x = 0; x < W; x++)
            if (fb[y * W + x] != fb2[y * W + x]) diff++;
    assert(diff > 0);
    free(fb2);
    free(raw);
    printf("PASS render frame/corners/colors/state (%d px diff)\n", diff);
}

static void test_small_window_clipping(void)
{
    const int w = 100, h = 100;
    const size_t count = (size_t)w * h;
    uint16_t *raw = malloc((count + 2 * GUARD) * sizeof(uint16_t));
    assert(raw != NULL);
    for (size_t i = 0; i < count + 2 * GUARD; i++) raw[i] = 0xBEEF;
    uint16_t *fb = raw + GUARD;
    render_with(fb, w, h, true);
    for (int i = 0; i < GUARD; i++) {
        assert(raw[i] == 0xBEEF);
        assert(raw[GUARD + count + i] == 0xBEEF);
    }
    assert(fb[0] == C_WHITE);
    free(raw);
    printf("PASS render small-window clipping\n");
}

static void test_null_safe(void)
{
    render_with(NULL, W, H, false);
    uint16_t fb[4] = {0};
    render_frame(fb, W, H, NULL);
    printf("PASS render null-safe\n");
}

int main(void)
{
    test_frame_contents();
    test_small_window_clipping();
    test_null_safe();
    printf("ALL RENDER TESTS PASSED\n");
    return 0;
}

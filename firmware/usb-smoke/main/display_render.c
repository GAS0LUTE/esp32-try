#include "display_render.h"
#include "font5x7.h"
#include <stdio.h>
#include <string.h>

// RGB565
#define C_BG 0x0841
#define C_WHITE 0xFFFF
#define C_RED 0xF800
#define C_GREEN 0x07E0
#define C_BLUE 0x001F
#define C_YELLOW 0xFFE0
#define C_GREY 0x8410

static void put_px(uint16_t *fb, int w, int h, int x, int y, uint16_t color)
{
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    fb[y * w + x] = color;
}

static void fill_rect(uint16_t *fb, int w, int h, int x, int y, int rw, int rh, uint16_t color)
{
    for (int yy = y; yy < y + rh; yy++)
        for (int xx = x; xx < x + rw; xx++) put_px(fb, w, h, xx, yy, color);
}

static void draw_char(uint16_t *fb, int w, int h, int x, int y, char c, int scale, uint16_t color)
{
    const uint8_t *glyph = font5x7_glyph(c);
    for (int col = 0; col < FONT5X7_W; col++) {
        uint8_t bits = glyph[col];
        for (int row = 0; row < FONT5X7_H; row++) {
            if (bits & (1u << row)) {
                fill_rect(fb, w, h, x + col * scale, y + row * scale, scale, scale, color);
            }
        }
    }
}

static int text_width(const char *s, int scale)
{
    int n = (int)strlen(s);
    return n > 0 ? n * (FONT5X7_W + 1) * scale - scale : 0;
}

static void draw_text_centered(uint16_t *fb, int w, int h, int y, const char *s, int scale, uint16_t color)
{
    int x = (w - text_width(s, scale)) / 2;
    for (const char *p = s; *p; p++) {
        draw_char(fb, w, h, x, y, *p, scale, color);
        x += (FONT5X7_W + 1) * scale;
    }
}

void render_frame(uint16_t *fb, int w, int h, const render_status_t *st)
{
    if (!fb || !st || w <= 0 || h <= 0) return;

    fill_rect(fb, w, h, 0, 0, w, h, C_BG);

    // 外框与刻度：用于判断边界、裁切和圆角遮挡。
    fill_rect(fb, w, h, 0, 0, w, 1, C_WHITE);
    fill_rect(fb, w, h, 0, h - 1, w, 1, C_WHITE);
    fill_rect(fb, w, h, 0, 0, 1, h, C_WHITE);
    fill_rect(fb, w, h, w - 1, 0, 1, h, C_WHITE);
    for (int x = 0; x < w; x += 10) {
        fill_rect(fb, w, h, x, 1, 1, 3, C_GREY);
        fill_rect(fb, w, h, x, h - 4, 1, 3, C_GREY);
    }
    for (int y = 0; y < h; y += 10) {
        fill_rect(fb, w, h, 1, y, 3, 1, C_GREY);
        fill_rect(fb, w, h, w - 4, y, 3, 1, C_GREY);
    }

    // 四角标记：TL 红、TR 绿、BL 蓝、BR 黄。
    fill_rect(fb, w, h, 2, 2, 16, 16, C_RED);
    fill_rect(fb, w, h, w - 18, 2, 16, 16, C_GREEN);
    fill_rect(fb, w, h, 2, h - 18, 16, 16, C_BLUE);
    fill_rect(fb, w, h, w - 18, h - 18, 16, 16, C_YELLOW);

    draw_text_centered(fb, w, h, 24, "USB SMOKE TEST", 2, C_WHITE);
    char line[48];
    snprintf(line, sizeof(line), "BUILD %s", st->build_id ? st->build_id : "?");
    draw_text_centered(fb, w, h, 44, line, 1, C_GREY);

    // RGB 色块。
    fill_rect(fb, w, h, 12, 72, 40, 40, C_RED);
    fill_rect(fb, w, h, 66, 72, 40, 40, C_GREEN);
    fill_rect(fb, w, h, 120, 72, 40, 40, C_BLUE);
    draw_text_centered(fb, w, h, 60, "R   G   B", 1, C_WHITE);

    snprintf(line, sizeof(line), "UP: %05lus", (unsigned long)st->uptime_s);
    draw_text_centered(fb, w, h, 128, line, 2, C_WHITE);

    snprintf(line, sizeof(line), "COUNT: %03lu", (unsigned long)(st->count % 1000));
    draw_text_centered(fb, w, h, 152, line, 2, C_WHITE);

    draw_text_centered(fb, w, h, 178, "STATE", 1, C_GREY);
    draw_text_centered(fb, w, h, 196, st->pressed ? "PRESSED" : "IDLE", 3,
                       st->pressed ? C_YELLOW : C_GREEN);

    draw_text_centered(fb, w, h, 248, "BOOT GPIO0", 1, C_GREY);
    draw_text_centered(fb, w, h, 266, st->lcd_ok ? "LCD OK" : "LCD ERROR", 1,
                       st->lcd_ok ? C_GREEN : C_RED);
}

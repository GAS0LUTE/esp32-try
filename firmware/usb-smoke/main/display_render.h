#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    const char *build_id;
    uint32_t uptime_s;
    uint32_t count;
    bool pressed;
    bool lcd_ok;
} render_status_t;

// 把一帧状态画进 RGB565 缓冲（逻辑分辨率 w x h）。
// 纯函数式绘制，不依赖 ESP-IDF，可在主机上测试。
void render_frame(uint16_t *fb, int w, int h, const render_status_t *st);

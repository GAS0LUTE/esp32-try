#pragma once
#include <stdbool.h>
#include <stdint.h>

// 非阻塞去抖：稳定电平持续 debounce_ms 后才接受变化。
typedef enum {
    BTN_EVENT_NONE = 0,
    BTN_EVENT_PRESS,
    BTN_EVENT_RELEASE,
} btn_event_t;

typedef struct {
    bool stable_pressed;   // 去抖后的稳定状态
    bool armed;            // 只有释放过后，下一次按下才计数
    bool candidate_pressed;
    uint32_t candidate_since_ms;
    bool has_candidate;
} button_logic_t;

// 启动时读取当前电平；若已按住，释放前不补发按下事件。
void button_logic_init(button_logic_t *st, bool pressed_at_boot);

// 周期调用；raw_pressed=true 表示 GPIO0 为低（按下）。
btn_event_t button_logic_update(button_logic_t *st, bool raw_pressed, uint32_t now_ms, uint32_t debounce_ms);

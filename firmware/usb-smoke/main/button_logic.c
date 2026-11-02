#include "button_logic.h"

void button_logic_init(button_logic_t *st, bool pressed_at_boot)
{
    st->stable_pressed = pressed_at_boot;
    // 启动时已按住：必须在看到释放后，才允许下一次按下计数。
    st->armed = !pressed_at_boot;
    st->candidate_pressed = pressed_at_boot;
    st->candidate_since_ms = 0;
    st->has_candidate = false;
}

btn_event_t button_logic_update(button_logic_t *st, bool raw_pressed, uint32_t now_ms, uint32_t debounce_ms)
{
    if (raw_pressed == st->stable_pressed) {
        st->has_candidate = false;
        return BTN_EVENT_NONE;
    }

    if (!st->has_candidate || st->candidate_pressed != raw_pressed) {
        st->has_candidate = true;
        st->candidate_pressed = raw_pressed;
        st->candidate_since_ms = now_ms;
        return BTN_EVENT_NONE;
    }

    if ((uint32_t)(now_ms - st->candidate_since_ms) < debounce_ms) {
        return BTN_EVENT_NONE;
    }

    st->stable_pressed = raw_pressed;
    st->has_candidate = false;

    if (raw_pressed) {
        if (!st->armed) {
            return BTN_EVENT_NONE; // 启动时按住后的这次按下不计数
        }
        st->armed = false;
        return BTN_EVENT_PRESS;
    }

    st->armed = true;
    return BTN_EVENT_RELEASE;
}

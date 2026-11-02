#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include "button_logic.h"

static btn_event_t feed(button_logic_t *st, bool pressed, uint32_t ms)
{
    return button_logic_update(st, pressed, ms, 30);
}

static void test_normal_press_and_long_hold(void)
{
    button_logic_t st;
    button_logic_init(&st, false);
    assert(feed(&st, true, 0) == BTN_EVENT_NONE);
    assert(feed(&st, true, 29) == BTN_EVENT_NONE);
    assert(feed(&st, true, 30) == BTN_EVENT_PRESS);
    assert(feed(&st, true, 1000) == BTN_EVENT_NONE); // 长按不连增
    assert(feed(&st, false, 1001) == BTN_EVENT_NONE);
    assert(feed(&st, false, 1031) == BTN_EVENT_RELEASE);
    assert(feed(&st, true, 1100) == BTN_EVENT_NONE);
    assert(feed(&st, true, 1130) == BTN_EVENT_PRESS);
    printf("PASS button normal/long-hold\n");
}

static void test_boot_held_requires_release(void)
{
    button_logic_t st;
    button_logic_init(&st, true);
    assert(feed(&st, true, 100) == BTN_EVENT_NONE);
    assert(feed(&st, false, 200) == BTN_EVENT_NONE);
    assert(feed(&st, false, 230) == BTN_EVENT_RELEASE);
    assert(feed(&st, true, 300) == BTN_EVENT_NONE);
    assert(feed(&st, true, 330) == BTN_EVENT_PRESS);
    printf("PASS button boot-held\n");
}

static void test_bounce_is_ignored(void)
{
    button_logic_t st;
    button_logic_init(&st, false);
    assert(feed(&st, true, 0) == BTN_EVENT_NONE);
    assert(feed(&st, false, 20) == BTN_EVENT_NONE);
    assert(feed(&st, true, 40) == BTN_EVENT_NONE);
    assert(feed(&st, false, 50) == BTN_EVENT_NONE);
    assert(feed(&st, true, 60) == BTN_EVENT_NONE);
    assert(feed(&st, true, 89) == BTN_EVENT_NONE);
    assert(feed(&st, true, 90) == BTN_EVENT_PRESS);
    printf("PASS button bounce\n");
}

static void test_release_debounce(void)
{
    button_logic_t st;
    button_logic_init(&st, false);
    assert(feed(&st, true, 0) == BTN_EVENT_NONE);
    assert(feed(&st, true, 30) == BTN_EVENT_PRESS);
    assert(feed(&st, false, 100) == BTN_EVENT_NONE);
    assert(feed(&st, false, 129) == BTN_EVENT_NONE);
    assert(feed(&st, false, 130) == BTN_EVENT_RELEASE);
    printf("PASS button release debounce\n");
}

int main(void)
{
    test_normal_press_and_long_hold();
    test_boot_held_requires_release();
    test_bounce_is_ignored();
    test_release_debounce();
    printf("ALL BUTTON TESTS PASSED\n");
    return 0;
}

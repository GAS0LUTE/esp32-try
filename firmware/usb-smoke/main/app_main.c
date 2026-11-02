#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_attr.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "board_config.h"
#include "button_logic.h"
#include "display_render.h"

#ifndef FW_BUILD_ID
#define FW_BUILD_ID "dev-001"
#endif

static const char *TAG = "usb_smoke";

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t s_flush_done;
static uint16_t *s_fb;
static bool s_lcd_ok;
static bool s_ledc_ready;
static bool s_boot_pressed;
static bool s_backlight_on;

static atomic_int s_count;
static atomic_bool s_pressed;
static atomic_bool s_dirty;

static esp_err_t backlight_set_percent(int percent)
{
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    uint32_t duty = (uint32_t)BOARD_BL_PWM_MAX * (uint32_t)percent / 100u;
    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    if (err != ESP_OK) return err;
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static void fatal_halt(const char *what, esp_err_t err)
{
    ESP_LOGE(TAG, "FATAL %s: %s (%d)", what, esp_err_to_name(err), (int)err);
    // 不进入无限重启：关闭背光并停在这里，等待人工处理。
    // 尽力关闭背光；不在这里调用 backlight_set_percent，避免失败路径递归。
    if (s_ledc_ready && s_backlight_on) {
        (void)ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
        (void)ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
        s_backlight_on = false;
    }
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

static void must(esp_err_t err, const char *what)
{
    if (err != ESP_OK) fatal_halt(what, err);
}

static bool IRAM_ATTR on_color_trans_done(esp_lcd_panel_io_handle_t io,
                                          esp_lcd_panel_io_event_data_t *edata,
                                          void *user_ctx)
{
    BaseType_t woken = pdFALSE;
    if (s_flush_done) xSemaphoreGiveFromISR(s_flush_done, &woken);
    return woken == pdTRUE;
}

static const char *reset_reason_str(esp_reset_reason_t reason)
{
    switch (reason) {
        case ESP_RST_POWERON: return "POWERON";
        case ESP_RST_EXT: return "EXT";
        case ESP_RST_SW: return "SW";
        case ESP_RST_PANIC: return "PANIC";
        case ESP_RST_INT_WDT: return "INT_WDT";
        case ESP_RST_TASK_WDT: return "TASK_WDT";
        case ESP_RST_WDT: return "WDT";
        case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
        case ESP_RST_BROWNOUT: return "BROWNOUT";
        default: return "OTHER";
    }
}

static void backlight_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = BOARD_BL_PWM_BITS,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = BOARD_BL_PWM_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    must(ledc_timer_config(&timer), "ledc timer");

    ledc_channel_config_t channel = {
        .gpio_num = BOARD_PIN_LCD_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0, // 启动先关闭背光
        .hpoint = 0,
    };
    must(ledc_channel_config(&channel), "ledc channel");
    s_ledc_ready = true;
}

static void lcd_init(void)
{
    spi_bus_config_t bus = {
        .mosi_io_num = BOARD_PIN_LCD_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = BOARD_PIN_LCD_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = BOARD_LCD_H_RES * BOARD_LCD_V_RES * sizeof(uint16_t),
    };
    must(spi_bus_initialize(BOARD_LCD_HOST, &bus, SPI_DMA_CH_AUTO), "spi bus");

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_config = {
        .dc_gpio_num = BOARD_PIN_LCD_DC,
        .cs_gpio_num = BOARD_PIN_LCD_CS,
        .pclk_hz = BOARD_LCD_PIXEL_CLOCK_HZ,
        .lcd_cmd_bits = BOARD_LCD_CMD_BITS,
        .lcd_param_bits = BOARD_LCD_PARAM_BITS,
        .spi_mode = 0,
        .trans_queue_depth = 10,
        .on_color_trans_done = on_color_trans_done,
        .user_ctx = NULL,
    };
    must(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)BOARD_LCD_HOST, &io_config, &io), "panel io");

    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = BOARD_PIN_LCD_RST,
        .rgb_ele_order = BOARD_LCD_RGB_ORDER,
        // 缓冲是未经字节交换的 uint16_t RGB565（小端内存：红 00 F8 / 绿 E0 07 / 蓝 1F 00）。
        .data_endian = LCD_RGB_DATA_ENDIAN_LITTLE,
        .bits_per_pixel = 16,
    };
    must(esp_lcd_new_panel_st7789(io, &panel_config, &s_panel), "st7789 panel");
    must(esp_lcd_panel_reset(s_panel), "panel reset");
    must(esp_lcd_panel_init(s_panel), "panel init");
    must(esp_lcd_panel_invert_color(s_panel, BOARD_LCD_INVERT), "panel invert");
    must(esp_lcd_panel_mirror(s_panel, BOARD_LCD_MIRROR_X, BOARD_LCD_MIRROR_Y), "panel mirror");
    must(esp_lcd_panel_set_gap(s_panel, BOARD_LCD_X_GAP, BOARD_LCD_Y_GAP), "panel gap");
    must(esp_lcd_panel_disp_on_off(s_panel, true), "panel display on");
}

static void button_task(void *arg)
{
    (void)arg;
    const bool boot_pressed = s_boot_pressed;
    button_logic_t st;
    button_logic_init(&st, boot_pressed);
    atomic_store(&s_pressed, boot_pressed);
    atomic_store(&s_dirty, true);

    uint32_t count = 0;
    ESP_LOGI(TAG, "BTN init raw=%s (boot held -> release required before counting)",
             boot_pressed ? "PRESSED" : "RELEASED");

    while (1) {
        const bool raw = gpio_get_level(BOARD_PIN_BOOT) == 0;
        const uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);
        const btn_event_t ev = button_logic_update(&st, raw, now_ms, 30);

        if (ev == BTN_EVENT_PRESS) {
            count += 1;
            atomic_store(&s_count, (int)count);
            atomic_store(&s_pressed, true);
            atomic_store(&s_dirty, true);
            ESP_LOGI(TAG, "BTN press count=%lu ms=%lu", (unsigned long)count, (unsigned long)now_ms);
        } else if (ev == BTN_EVENT_RELEASE) {
            atomic_store(&s_pressed, false);
            atomic_store(&s_dirty, true);
            ESP_LOGI(TAG, "BTN release count=%lu ms=%lu", (unsigned long)count, (unsigned long)now_ms);
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void app_main(void)
{
    atomic_init(&s_count, 0);
    atomic_init(&s_pressed, false);
    atomic_init(&s_dirty, true);
    s_lcd_ok = false;

    backlight_init();
    must(backlight_set_percent(0), "backlight off");
    ESP_LOGI(TAG, "BOOT build=%s reset=%s", FW_BUILD_ID, reset_reason_str(esp_reset_reason()));

    gpio_config_t boot_cfg = {
        .pin_bit_mask = 1ULL << BOARD_PIN_BOOT,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    must(gpio_config(&boot_cfg), "boot gpio");
    // 尽早读取启动电平，供按键状态机决定是否要求先释放。
    s_boot_pressed = gpio_get_level(BOARD_PIN_BOOT) == 0;

    s_flush_done = xSemaphoreCreateBinary();
    if (!s_flush_done) fatal_halt("flush semaphore", ESP_ERR_NO_MEM);

    lcd_init();
    s_lcd_ok = true;

    s_fb = heap_caps_malloc((size_t)BOARD_LCD_H_RES * BOARD_LCD_V_RES * sizeof(uint16_t),
                            MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!s_fb) fatal_halt("framebuffer alloc", ESP_ERR_NO_MEM);
    ESP_LOGI(TAG, "LCD %dx%d RGB565, fb=%u bytes, SPI %d Hz", BOARD_LCD_H_RES, BOARD_LCD_V_RES,
             (unsigned)(BOARD_LCD_H_RES * BOARD_LCD_V_RES * sizeof(uint16_t)), BOARD_LCD_PIXEL_CLOCK_HZ);

    render_status_t status = {
        .build_id = FW_BUILD_ID,
        .uptime_s = 0,
        .count = 0,
        .pressed = s_boot_pressed,
        .lcd_ok = true,
    };
    render_frame(s_fb, BOARD_LCD_H_RES, BOARD_LCD_V_RES, &status);
    must(esp_lcd_panel_draw_bitmap(s_panel, 0, 0, BOARD_LCD_H_RES, BOARD_LCD_V_RES, s_fb), "first draw");

    // 首帧传输完成后再开背光。
    if (xSemaphoreTake(s_flush_done, pdMS_TO_TICKS(2000)) != pdTRUE) {
        fatal_halt("first flush timeout", ESP_ERR_TIMEOUT);
    }
    must(backlight_set_percent(BOARD_BL_PERCENT), "backlight on");
    s_backlight_on = true;
    ESP_LOGI(TAG, "BL on %d%%", BOARD_BL_PERCENT);
    if (xSemaphoreGive(s_flush_done) != pdTRUE) {
        fatal_halt("flush token", ESP_FAIL);
    }

    if (xTaskCreate(button_task, "button", 3072, NULL, 5, NULL) != pdPASS) {
        fatal_halt("button task create", ESP_ERR_NO_MEM);
    }

    uint32_t last_render_ms = 0;
    uint32_t last_alive_ms = 0;

    while (1) {
        const uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);
        const bool dirty = atomic_exchange(&s_dirty, false);
        const bool tick = (now_ms - last_render_ms) >= 1000;

        if (dirty || tick) {
            if (xSemaphoreTake(s_flush_done, pdMS_TO_TICKS(100)) == pdTRUE) {
                status.uptime_s = now_ms / 1000;
                status.count = (uint32_t)atomic_load(&s_count);
                status.pressed = atomic_load(&s_pressed);
                status.lcd_ok = s_lcd_ok;
                render_frame(s_fb, BOARD_LCD_H_RES, BOARD_LCD_V_RES, &status);
                must(esp_lcd_panel_draw_bitmap(s_panel, 0, 0, BOARD_LCD_H_RES, BOARD_LCD_V_RES, s_fb), "draw");
                last_render_ms = now_ms;
            } else {
                atomic_store(&s_dirty, true);
                if (now_ms - last_render_ms > 2000) {
                    fatal_halt("flush stuck", ESP_ERR_TIMEOUT);
                }
            }
        }

        if (now_ms - last_alive_ms >= 1000) {
            last_alive_ms = now_ms;
            ESP_LOGI(TAG, "ALIVE ms=%lu up_s=%lu count=%lu state=%s",
                     (unsigned long)now_ms,
                     (unsigned long)(now_ms / 1000),
                     (unsigned long)atomic_load(&s_count),
                     atomic_load(&s_pressed) ? "PRESSED" : "IDLE");
        }

        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

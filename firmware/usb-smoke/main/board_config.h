#pragma once

// Waveshare ESP32-S3-LCD-1.47B (-M) 板级常量。
// 来源：官方 Demo ZIP（SHA256 9e375aeb…）中 main/LCD_Driver/ST7789.h 与 LCD_Init()。
// 仅作为接脚与初始化事实参考；未整包复制官方代码。

#define BOARD_LCD_H_RES 172
#define BOARD_LCD_V_RES 320
#define BOARD_LCD_X_GAP 34
#define BOARD_LCD_Y_GAP 0

#define BOARD_LCD_HOST SPI3_HOST
#define BOARD_LCD_PIXEL_CLOCK_HZ (12 * 1000 * 1000)
#define BOARD_LCD_CMD_BITS 8
#define BOARD_LCD_PARAM_BITS 8

#define BOARD_PIN_LCD_SCLK 40
#define BOARD_PIN_LCD_MOSI 45
#define BOARD_PIN_LCD_CS 42
#define BOARD_PIN_LCD_DC 41
#define BOARD_PIN_LCD_RST 39
#define BOARD_PIN_LCD_BL 46

#define BOARD_PIN_BOOT 0

// 官方示例使用 BGR；当前实验按实机红蓝顺序反馈改为 RGB。
// 方向与偏移已由用户确认正常，红蓝顺序待重新编译烧写核对。
#define BOARD_LCD_RGB_ORDER LCD_RGB_ELEMENT_ORDER_RGB
#define BOARD_LCD_MIRROR_X false
#define BOARD_LCD_MIRROR_Y false
#define BOARD_LCD_INVERT true

#define BOARD_BL_PWM_HZ 4000
#define BOARD_BL_PWM_BITS LEDC_TIMER_13_BIT
#define BOARD_BL_PWM_MAX 8192
#define BOARD_BL_PERCENT 25

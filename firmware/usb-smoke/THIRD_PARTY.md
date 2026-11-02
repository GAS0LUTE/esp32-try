# 依赖与第三方说明（DEV-001）

## 实际使用的组件与许可

| 组件 | 版本 | 来源 | 许可 |
|---|---|---|---|
| ESP-IDF 核心 | v5.3.2（固定） | https://github.com/espressif/esp-idf | Apache-2.0 |
| esp_lcd（含 ST7789 驱动） | IDF v5.3.2 | 同上 | Apache-2.0 |
| driver（GPIO / SPI / LEDC） | IDF v5.3.2 | 同上 | Apache-2.0 |
| esp_timer | IDF v5.3.2 | 同上 | Apache-2.0 |
| FreeRTOS 内核 | IDF v5.3.2 捆绑版本 | 同上 | MIT（IDF 的 port/glue 为 Apache-2.0） |

本目录不引入额外组件；未使用 LVGL、Wi-Fi、BLE、音频库。
各组件完整许可证文本随 ESP-IDF 源码分发（`LICENSE`、`components/*/LICENSE*`）。

## 官方板级资料（只作事实参考，未复制代码）

- 官方 Demo ZIP：`ESP32-S3-LCD-1.47B-Demo.zip`
- SHA256：`9e375aeb82e4ad56212cbbfbf6a8dc7ddb1183469d9904b2d09c7ba070699e08`
- 参考文件：`ESP-IDF/ESP32-S3-LCD-1.47B-Test/main/LCD_Driver/ST7789.h`、`ST7789.c`、
  `LCD_Driver/Vernon_ST7789T/Vernon_ST7789T.c`、`main/main.c`。
- 官方示例事实：GPIO 45/40/42/41/39/46、SPI3、12 MHz、172×320、X 偏移 34、
  BGR、X 镜像、反色、LEDC 4 kHz / 13 bit。
- 当前实验配置：X/Y 镜像均为 false，分量顺序改为 RGB（`LCD_RGB_ELEMENT_ORDER_RGB`），
  反色与 X 偏移 34 保持不变；方向与边界已确认正常，红蓝顺序待实机复验。
- `Vernon_ST7789T.c/.h` 文件头声明 Apache-2.0；`ST7789.c/.h` 未见明确许可声明，
  因此仅将其中的引脚/初始化事实作为参考，未复制代码。
- 本固件使用 IDF 内置 ST7789 基础初始化，并补充 `set_gap(34,0)`、`mirror(false,false)`、`invert`；
  **未采用**官方 Demo 中完整的 gamma/电源等厂商寄存器序列，不宣称与官方显示效果等价，
  颜色、对比度、方向与偏移须实机核对。

## 自写代码

- `main/app_main.c`、`button_logic.*`、`display_render.*`、`font5x7.h`：为本项目编写。
- `font5x7.h` 为常见 5×7 点阵字形，自写整理，无第三方版权声明。

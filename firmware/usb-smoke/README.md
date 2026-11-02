# DEV-001：USB 屏幕与按键最小固件

状态：源码与主机自检完成；**未编译（本机无 ESP-IDF）**；实机未验证。
基线：ESP-IDF v5.3.2，target `esp32s3`，16MB Flash，USB Serial/JTAG 控制台。

## 行为

- 屏幕 172×320，RGB565，SPI3，12 MHz；X 偏移 34；当前 `MIRROR_X=false`、`MIRROR_Y=false`、`RGB` 分量顺序、反色开启。
- 显示实验标题、构建标识、运行秒数、按下计数、`IDLE`/`PRESSED`。
- 红/绿/蓝色块、四角标记、外框与刻度，用于颜色/方向/裁切判断。
- BOOT（GPIO0，低有效）非阻塞去抖 30 ms；长按只计一次；启动时已按住则先等待释放。
- 每 10 ms 采样按键；按下/松开写 USB 日志；每秒一次 `ALIVE`。
- 背光 GPIO46，LEDC 25%，启动关闭，首帧完成后打开；LEDC 调用失败会进入 `FATAL`。
- 按键任务创建失败、帧信号量异常都会进入 `FATAL` 并停住，不静默继续。
- 单帧缓冲 110,080 字节，DMA 完成前不复用；初始化或传输失败时记录 `FATAL` 并停住，不进入重启循环。

## 构建（固定版本）

```bash
# 一次性准备（由执行者决定是否安装；DS 未自动安装）
git clone -b v5.3.2 --recursive https://github.com/espressif/esp-idf.git ~/esp/esp-idf-v5.3.2
cd ~/esp/esp-idf-v5.3.2 && ./install.sh esp32s3
. ./export.sh

cd firmware/usb-smoke
idf.py set-target esp32s3
idf.py build
```

构建标识可通过 CMake 缓存覆盖：

```bash
idf.py -DFW_BUILD_ID=dev-001-20261102 build
```

构建产物（不要提交 Git）：

- `build/bootloader/bootloader.bin`
- `build/partition_table/partition-table.bin`
- `build/usb_smoke.bin`

烧写地址以 `build/flash_args` 为准；IDF 默认布局通常是 `0x0 / 0x8000 / 0x10000`。烧写前须核对实际分区表和镜像大小，并由 Codex 说明覆盖出厂程序的影响后再执行。

## 日志示例

```text
I (xxx) usb_smoke: BOOT build=dev-001 reset=POWERON
I (xxx) usb_smoke: BTN init raw=RELEASED (boot held -> release required before counting)
I (xxx) usb_smoke: LCD 172x320 RGB565, fb=110080 bytes, SPI 12000000 Hz
I (xxx) usb_smoke: BL on 25%
I (xxx) usb_smoke: BTN press count=1 ms=12345
I (xxx) usb_smoke: BTN release count=1 ms=12600
I (xxx) usb_smoke: ALIVE ms=13000 up_s=13 count=1 state=IDLE
```

## 主机自检（无需硬件）

```bash
bash test/host/run_tests.sh
```

覆盖：去抖 30 ms 边界、抖动不产生事件、长按只计一次、启动时按住、释放后再按、渲染四角/边界/状态文字、越界保护。

## 已知限制（需实机核对）

- 反色与 X 偏移取自官方 Demo 的板级事实；X 镜像已按实机反馈关闭，方向与边界已确认正常；分量顺序按实机红蓝反馈改为 RGB，待重新编译烧写核对颜色。若仍不正确，只调整 `main/board_config.h` 的一项参数。
- 像素字节序显式设为 `LCD_RGB_DATA_ENDIAN_LITTLE`，与未交换的 `uint16_t` RGB565 缓冲一致；RGB/BGR 分量顺序由 `rgb_ele_order` 单独控制。
- 使用 IDF 内置 ST7789 基础初始化，未采用官方完整 gamma/电源寄存器序列，显示效果待实机核对。
- 全帧缓冲 110 KB 需 DMA 内部 RAM；若分配失败会打印 `FATAL framebuffer alloc` 并停住。
- 背光 25% 的 PWM 频率/分辨率按官方示例取 4 kHz/13 bit。
- 未验证 PSRAM、Wi-Fi/BLE、SD、IMU、音频与电池。

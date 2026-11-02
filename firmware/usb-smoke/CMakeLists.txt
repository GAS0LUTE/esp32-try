cmake_minimum_required(VERSION 3.16)

set(FW_BUILD_ID "dev-001" CACHE STRING "Firmware build identifier shown on screen and in logs")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(usb_smoke)

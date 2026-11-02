idf_component_register(
    SRCS "app_main.c" "button_logic.c" "display_render.c"
    INCLUDE_DIRS "."
    REQUIRES esp_lcd driver esp_timer
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE FW_BUILD_ID="${FW_BUILD_ID}")

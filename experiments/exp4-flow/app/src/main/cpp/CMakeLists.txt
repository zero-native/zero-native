cmake_minimum_required(VERSION 3.22.1)
project(zn_renderer LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(hermes-engine REQUIRED CONFIG)

add_library(jsi_prebuilt SHARED IMPORTED)
set_target_properties(jsi_prebuilt PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libjsi.so"
)

add_library(zn SHARED
    zn_bridge.cpp
)

target_include_directories(zn PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_link_libraries(zn PRIVATE
    hermes-engine::hermesvm
    jsi_prebuilt
    log
)

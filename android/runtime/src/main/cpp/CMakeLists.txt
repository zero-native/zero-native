cmake_minimum_required(VERSION 3.22.1)
project(zn_android LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Targets the shared core expects (see core/CMakeLists.txt).
find_package(hermes-engine REQUIRED CONFIG)

add_library(zn_jsi SHARED IMPORTED)
set_target_properties(zn_jsi PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libjsi.so"
)

# Shared C++ core: <repo>/core (this file is <repo>/android/runtime/src/main/cpp).
add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../../../../../core" zn_core)

add_library(zn SHARED
    jni_bridge.cpp
)

target_link_libraries(zn PRIVATE
    zn_core
    android
    log
)

# Only the JNI entry points (compiled into this library, in jni_bridge.cpp) must be visible. Hiding the symbols of the
# static libraries (our core, MMKV) lets the linker drop the code nothing calls: without this, all of MMKV is kept.
target_link_options(zn PRIVATE -Wl,--exclude-libs,ALL -Wl,--gc-sections)

# zero-native C++ core, shared by Android and iOS (ARCHITECTURE.md §4).
#
# Targets:
#   zn_core_base  runtime rules (batch, timers, ticks, storage); no engine dependency, so it can be tested on its own
#   core          MMKV's C++ core (third_party/mmkv, BSD-3), built from source and linked into zn_core_base. Built
#                 against the shared C++ library we already ship: ~87 KB download, against ~370 KB for MMKV's AAR.
#   zn_core       zn_core_base + the Hermes engine adapter
#   zn_core_tests test executable (only when ZN_BUILD_TESTS=ON); see tools/run-core-tests.ps1
#
# The host build must define these targets before add_subdirectory(core):
#   hermes-engine::hermesvm   (Hermes prefab / framework)
#   zn_jsi                    (libjsi from the same release as Hermes)
cmake_minimum_required(VERSION 3.22.1)
project(zn_core LANGUAGES CXX)

option(ZN_BUILD_TESTS "Build the core test executable" OFF)

add_library(zn_core_base STATIC
  src/batch.cpp
  src/flowstore.cpp
  src/runtime.cpp
  src/utf8.cpp
  src/storage.cpp
)
set_target_properties(zn_core_base PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_features(zn_core_base PUBLIC cxx_std_20)
target_include_directories(zn_core_base PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

# MMKV (app storage). Its own CMake file, unchanged from upstream, so upgrading = replacing third_party/mmkv/Core.
add_subdirectory(third_party/mmkv/Core mmkv EXCLUDE_FROM_ALL)
target_link_libraries(zn_core_base PRIVATE core)
if(ANDROID)
  target_link_libraries(zn_core_base PRIVATE log)
endif()
if(APPLE)
  # MMKV's CMake sets FORCE_POSIX for its own files only. Without it here too, MMKV's headers switch to their
  # Objective-C API (NSString logs, a namespace) in storage.cpp. With it, Apple uses the same C++ API as Android.
  target_compile_definitions(zn_core_base PRIVATE FORCE_POSIX)
endif()

# The engine adapter is only built when the host provides Hermes (the test build doesn't).
if(TARGET hermes-engine::hermesvm)
  add_library(zn_core STATIC
    src/hermes_engine.cpp
  )
  set_target_properties(zn_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
  # JSI headers are private: Hermes' headers need them, our API never exposes them.
  target_include_directories(zn_core PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/jsi)
  target_link_libraries(zn_core PUBLIC zn_core_base hermes-engine::hermesvm zn_jsi)
endif()

if(ZN_BUILD_TESTS)
  add_executable(zn_core_tests tests/core_tests.cpp)
  target_link_libraries(zn_core_tests PRIVATE zn_core_base)
endif()

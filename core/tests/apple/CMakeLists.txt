# Builds the shared core on a Mac with Apple's Hermes (macOS framework), for tests that need the real engine.
# Hermes first: bun run tools/fetch-hermes-apple.ts
#
#   cmake -S core/tests/apple -B <build dir> && cmake --build <build dir>
#   ZN_TEST_DIR=<tmp dir> <build dir>/zn_core_tests                     (core rules, no engine)
#   <build dir>/zn_engine_tests android/sample/src/main/assets/main.hbc (the sample's bundle on Apple's Hermes)
cmake_minimum_required(VERSION 3.22.1)
project(zn_apple_host LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ZN_REPO "${CMAKE_CURRENT_SOURCE_DIR}/../../..")
set(ZN_HERMES_DIR "${ZN_REPO}/ios/third_party/hermes/debug/destroot" CACHE PATH "Hermes destroot (fetch-hermes-apple.ts)")
# The macOS framework, or the iOS simulator slice when cross-building for it:
#   -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_ARCHITECTURES=arm64
# then run with: xcrun simctl spawn booted <build dir>/zn_engine_tests <main.hbc>
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
  set(hermes_fw "${ZN_HERMES_DIR}/Library/Frameworks/universal/hermesvm.xcframework/ios-arm64_x86_64-simulator/hermesvm.framework")
else()
  set(hermes_fw "${ZN_HERMES_DIR}/Library/Frameworks/macosx/hermesvm.framework")
endif()
if(NOT EXISTS "${hermes_fw}/hermesvm")
  message(FATAL_ERROR "No Hermes at ${hermes_fw}. Run: bun run tools/fetch-hermes-apple.ts")
endif()

# The targets core/CMakeLists.txt expects from its host.
add_library(hermes-engine::hermesvm SHARED IMPORTED)
set_target_properties(hermes-engine::hermesvm PROPERTIES
  IMPORTED_LOCATION "${hermes_fw}/hermesvm"
  INTERFACE_INCLUDE_DIRECTORIES "${ZN_HERMES_DIR}/include"
)
# On Apple platforms JSI is built into hermesvm (no separate libjsi as on Android).
add_library(zn_jsi INTERFACE)

set(ZN_BUILD_TESTS ON CACHE BOOL "" FORCE)
add_subdirectory("${ZN_REPO}/core" zn_core)

add_executable(zn_engine_tests "${ZN_REPO}/core/tests/engine_tests.cpp")
target_link_libraries(zn_engine_tests PRIVATE zn_core)
set_target_properties(zn_engine_tests PROPERTIES BUILD_RPATH "${hermes_fw}/..")

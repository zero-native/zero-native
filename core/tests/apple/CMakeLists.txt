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

# ZNStorage (ios/ZnRuntime/Host/ZNHost.mm) and its Swift convenience (ios/ZnRuntime/Swift/ZnStorage.swift) on the Mac:
# znstorage_tests.mm. ZNHost.mm needs only Foundation and QuartzCore, so the Mac runs the iOS code as it is. Not in the
# simulator build (the CMake generator here doesn't build Swift; swiftc makes one object file the Mac test links).
if(NOT CMAKE_SYSTEM_NAME STREQUAL "iOS")
  enable_language(OBJCXX)
  execute_process(COMMAND xcrun -f swiftc OUTPUT_VARIABLE ZN_SWIFTC OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
  set(zn_storage_swift "${CMAKE_CURRENT_BINARY_DIR}/znstorage_swift.o")
  set(zn_storage_swift_src "${ZN_REPO}/ios/ZnRuntime/Swift/ZnStorage.swift" "${CMAKE_CURRENT_SOURCE_DIR}/znstorage_swift_check.swift")
  add_custom_command(OUTPUT "${zn_storage_swift}"
    COMMAND xcrun --sdk macosx swiftc -c -wmo -parse-as-library -module-name ZnStorageCheck -swift-version 5
      -import-objc-header "${ZN_REPO}/ios/ZnRuntime/Host/ZNHost.h" ${zn_storage_swift_src} -o "${zn_storage_swift}"
    DEPENDS ${zn_storage_swift_src} "${ZN_REPO}/ios/ZnRuntime/Host/ZNHost.h"
    COMMENT "swiftc ZnStorage.swift")
  set_source_files_properties("${zn_storage_swift}" PROPERTIES EXTERNAL_OBJECT TRUE GENERATED TRUE)
  add_executable(zn_znstorage_tests "${CMAKE_CURRENT_SOURCE_DIR}/znstorage_tests.mm" "${ZN_REPO}/ios/ZnRuntime/Host/ZNHost.mm"
    "${zn_storage_swift}")
  set_target_properties(zn_znstorage_tests PROPERTIES OBJCXX_STANDARD 20 BUILD_RPATH "${hermes_fw}/..")
  target_compile_options(zn_znstorage_tests PRIVATE -fobjc-arc)
  target_include_directories(zn_znstorage_tests PRIVATE "${ZN_REPO}/ios/ZnRuntime/Host")
  # The Swift runtime: the OS's (/usr/lib/swift) and the toolchain's compatibility libraries next to swiftc.
  get_filename_component(zn_swift_bin "${ZN_SWIFTC}" DIRECTORY)
  target_link_directories(zn_znstorage_tests PRIVATE /usr/lib/swift "${zn_swift_bin}/../lib/swift/macosx")
  target_link_libraries(zn_znstorage_tests PRIVATE zn_core "-framework Foundation" "-framework QuartzCore")
endif()

# zero-native C++ core, shared by Android and iOS (ARCHITECTURE.md §4).
#
# Targets:
#   zn_core_base  runtime rules (batch, timers, ticks); no engine dependency, so it can be tested on its own
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
)
set_target_properties(zn_core_base PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_features(zn_core_base PUBLIC cxx_std_20)
target_include_directories(zn_core_base PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)

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

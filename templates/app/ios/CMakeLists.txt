# The app on iOS: zero-native's C++ core, Hermes, its Objective-C++ host and Swift renderer, and the app shell (App/).
# One Xcode project, made by CMake's Xcode generator, as zero-native's own sample (zero-native/ios/CMakeLists.txt).
#
# tools/ios.ts does all of it (JS, configure, build, install, launch). By hand:
#   bun run app:js:ios
#   cmake -G Xcode -S ios -B ios/build/sim -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphonesimulator
#   xcodebuild -project ios/build/sim/__APP_CLASS__.xcodeproj -target __APP_CLASS__ -sdk iphonesimulator -configuration Debug build
#
# zero-native comes from ZN_DIR (the same folder as package.json and android/gradle.properties name). Another folder:
# -DZN_DIR=<path>. It needs `bun run tools/fetch-hermes-apple.ts` there (tools/ios.ts runs it when Hermes is missing).
cmake_minimum_required(VERSION 3.28)
project(__APP_CLASS__ LANGUAGES C CXX OBJC OBJCXX Swift)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 20)
set(CMAKE_OSX_DEPLOYMENT_TARGET 17.0)  # as zero-native's runtime (@Observable)
set(CMAKE_Swift_LANGUAGE_VERSION 5.0)  # as zero-native's runtime

set(ZN_DIR "__ZN_DIR_SUB__" CACHE PATH "The zero-native checkout (relative to this folder, or absolute)")
get_filename_component(ZN_DIR "${ZN_DIR}" REALPATH BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
if(NOT EXISTS "${ZN_DIR}/ios/ZnRuntime/Host/ZNHost.mm")
  message(FATAL_ERROR "No zero-native at ${ZN_DIR}. Pass -DZN_DIR=<path to zero-native>.")
endif()
set(ZN_IOS "${ZN_DIR}/ios")

# --- zero-native: Hermes and the C++ core (as zero-native/ios/CMakeLists.txt) ---
# Hermes: the debug build (asserts on) for everyday work, the release build for the App Store (-DZN_HERMES_FLAVOR=release
# after `bun run tools/fetch-hermes-apple.ts release` in zero-native).
set(ZN_HERMES_FLAVOR "debug" CACHE STRING "debug or release Hermes")
set_property(CACHE ZN_HERMES_FLAVOR PROPERTY STRINGS debug release)
set(ZN_HERMES_DIR "${ZN_IOS}/third_party/hermes/${ZN_HERMES_FLAVOR}/destroot")
set(hermes_xcf "${ZN_HERMES_DIR}/Library/Frameworks/universal/hermesvm.xcframework")
if(NOT EXISTS "${hermes_xcf}/Info.plist")
  message(FATAL_ERROR "No Hermes at ${hermes_xcf}. In zero-native, run: bun run tools/fetch-hermes-apple.ts ${ZN_HERMES_FLAVOR}")
endif()
add_library(hermes-engine::hermesvm SHARED IMPORTED)
set_target_properties(hermes-engine::hermesvm PROPERTIES
  IMPORTED_LOCATION "${hermes_xcf}"
  INTERFACE_INCLUDE_DIRECTORIES "${ZN_HERMES_DIR}/include"
)
add_library(zn_jsi INTERFACE)
# MMKV links zlib through find_library, which returns one SDK's absolute path. Plain `z` lets each SDK's linker find its own.
set(zlib "z" CACHE STRING "zlib for MMKV" FORCE)
add_subdirectory("${ZN_DIR}/core" zn_core)

# --- The app's bundle (bun run app:js:ios writes it to ios/bundle, not in git) ---
set(bundle_dir "${CMAKE_CURRENT_SOURCE_DIR}/bundle")
set(bundle_files "${bundle_dir}/main.hbc" "${bundle_dir}/main.zn.ui" "${bundle_dir}/main.zn.ui.json"
  "${bundle_dir}/zn-bundle.json")  # what the built-in bundle is: OTA bundles are checked against it
foreach(f IN LISTS bundle_files)
  if(NOT EXISTS "${f}")
    message(FATAL_ERROR "No ${f}. Run: bun run app:js:ios")
  endif()
endforeach()
# The app's own files (app/assets: images for `asset:` sources, ...), kept in their folders inside the app.
file(GLOB_RECURSE asset_files CONFIGURE_DEPENDS "${bundle_dir}/*")
list(REMOVE_ITEM asset_files ${bundle_files})
list(FILTER asset_files EXCLUDE REGEX "/\\.DS_Store$")
set(app_resources ${bundle_files})
foreach(f IN LISTS asset_files)
  file(RELATIVE_PATH rel "${bundle_dir}" "${f}")
  get_filename_component(dir "${rel}" DIRECTORY)
  if(dir STREQUAL "")
    list(APPEND app_resources "${f}")  # next to main.hbc
  else()
    set_source_files_properties("${f}" PROPERTIES MACOSX_PACKAGE_LOCATION "${dir}")
  endif()
endforeach()

# --- Swift: zero-native's runtime, the zero-native plugins the app uses, the app ---
file(GLOB zn_swift CONFIGURE_DEPENDS "${ZN_IOS}/ZnRuntime/Swift/*.swift")
# The zero-native plugins the app uses that have an iOS side (their folder names under zero-native/plugins), e.g.
# set(APP_ZN_PLUGINS location device-info). Add each to package.json too, and register it in App/AppDelegate.swift.
set(APP_ZN_PLUGINS "")
set(zn_plugin_swift "")
foreach(p IN LISTS APP_ZN_PLUGINS)
  file(GLOB s CONFIGURE_DEPENDS "${ZN_DIR}/plugins/${p}/ios/*.swift")
  if(NOT s)
    message(FATAL_ERROR "zero-native plugin ${p} has no iOS side at ${ZN_DIR}/plugins/${p}/ios")
  endif()
  list(APPEND zn_plugin_swift ${s})
endforeach()
# The app's own plugins (plugins/<name>/ios, docs/plugins.md) and the app shell.
file(GLOB app_plugin_swift CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../plugins/*/ios/*.swift")
file(GLOB app_swift CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/App/*.swift")

add_executable(__APP_CLASS__ MACOSX_BUNDLE
  "${ZN_IOS}/ZnRuntime/Host/ZNHost.mm"
  "${ZN_IOS}/ZnRuntime/Host/ZNHost.h"
  ${zn_swift}
  ${zn_plugin_swift}
  ${app_plugin_swift}
  ${app_swift}
  ${bundle_files}
  ${asset_files}
)
target_include_directories(__APP_CLASS__ PRIVATE "${ZN_IOS}/ZnRuntime/Host")
# CoreMotion: useTilt's gravity (Swift links it by itself too; said here as in the runtime's other builds).
target_link_libraries(__APP_CLASS__ PRIVATE zn_core "-framework QuartzCore" "-framework CoreMotion")

set_target_properties(__APP_CLASS__ PROPERTIES
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/App/Info.plist"
  RESOURCE "${app_resources}"
  XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "__APP_ID__"
  XCODE_ATTRIBUTE_MARKETING_VERSION "0.1.0"
  XCODE_ATTRIBUTE_CURRENT_PROJECT_VERSION "1"
  XCODE_ATTRIBUTE_SWIFT_OBJC_BRIDGING_HEADER "${ZN_IOS}/ZnRuntime/Host/ZnRuntime-Bridging-Header.h"
  XCODE_ATTRIBUTE_CLANG_ENABLE_OBJC_ARC YES
  XCODE_ATTRIBUTE_SWIFT_ACTIVE_COMPILATION_CONDITIONS "$<$<CONFIG:Debug>:DEBUG>"
  XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1"  # iPhone; "1,2" for iPad too
  XCODE_ATTRIBUTE_LD_RUNPATH_SEARCH_PATHS "@executable_path/Frameworks"
  XCODE_EMBED_FRAMEWORKS "${hermes_xcf}"
  XCODE_EMBED_FRAMEWORKS_CODE_SIGN_ON_COPY YES
)

# Signing. Simulator builds: ad hoc, no team. An iPhone build: -DAPP_TEAM=<your Apple team id> (Xcode's automatic
# signing with the team's development profile).
set(APP_TEAM "" CACHE STRING "Apple team id for device builds; empty: ad hoc (simulator)")
if(APP_TEAM STREQUAL "")
  set_target_properties(__APP_CLASS__ PROPERTIES
    XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "-"
    XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED NO)
else()
  set_target_properties(__APP_CLASS__ PROPERTIES
    XCODE_ATTRIBUTE_DEVELOPMENT_TEAM "${APP_TEAM}"
    XCODE_ATTRIBUTE_CODE_SIGN_STYLE "Automatic"
    XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "Apple Development")
endif()

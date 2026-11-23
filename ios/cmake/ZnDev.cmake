# `zn dev` on a real iPhone (ios/ZnRuntime/Swift/ZnDev.swift, tools/zn-dev.ts --lan): the Info.plist keys a Debug
# build needs to find the Mac on the local network, in the Debug build only. A Release (App Store, TestFlight) build
# keeps the app's own Info.plist as it is, so it never asks for Local Network access.
#
#   include("<zero-native>/ios/cmake/ZnDev.cmake")
#   zn_dev_info_plist(<target> "<the app's Info.plist>")   after MACOSX_BUNDLE_INFO_PLIST is set on the target
#
# The Debug build's Info.plist is the app's, filled in as CMake fills in MACOSX_BUNDLE_INFO_PLIST for Release
# (${VAR} and @VAR@, the MACOSX_BUNDLE_* target properties), with these added before its last </dict>:
# - NSLocalNetworkUsageDescription: what iOS shows when it asks for Local Network access (the first connect). An app
#   that has its own (a printing or casting plugin) keeps its text;
# - NSBonjourServices _zn-dev._tcp: iOS lets an app browse only for the Bonjour types it lists. Added to the app's own
#   list when it has one;
# - ZNDevHost $(ZN_DEV_HOST): where `zn dev` is when Bonjour can't find it (empty: Bonjour). Set with
#   -DZN_DEV_HOST=<the Mac's address> (or host:port), or ZN_DEV_HOST in the app's environment (an Xcode scheme). A
#   CMake cache value: it stays in this build folder until -DZN_DEV_HOST= (empty) clears it; the app gives up on it
#   after 3 failed tries (the Mac got a new address) and looks with Bonjour;
# - ZNDevMac: this Mac's LocalHostName, so the app prefers this Mac's `zn dev` when Bonjour sees several.
# No App Transport Security key: the dev connection is plain TCP (Network.framework), which ATS doesn't cover.
set(ZN_DEV_HOST "" CACHE STRING "Debug builds: where zn dev is (host or host:port; empty: Bonjour, or 127.0.0.1 on the simulator)")

function(zn_dev_info_plist target source)
  if(NOT ZN_DEV_HOST STREQUAL "")
    message(STATUS "zn dev: Debug builds of ${target} look for zn dev at ${ZN_DEV_HOST} first (-DZN_DEV_HOST= to clear)")
  endif()
  # As CMake fills in MACOSX_BUNDLE_INFO_PLIST (Release): the bundle's properties as MACOSX_BUNDLE_* variables.
  get_target_property(output ${target} OUTPUT_NAME)
  set(MACOSX_BUNDLE_EXECUTABLE_NAME "${target}")
  if(output)
    set(MACOSX_BUNDLE_EXECUTABLE_NAME "${output}")
  endif()
  foreach(p INFO_STRING ICON_FILE GUI_IDENTIFIER LONG_VERSION_STRING BUNDLE_NAME SHORT_VERSION_STRING BUNDLE_VERSION COPYRIGHT)
    get_target_property(v ${target} MACOSX_BUNDLE_${p})
    if(v)
      set(MACOSX_BUNDLE_${p} "${v}")
    endif()
  endforeach()
  set(out "${CMAKE_CURRENT_BINARY_DIR}/${target}-Info-Debug.plist")
  configure_file("${source}" "${out}.filled")
  file(READ "${out}.filled" text)
  file(REMOVE "${out}.filled")

  if(text MATCHES "<key>ZNDevHost</key>" OR text MATCHES "<key>ZNDevMac</key>")
    message(FATAL_ERROR "${source} has ZNDevHost or ZNDevMac: ZnDev.cmake adds them to Debug builds. Take them out of the Info.plist.")
  endif()
  execute_process(COMMAND scutil --get LocalHostName OUTPUT_VARIABLE mac OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  set(keys "\t<!-- zn dev on a real iPhone (Debug builds only; zero-native/ios/cmake/ZnDev.cmake) -->\n")
  if(NOT text MATCHES "<key>NSLocalNetworkUsageDescription</key>")
    string(APPEND keys "\t<key>NSLocalNetworkUsageDescription</key>\n"
      "\t<string>Debug builds connect to zn dev on your Mac for live reload.</string>\n")
  endif()
  if(text MATCHES "<key>NSBonjourServices</key>")
    # The app's own list: _zn-dev._tcp goes first in it (an empty <array/> becomes a list of one).
    if(NOT text MATCHES "<string>_zn-dev\\._tcp</string>")
      if(text MATCHES "<key>NSBonjourServices</key>[ \t\r\n]*<array/>")
        string(REGEX REPLACE "(<key>NSBonjourServices</key>[ \t\r\n]*)<array/>" "\\1<array>\n\t\t<string>_zn-dev._tcp</string>\n\t</array>" text "${text}")
      else()
        string(REGEX REPLACE "(<key>NSBonjourServices</key>[ \t\r\n]*<array>)" "\\1\n\t\t<string>_zn-dev._tcp</string>" text "${text}")
      endif()
      if(NOT text MATCHES "<string>_zn-dev\\._tcp</string>")
        message(FATAL_ERROR "${source}: NSBonjourServices isn't an <array>: ZnDev.cmake can't add _zn-dev._tcp to it")
      endif()
    endif()
  else()
    string(APPEND keys "\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>_zn-dev._tcp</string>\n\t</array>\n")
  endif()
  string(APPEND keys "\t<key>ZNDevHost</key>\n\t<string>$(ZN_DEV_HOST)</string>\n"
    "\t<key>ZNDevMac</key>\n\t<string>${mac}</string>\n")
  string(REGEX REPLACE "</dict>[ \t\r\n]*</plist>[ \t\r\n]*$" "${keys}</dict>\n</plist>\n" debug "${text}")
  if(debug STREQUAL text)
    message(FATAL_ERROR "${source} doesn't end with </dict></plist>: ZnDev.cmake can't add the Debug keys")
  endif()
  # Written only when it changes (the build doesn't redo the Info.plist on every configure).
  file(WRITE "${out}.new" "${debug}")
  configure_file("${out}.new" "${out}" COPYONLY)
  file(REMOVE "${out}.new")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
  set_target_properties(${target} PROPERTIES
    "XCODE_ATTRIBUTE_INFOPLIST_FILE[variant=Debug]" "${out}"
    XCODE_ATTRIBUTE_ZN_DEV_HOST "${ZN_DEV_HOST}")
endfunction()

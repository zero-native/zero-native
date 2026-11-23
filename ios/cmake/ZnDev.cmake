# `zn dev` on a real iPhone (ios/ZnRuntime/Swift/ZnDev.swift, tools/zn-dev.ts --lan): the Info.plist keys a Debug
# build needs to find the Mac on the local network, in the Debug build only. A Release (App Store, TestFlight) build
# keeps the app's own Info.plist as it is, so it never asks for Local Network access.
#
#   include("<zero-native>/ios/cmake/ZnDev.cmake")
#   zn_dev_info_plist(<target> "<the app's Info.plist>")   after MACOSX_BUNDLE_INFO_PLIST is set on the target
#
# The Debug build's Info.plist is the app's with these added before its last </dict>:
# - NSLocalNetworkUsageDescription: what iOS shows when it asks for Local Network access (the first connect);
# - NSBonjourServices _zn-dev._tcp: iOS lets an app browse only for the Bonjour types it lists;
# - ZNDevHost $(ZN_DEV_HOST): where `zn dev` is when Bonjour can't find it (empty: Bonjour). Set with
#   -DZN_DEV_HOST=<the Mac's address> (or host:port), or ZN_DEV_HOST in the app's environment (an Xcode scheme).
# No App Transport Security key: the dev connection is plain TCP (Network.framework), which ATS doesn't cover.
# An app that has its own NSBonjourServices or NSLocalNetworkUsageDescription: keep them out of its Info.plist and add
# them here instead (the plist can't have a key twice).
set(ZN_DEV_HOST "" CACHE STRING "Debug builds: where zn dev is (host or host:port; empty: Bonjour, or 127.0.0.1 on the simulator)")

function(zn_dev_info_plist target source)
  file(READ "${source}" text)
  set(keys [=[
	<!-- zn dev on a real iPhone (Debug builds only; zero-native/ios/cmake/ZnDev.cmake) -->
	<key>NSLocalNetworkUsageDescription</key>
	<string>Debug builds connect to zn dev on your Mac for live reload.</string>
	<key>NSBonjourServices</key>
	<array>
		<string>_zn-dev._tcp</string>
	</array>
	<key>ZNDevHost</key>
	<string>$(ZN_DEV_HOST)</string>
]=])
  foreach(key NSLocalNetworkUsageDescription NSBonjourServices ZNDevHost)
    if(text MATCHES "<key>${key}</key>")
      message(FATAL_ERROR "${source} has ${key}: ZnDev.cmake adds it to Debug builds. Take it out of the Info.plist.")
    endif()
  endforeach()
  string(REGEX REPLACE "</dict>[ \t\r\n]*</plist>[ \t\r\n]*$" "${keys}</dict>\n</plist>\n" debug "${text}")
  if(debug STREQUAL text)
    message(FATAL_ERROR "${source} doesn't end with </dict></plist>: ZnDev.cmake can't add the Debug keys")
  endif()
  set(out "${CMAKE_CURRENT_BINARY_DIR}/${target}-Info-Debug.plist")
  # Written only when it changes (the build doesn't redo the Info.plist on every configure).
  file(WRITE "${out}.new" "${debug}")
  configure_file("${out}.new" "${out}" COPYONLY)
  file(REMOVE "${out}.new")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
  set_target_properties(${target} PROPERTIES
    "XCODE_ATTRIBUTE_INFOPLIST_FILE[variant=Debug]" "${out}"
    XCODE_ATTRIBUTE_ZN_DEV_HOST "${ZN_DEV_HOST}")
endfunction()

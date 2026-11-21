// ZNStorage (ios/ZnRuntime/Host/ZNHost.mm) on a Mac: typed values from native code in the format JS and Android use
// (core/include/zn/storage.h), read back through a second zn::Storage on the same folder, as the JS runtime has one.
// Then the Swift convenience (ios/ZnRuntime/Swift/ZnStorage.swift, znstorage_swift_check.swift) on the same stores.
//
//   zn_znstorage_tests        (run by tools/run-core-tests-apple.ts; ZN_TEST_DIR is the home folder it uses)
#import <Foundation/Foundation.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#import "ZNHost.h"
#include "zn/storage.h"

extern "C" int zn_storage_swift_check(void);  // znstorage_swift_check.swift: the number of failed checks

namespace {

int g_failed = 0;
int g_checks = 0;

#define CHECK(cond)                                                              \
  do {                                                                           \
    g_checks++;                                                                  \
    if (!(cond)) {                                                               \
      g_failed++;                                                                \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);              \
    }                                                                            \
  } while (0)

using Blob = std::vector<uint8_t>;

Blob blob(std::initializer_list<uint8_t> b) { return Blob(b); }

std::string storageDir() {
  NSURL* base = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                     inDomains:NSUserDomainMask].firstObject;
  return std::string([base URLByAppendingPathComponent:@"zn-storage"].path.UTF8String);
}

void testWritesInJsFormat(zn::Storage& js) {
  std::printf("ZNStorage writes each type in the tagged format JS reads ([type][payload], little-endian doubles)\n");
  NSString* st = @"zn.native-test";
  [ZNStorage clear:st];
  CHECK([ZNStorage set:st key:@"s" string:@"hé\0y"]);  // a NUL inside is kept, as JS keeps it
  CHECK([ZNStorage set:st key:@"n" number:1.5]);
  CHECK([ZNStorage set:st key:@"t" boolean:YES]);
  CHECK([ZNStorage set:st key:@"f" boolean:NO]);
  const uint8_t raw[] = {0, 1, 255};
  CHECK([ZNStorage set:st key:@"b" data:[NSData dataWithBytes:raw length:3]]);
  CHECK([ZNStorage set:st key:@"e" string:@""]);
  CHECK([ZNStorage set:st key:@"z" data:[NSData data]]);

  CHECK(js.get("zn.native-test", "s") == blob({1, 'h', 0xC3, 0xA9, 0, 'y'}));
  CHECK(js.get("zn.native-test", "n") == blob({2, 0, 0, 0, 0, 0, 0, 0xF8, 0x3F}));
  CHECK(js.get("zn.native-test", "t") == blob({3, 1}));
  CHECK(js.get("zn.native-test", "f") == blob({3, 0}));
  CHECK(js.get("zn.native-test", "b") == blob({4, 0, 1, 255}));
  CHECK(js.get("zn.native-test", "e") == blob({1}));
  CHECK(js.get("zn.native-test", "z") == blob({4}));

  // And back, each with its type.
  CHECK([[ZNStorage string:st key:@"s"] isEqualToString:@"hé\0y"]);
  CHECK([[ZNStorage number:st key:@"n"] doubleValue] == 1.5);
  CHECK([[ZNStorage boolean:st key:@"t"] isEqual:@YES] && [[ZNStorage boolean:st key:@"f"] isEqual:@NO]);
  CHECK([[ZNStorage data:st key:@"b"] isEqualToData:[NSData dataWithBytes:raw length:3]]);
  CHECK([[ZNStorage string:st key:@"e"] isEqualToString:@""] && [ZNStorage data:st key:@"z"].length == 0);
  CHECK([ZNStorage data:st key:@"z"] != nil);  // empty bytes are a value, not missing
}

void testReadsJsValues(zn::Storage& js) {
  std::printf("ZNStorage reads what JS writes, with its type; a getter of another type answers nil\n");
  NSString* st = @"zn.default";  // JS's `storage`
  js.clear("zn.default");
  CHECK(js.set("zn.default", "name", blob({1, 'z', 'n'})));
  CHECK(js.set("zn.default", "count", blob({2, 0, 0, 0, 0, 0, 0, 0xF0, 0x3F})));  // 1.0
  CHECK(js.set("zn.default", "on", blob({3, 1})));
  CHECK(js.set("zn.default", "raw", blob({4, 9, 8})));

  CHECK([[ZNStorage string:st key:@"name"] isEqualToString:@"zn"]);
  CHECK([[ZNStorage number:st key:@"count"] doubleValue] == 1.0);
  CHECK([[ZNStorage boolean:st key:@"on"] isEqual:@YES]);
  NSData* raw = [ZNStorage data:st key:@"raw"];
  CHECK(raw.length == 2 && static_cast<const uint8_t*>(raw.bytes)[0] == 9 && static_cast<const uint8_t*>(raw.bytes)[1] == 8);

  CHECK([ZNStorage storedType:st key:@"name"] == ZNStoredTypeString);
  CHECK([ZNStorage storedType:st key:@"count"] == ZNStoredTypeNumber);
  CHECK([ZNStorage storedType:st key:@"on"] == ZNStoredTypeBoolean);
  CHECK([ZNStorage storedType:st key:@"raw"] == ZNStoredTypeBytes);
  CHECK([ZNStorage storedType:st key:@"missing"] == ZNStoredTypeNone);

  // Another type: nil, never a wrong value (a number isn't read as a boolean, a string as bytes).
  CHECK([ZNStorage string:st key:@"count"] == nil);
  CHECK([ZNStorage number:st key:@"on"] == nil);
  CHECK([ZNStorage boolean:st key:@"count"] == nil);
  CHECK([ZNStorage data:st key:@"name"] == nil);
  CHECK([ZNStorage number:st key:@"missing"] == nil);

  // Data JS doesn't write (another tag, a number of the wrong size, an empty value): unknown, every getter nil.
  CHECK(js.set("zn.default", "odd", blob({7, 1})));
  CHECK(js.set("zn.default", "short", blob({2, 0, 0})));
  CHECK(js.set("zn.default", "empty", Blob{}));
  for (NSString* k in @[ @"odd", @"short", @"empty" ]) {
    CHECK([ZNStorage storedType:st key:k] == ZNStoredTypeUnknown);
    CHECK([ZNStorage number:st key:k] == nil && [ZNStorage string:st key:k] == nil && [ZNStorage data:st key:k] == nil);
    CHECK([ZNStorage has:st key:k]);
  }
}

void testNumbers(zn::Storage& js) {
  std::printf("numbers are JS doubles: 2^53, -0, infinities and NaN come back as saved\n");
  NSString* st = @"zn.native-test";
  const double values[] = {9007199254740992.0, -0.0, 1e308, -2.5e-300, INFINITY, -INFINITY};
  for (double v : values) {
    CHECK([ZNStorage set:st key:@"x" number:v]);
    const double back = [[ZNStorage number:st key:@"x"] doubleValue];
    CHECK(std::memcmp(&back, &v, 8) == 0);
    auto b = js.get("zn.native-test", "x");
    CHECK(b && b->size() == 9 && std::memcmp(b->data() + 1, &v, 8) == 0);
  }
  CHECK([ZNStorage set:st key:@"x" number:NAN]);
  CHECK(std::isnan([[ZNStorage number:st key:@"x"] doubleValue]));
}

void testKeysHasRemoveClear(zn::Storage& js) {
  std::printf("has, keys, remove and clear see the same keys as JS\n");
  NSString* st = @"zn.native-keys";
  [ZNStorage clear:st];
  CHECK([ZNStorage keys:st].count == 0);
  [ZNStorage set:st key:@"a" string:@"1"];
  [ZNStorage set:st key:@"b" number:2];
  CHECK(js.set("zn.native-keys", "c", blob({3, 1})));  // a key JS wrote
  NSArray<NSString*>* keys = [[ZNStorage keys:st] sortedArrayUsingSelector:@selector(compare:)];
  CHECK([keys isEqualToArray:(@[ @"a", @"b", @"c" ])]);
  CHECK([ZNStorage has:st key:@"c"] && ![ZNStorage has:st key:@"d"]);
  CHECK([ZNStorage remove:st key:@"a"]);
  CHECK(![ZNStorage has:st key:@"a"] && !js.has("zn.native-keys", "a"));
  [ZNStorage flush:st];
  [ZNStorage clear:st];
  CHECK([ZNStorage keys:st].count == 0 && js.keys("zn.native-keys").empty());
  CHECK(js.keys("zn.default").size() > 0);  // other stores are untouched
}

void testBadArguments() {
  std::printf("a bad store id or an empty key: NO / nil / no keys, nothing written (JS refuses them too)\n");
  CHECK(![ZNStorage set:@"../x" key:@"k" string:@"v"]);
  CHECK(![ZNStorage set:@"a/b" key:@"k" number:1]);
  CHECK(![ZNStorage set:@"" key:@"k" boolean:YES]);
  CHECK(![ZNStorage set:[@"" stringByPaddingToLength:65 withString:@"a" startingAtIndex:0] key:@"k" string:@"v"]);
  CHECK(![ZNStorage set:@"zn.native-test" key:@"" string:@"v"]);
  CHECK([ZNStorage string:@"../x" key:@"k"] == nil);
  CHECK([ZNStorage storedType:@"zn.native-test" key:@""] == ZNStoredTypeNone);
  CHECK(![ZNStorage has:@"a/b" key:@"k"]);
  CHECK([ZNStorage keys:@"a/b"].count == 0);
  [ZNStorage clear:@"a/b"];  // no crash, nothing opened
  // "../x" would have been a file next to the storage folder.
  CHECK(![NSFileManager.defaultManager fileExistsAtPath:[@(storageDir().c_str()) stringByAppendingPathComponent:@"../x"]]);
}

}  // namespace

int main() {
  @autoreleasepool {
    // Foundation's home folder for this process (Application Support is under it): the test folder, not the Mac's.
    const char* base = std::getenv("ZN_TEST_DIR");
    std::string home = std::string(base && *base ? base : "/tmp") + "/zn-znstorage-home";
    [NSFileManager.defaultManager createDirectoryAtPath:@(home.c_str()) withIntermediateDirectories:YES attributes:nil error:nil];
    setenv("CFFIXED_USER_HOME", home.c_str(), 1);
    // Compared without symlinks: Foundation may say /tmp for /private/tmp.
    home = std::string(@(home.c_str()).stringByResolvingSymlinksInPath.UTF8String);
    const std::string dir = storageDir();
    const std::string realDir = std::string(@(dir.c_str()).stringByResolvingSymlinksInPath.UTF8String);
    CHECK(realDir.rfind(home, 0) == 0);  // really under the test folder
    if (realDir.rfind(home, 0) != 0) {
      std::printf("  storage folder %s is outside %s: stopping\n", dir.c_str(), home.c_str());
      return 1;
    }
    [NSFileManager.defaultManager createDirectoryAtPath:@(dir.c_str()) withIntermediateDirectories:YES attributes:nil error:nil];

    // The JS runtime's own zn::Storage on the same folder (IosPlatform::storageDir).
    zn::Storage js(dir, nullptr);
    testWritesInJsFormat(js);
    testReadsJsValues(js);
    testNumbers(js);
    testKeysHasRemoveClear(js);
    testBadArguments();

    std::printf("the Swift convenience (ZnStorage.store) on the same stores\n");
    const int swiftFailed = zn_storage_swift_check();
    g_checks++;
    if (swiftFailed) {
      g_failed++;
      std::printf("  FAIL %d Swift check(s)\n", swiftFailed);
    }
    // What Swift saved is JS's format too.
    CHECK(js.get("zn.default", "swift.n") == blob({2, 0, 0, 0, 0, 0, 0, 0x45, 0x40}));  // 42
    CHECK(js.get("zn.default", "swift.on") == blob({3, 1}));
  }
  std::printf("\n%d checks, %d failed\n%s\n", g_checks, g_failed, g_failed ? "FAILED" : "OK");
  return g_failed ? 1 : 0;
}

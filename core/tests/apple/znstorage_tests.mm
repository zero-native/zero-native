// ZNStorage (ios/ZnRuntime/Host/ZNHost.mm) on a Mac: typed values from native code in the format JS and Android use
// (core/include/zn/storage.h), read back through a second zn::Storage on the same folder, as the JS runtime has one.
// Then the Swift convenience (ios/ZnRuntime/Swift/ZnStorage.swift, znstorage_swift_check.swift) on the same stores.
//
//   zn_znstorage_tests        (run by tools/run-core-tests-apple.ts; ZN_TEST_DIR is the home folder it uses)
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
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

void testNotUtf8(zn::Storage& js) {
  std::printf("text that isn't valid UTF-8 (JS can save a lone surrogate): U+FFFD for each bad part, as on Android\n");
  NSString* st = @"zn.native-utf8";
  [ZNStorage clear:st];
  // Hermes writes a lone surrogate (U+D800) as ED A0 80: three bad parts, as Java's and Swift's decoders count them.
  CHECK(js.set("zn.native-utf8", std::string("k\xED\xA0\x80", 4), blob({1, 'v'})));
  NSArray<NSString*>* keys = [ZNStorage keys:st];
  CHECK(keys.count == 1 && [keys.firstObject isEqualToString:@"k\uFFFD\uFFFD\uFFFD"]);
  CHECK(js.set("zn.native-utf8", "lone", blob({1, 'a', 0xED, 0xA0, 0x80, 'b'})));
  CHECK([[ZNStorage string:st key:@"lone"] isEqualToString:@"a\uFFFD\uFFFD\uFFFDb"]);
  // A good 4-byte character next to a bad byte stays; a cut-off sequence is one bad part.
  CHECK(js.set("zn.native-utf8", "mixed", blob({1, 0xF0, 0x9F, 0x98, 0x80, 0xFF, 'x', 0xE2, 0x82})));
  CHECK([[ZNStorage string:st key:@"mixed"] isEqualToString:@"\U0001F600\uFFFDx\uFFFD"]);
  CHECK(js.set("zn.native-utf8", "overlong", blob({1, 0xC0, 0xAF, 0xE0, 0x80, 0xAF})));  // never valid
  CHECK([[ZNStorage string:st key:@"overlong"] isEqualToString:@"\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"]);
  // Saving a lone surrogate from native code doesn't crash and saves a string.
  const unichar lone = 0xD800;
  CHECK([ZNStorage set:st key:@"fromNative" string:[NSString stringWithCharacters:&lone length:1]]);
  CHECK([ZNStorage storedType:st key:@"fromNative"] == ZNStoredTypeString);
  [ZNStorage clear:st];
}

void testAnyThread() {
  std::printf("calls from many threads at once, first opens of stores among them, are serialized (no race)\n");
  // Each thread opens stores of its own for the first time while the others use a shared one: the map of open stores
  // is written then. A smoke test only: with the lock taken out it still passed (6 runs, 2026-11-21); the lock is there
  // because storage.h says one Storage isn't thread-safe, as Android's g_storageMutex.
  const size_t threads = 16, stores = 16, each = 40;
  std::atomic<int> failures{0};
  std::atomic<int>* wrongp = &failures;  // a block copies what it captures; an atomic can't be copied
  dispatch_apply(threads, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t t) {
    std::atomic<int>& wrong = *wrongp;
    NSString* shared = @"zn.native-thread-shared";
    for (size_t s = 0; s < stores; s++) {
      NSString* own = [NSString stringWithFormat:@"zn.native-thread-%zu-%zu", t, s];
      for (size_t i = 0; i < each; i++) {
        NSString* key = [NSString stringWithFormat:@"%zu.%zu.%zu", t, s, i];
        if (![ZNStorage set:own key:key number:static_cast<double>(i)]) wrong++;
        if (![ZNStorage set:shared key:key boolean:(i & 1) != 0]) wrong++;
        if ([[ZNStorage number:own key:key] doubleValue] != static_cast<double>(i)) wrong++;
        if ([[ZNStorage boolean:shared key:key] boolValue] != ((i & 1) != 0)) wrong++;
      }
      if ([ZNStorage keys:own].count != each) wrong++;
    }
  });
  CHECK(failures.load() == 0);
  CHECK([ZNStorage keys:@"zn.native-thread-shared"].count == threads * stores * each);
  for (size_t t = 0; t < threads; t++) {
    for (size_t s = 0; s < stores; s++) [ZNStorage clear:[NSString stringWithFormat:@"zn.native-thread-%zu-%zu", t, s]];
  }
  [ZNStorage clear:@"zn.native-thread-shared"];
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
    testNotUtf8(js);
    testAnyThread();

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

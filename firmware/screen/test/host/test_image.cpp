#include <cstdio>
#include <cstdlib>
#include <vector>
#include "../../src/image.h"
EspShim ESP;

static std::vector<uint8_t> load(const char* f) {
  FILE* fp = fopen(f, "rb"); std::vector<uint8_t> d;
  if (!fp) { printf("can't open %s\n", f); exit(2); }
  int c; while ((c = fgetc(fp)) != EOF) d.push_back((uint8_t)c); fclose(fp); return d;
}

static bool run(const std::vector<uint8_t>& d, size_t declared, unsigned seed, String& err, bool& crc) {
  ImageCheck c; c.begin(declared); srand(seed);
  size_t i = 0;
  while (i < d.size()) {
    size_t n = seed ? 1 + rand() % 2048 : 2048;
    n = std::min(n, d.size() - i);
    c.add(d.data() + i, n); i += n;
  }
  crc = c.hasCrc();
  return c.finish(err);
}

#include "coredecls.h"
static void fixCrc(std::vector<uint8_t>& d) {
  uint8_t keep[8]; for (int i = 0; i < 8; i++) { keep[i] = d[0x1010 + i]; d[0x1010 + i] = 0; }
  uint32_t c = crc32(d.data(), d.size());
  for (int i = 0; i < 4; i++) d[0x1010 + i] = keep[i];
  for (int i = 0; i < 4; i++) d[0x1014 + i] = (c >> (8 * i)) & 0xff;
}
static int failures = 0;
static void expect(const char* what, bool want, const std::vector<uint8_t>& d, size_t declared, unsigned seed = 0) {
  String err; bool crc;
  bool ok = run(d, declared, seed, err, crc);
  bool pass = ok == want;
  if (!pass) failures++;
  printf("%s %-44s -> %s%s%s\n", pass ? "PASS" : "FAIL", what, ok ? "ok" : "rejected: ", ok ? (crc ? " (crc)" : " (no crc)") : err.c_str(), "");
}

int main(int argc, char** argv) {
  auto ours = load(argv[1]);
  auto stock = load(argv[2]);
  expect("our image", true, ours, ours.size());
  for (unsigned s = 1; s <= 20; s++) expect("our image, random chunks", true, ours, ours.size(), s);
  expect("stock image", true, stock, stock.size());
  expect("stock image, random chunks", true, stock, stock.size(), 7);
  auto t = ours; t.resize(t.size() - 100);
  expect("our image truncated, declared short", false, t, t.size());
  expect("our image truncated, declared full", false, t, ours.size());
  auto b = ours; b[200000] ^= 0x01;
  expect("one bit flipped in irom", false, b, b.size());
  auto b2 = ours; b2[ours.size() - 1] ^= 0xff;
  expect("checksum byte wrong", false, b2, b2.size());
  auto b3 = ours; b3[0x1000] = 0x00;
  expect("app magic wrong", false, b3, b3.size());
  auto b4 = ours; b4.push_back(0);
  expect("extra byte at the end", false, b4, b4.size());
  auto b5 = ours; b5[3] = (b5[3] & 0x0f) | 0x90;
  expect("boot header says 16 MB flash", false, b5, b5.size());
  auto s1 = stock; s1[100000] ^= 0x80;
  expect("stock, one bit flipped (segment checksum)", false, s1, s1.size());
  auto sw = ours; std::swap(sw[150000], sw[150001]); if (sw[150000] == sw[150001]) std::swap(sw[150000], sw[150010]);
  expect("two bytes swapped (only the CRC sees it)", false, sw, sw.size());
  auto cw = ours; cw[0x1014] ^= 0x10;
  expect("CRC word changed", false, cw, cw.size());
  auto bl = stock; bl[0x0100] ^= 0x04;
  expect("stock, boot loader byte flipped", false, bl, bl.size());
  auto bl2 = ours; bl2[0x0100] ^= 0x04; fixCrc(bl2);
  expect("ours, boot loader byte flipped, CRC redone", false, bl2, bl2.size());
  auto oor = ours; oor[0x1008] = 0x00; oor[0x1009] = 0x00; oor[0x100a] = 0x00; oor[0x100b] = 0x50; fixCrc(oor);
  expect("irom segment at 0x50000000, CRC redone", false, oor, oor.size());
  auto ok2 = ours; fixCrc(ok2);
  expect("ours with CRC recomputed (sanity)", true, ok2, ok2.size());
  std::vector<uint8_t> junk(300000, 0xAB); junk[0] = 0xE9;
  expect("junk starting with E9", false, junk, junk.size());
  printf("%d failure(s)\n", failures);
  return failures ? 1 : 0;
}

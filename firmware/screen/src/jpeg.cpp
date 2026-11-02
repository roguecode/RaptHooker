#include "jpeg.h"

#include "tjpgd/tjpgd.h"

struct Source {
  const uint8_t* data;
  size_t len;
  size_t pos;
  int16_t x, y;
  jpeg::Output out;
};

static size_t input(JDEC* jd, uint8_t* buf, size_t n) {
  Source* s = (Source*)jd->device;
  n = min(n, s->len - s->pos);
  if (buf) memcpy_P(buf, s->data + s->pos, n);  // works for RAM as well as flash
  s->pos += n;
  return n;
}

static int output(JDEC* jd, void* bitmap, JRECT* r) {
  Source* s = (Source*)jd->device;
  return s->out(r->left + s->x, r->top + s->y, r->right + 1 - r->left, r->bottom + 1 - r->top, (uint16_t*)bitmap);
}

static int run(const uint8_t* data, size_t len, int16_t x, int16_t y, jpeg::Output out, uint16_t* w, uint16_t* h) {
  void* work = malloc(TJPGD_WORKSPACE_SIZE);
  if (!work) return -1;
  Source s = {data, len, 0, x, y, out};
  JDEC jd;
  jd.swap = 1;  // TFT_eSPI wants the bytes of each pixel swapped
  JRESULT r = jd_prepare(&jd, input, work, TJPGD_WORKSPACE_SIZE, &s);
  if (r == JDR_OK) {
    if (w) *w = jd.width;
    if (h) *h = jd.height;
    if (out) r = jd_decomp(&jd, output, 0);
  }
  free(work);
  return r;
}

int jpeg::size(const uint8_t* data, size_t len, uint16_t& w, uint16_t& h) {
  return run(data, len, 0, 0, nullptr, &w, &h);
}

int jpeg::draw(const uint8_t* data, size_t len, int16_t x, int16_t y, Output out) {
  return run(data, len, x, y, out, nullptr, nullptr);
}

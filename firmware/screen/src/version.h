#pragma once

#define FW_NAME "rapthooker-screen"
#define FW_VERSION "1.1.1"
// Bump when the HTTP API gains something RaptHooker needs to know about. A newer level only ever adds:
// nothing an older level offered is removed or changes meaning.
#define FW_API 1

#ifndef RH_MODEL
#error "RH_MODEL must be set by the build (platformio.ini)"
#endif

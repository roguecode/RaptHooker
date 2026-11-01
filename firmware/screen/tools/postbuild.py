# Checks the built image is safe to send over the stock firmware's OTA and writes the release files.
import hashlib, json, os, re, shutil, struct

Import("env")  # noqa: F821

# The stock /update_ota drops everything past 512 KB and still commits what it got, which would brick the
# screen. Keep a margin under that.
STOCK_OTA_LIMIT = 0x80000
SIZE_LIMIT = 0x7C000


def check(source, target, env):
    path = str(target[0])
    data = open(path, "rb").read()
    size = len(data)
    if size > SIZE_LIMIT:
        raise SystemExit(f"firmware is {size} bytes: over the {SIZE_LIMIT} byte limit (stock OTA takes {STOCK_OTA_LIMIT})")
    magic, segs, mode, size_freq = struct.unpack_from("<BBBB", data, 0)
    if magic != 0xE9 or mode != 2 or (size_freq >> 4) != 4:
        raise SystemExit(f"unexpected image header {data[:4].hex()}: want E9 .. 02 4x (DIO, 4 MB)")
    app = data[0x1000:0x1004]
    if app[0] != 0xE9 or app[2] != 2 or (app[3] >> 4) != 4:
        raise SystemExit(f"unexpected app header {app.hex()}")
    src = open(os.path.join(env["PROJECT_DIR"], "src", "version.h")).read()
    version = re.search(r'FW_VERSION\s+"([^"]+)"', src).group(1)
    api = int(re.search(r"FW_API\s+(\d+)", src).group(1))
    model = env.GetProjectOption("build_flags")
    model = re.search(r'RH_MODEL=\\?"([^"\\]+)', " ".join(model) if isinstance(model, list) else model).group(1)
    if f"RHSCREEN-FW:{model}:".encode() not in data:
        raise SystemExit("firmware marker missing")
    out = os.path.join(env["PROJECT_DIR"], "bin")
    os.makedirs(out, exist_ok=True)
    # A fixed name per model, so the RaptHooker server can embed it; the stock firmware's "SDP" file name is made up
    # when it's sent.
    name = f"{model}.bin"
    for old in os.listdir(out):
        if old.startswith("SDP-"):
            os.remove(os.path.join(out, old))
    shutil.copyfile(path, os.path.join(out, name))
    manifest = {
        "model": model,
        "version": version,
        "api": api,
        "file": name,
        "size": size,
        "md5": hashlib.md5(data).hexdigest(),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    with open(os.path.join(out, f"{model}.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"firmware {name}: {size} bytes ({size * 100 // STOCK_OTA_LIMIT}% of the stock OTA limit) md5 {manifest['md5']}")


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", check)  # noqa: F821

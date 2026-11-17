# Checks the built image and writes the release files into bin/ (which the RaptHooker server embeds):
#   <model>.bin       the firmware, as sent over the network (and, on ESP32 boards, written at 0x10000 over USB)
#   <model>.boot.bin  ESP32 only: flash from 0x1000 to 0x10000 for the first install over USB: the boot loader, the
#                     partition table, an empty NVS and the OTA data that starts app0
#   <model>.json      what's in them
import hashlib, json, os, re, shutil, struct, subprocess

Import("env")  # noqa: F821

# The ESP32-C2 is RV32IMC. pioarduino's build script for it gives neither the compiler (platformio.ini does) nor the
# linker the architecture, so the linker would take the C and C++ libraries built for the toolchain's default, which use
# atomic instructions the chip doesn't have.
RV32IMC = ["-march=rv32imc_zicsr_zifencei", "-mabi=ilp32"]
if env.BoardConfig().get("build.mcu", "") == "esp32c2":  # noqa: F821
    env.Append(LINKFLAGS=RV32IMC)  # noqa: F821

# ESP8266: the stock /update_ota drops everything past 512 KB and still commits what it got, which would brick the
# screen. Keep a margin under that.
STOCK_OTA_LIMIT = 0x80000
SIZE_LIMIT = 0x7C000

# ESP32: the layout written at set-up (partitions-esp32.csv).
BOOT_AT = 0x1000
APP_AT = 0x10000
PARTITIONS_AT = 0x8000
OTADATA_AT = 0xE000


def project_file(*parts):
    return os.path.join(env["PROJECT_DIR"], *parts)  # noqa: F821


def model_and_version(env):
    src = open(project_file("src", "version.h")).read()
    version = re.search(r'FW_VERSION\s+"([^"]+)"', src).group(1)
    api = int(re.search(r"FW_API\s+(\d+)", src).group(1))
    flags = env.GetProjectOption("build_flags")
    model = re.search(r'RH_MODEL=\\?"([^"\\]+)', " ".join(flags) if isinstance(flags, list) else flags).group(1)
    return model, version, api


def check_esp8266(data):
    size = len(data)
    if size > SIZE_LIMIT:
        raise SystemExit(f"firmware is {size} bytes: over the {SIZE_LIMIT} byte limit (stock OTA takes {STOCK_OTA_LIMIT})")
    magic, segs, mode, size_freq = struct.unpack_from("<BBBB", data, 0)
    if magic != 0xE9 or mode != 2 or (size_freq >> 4) != 4:
        raise SystemExit(f"unexpected image header {data[:4].hex()}: want E9 .. 02 4x (DIO, 4 MB)")
    app = data[0x1000:0x1004]
    if app[0] != 0xE9 or app[2] != 2 or (app[3] >> 4) != 4:
        raise SystemExit(f"unexpected app header {app.hex()}")
    print(f"{size * 100 // STOCK_OTA_LIMIT}% of the stock OTA limit")


def app_partition_size(env):
    name = env.GetProjectOption("board_build.partitions")
    for line in open(project_file(name)):
        cols = [c.strip() for c in line.split("#")[0].split(",")]
        if len(cols) >= 5 and cols[0] == "app0":
            return int(cols[4], 0)
    raise SystemExit(f"no app0 in {name}")


# The chip id esp_image_header_t carries at 12.
CHIP_IDS = {"esp32": 0, "esp32c2": 12}
SDC2_STOCK_LIMIT = 0xBE000


def check_esp32(data, chip, env):
    # esp_image_header_t: magic, segments, flash mode, size/speed, entry, then the extended header with the chip id at
    # 12 and "hash appended" at 23.
    if data[0] != 0xE9 or data[2] != 2:
        raise SystemExit(f"unexpected image header {data[:4].hex()}: want E9 .. 02 (DIO)")
    if struct.unpack_from("<H", data, 12)[0] != CHIP_IDS[chip]:
        raise SystemExit(f"not built for the {chip}")
    if chip != "esp32" and data[3] >> 4 != 2:
        raise SystemExit(f"not built for 4 MB of flash ({data[3]:02x})")
    if data[23] != 1:
        raise SystemExit("image has no SHA-256")
    if hashlib.sha256(data[:-32]).digest() != data[-32:]:
        raise SystemExit("image SHA-256 doesn't match")
    limit = app_partition_size(env)
    if chip == "esp32c2":
        # Installed through the stock firmware's update page, which makes room for the slot less 4 KB, in whole sectors
        # (0xBF000). Keep a margin under that.
        limit = min(limit, SDC2_STOCK_LIMIT)
    if len(data) > limit:
        raise SystemExit(f"firmware is {len(data)} bytes: over the {limit} byte app partition")
    print(f"{len(data) * 100 // limit}% of the app partition")


# Atomic and floating-point instructions: an RV32IMC chip stops with "Illegal instruction" at the first one it runs.
NOT_RV32IMC = re.compile(r"\t(amo[a-z]+\.w|lr\.w|sc\.w|f[a-z]+\.(s|d|w|wu|x)|flw|fsw|fld|fsd|frcsr|fscsr|frflags|fsflags|frrm|fsrm)\b")


def check_rv32imc(elf, env):
    objdump = re.sub(r"gcc(\.exe)?$", r"objdump\1", env.subst("$CC"))
    out = subprocess.run([objdump, "-d", elf], capture_output=True, text=True, env=env["ENV"], check=True).stdout
    where, found = "", {}
    for line in out.splitlines():
        m = re.match(r"^[0-9a-f]+ <(.+)>:$", line)
        if m:
            where = m.group(1)
        elif NOT_RV32IMC.search(line):
            found[where] = found.get(where, 0) + 1
    if found:
        raise SystemExit("instructions the ESP32-C2 doesn't have, in: " + ", ".join(sorted(found)))


def boot_blob(build_dir):
    blob = bytearray(b"\xff" * (APP_AT - BOOT_AT))
    parts = [
        (BOOT_AT, os.path.join(build_dir, "bootloader.bin")),
        (PARTITIONS_AT, os.path.join(build_dir, "partitions.bin")),
        (OTADATA_AT, os.path.join(env.PioPlatform().get_package_dir("framework-arduinoespressif32"), "tools", "partitions", "boot_app0.bin")),  # noqa: F821
    ]
    for at, path in parts:
        if not os.path.exists(path):
            raise SystemExit(f"{path} is missing")
        data = open(path, "rb").read()
        if at - BOOT_AT + len(data) > len(blob):
            raise SystemExit(f"{path} doesn't fit")
        blob[at - BOOT_AT : at - BOOT_AT + len(data)] = data
    if blob[0] != 0xE9 or blob[PARTITIONS_AT - BOOT_AT : PARTITIONS_AT - BOOT_AT + 2] != b"\xaa\x50":
        raise SystemExit("boot loader or partition table don't look right")
    return bytes(blob)


def check(source, target, env):
    path = str(target[0])
    data = open(path, "rb").read()
    model, version, api = model_and_version(env)
    esp32 = env.PioPlatform().name == "espressif32"
    chip = env.BoardConfig().get("build.mcu", "esp32") if esp32 else "esp8266"
    if esp32:
        check_esp32(data, chip, env)
        if chip == "esp32c2":
            check_rv32imc(os.path.splitext(path)[0] + ".elf", env)
    else:
        check_esp8266(data)
    if f"RHSCREEN-FW:{model}:{version}".encode() not in data:
        raise SystemExit("firmware marker missing")
    out = project_file("bin")
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
        "chip": chip,
        "version": version,
        "api": api,
        "file": name,
        "size": len(data),
        "md5": hashlib.md5(data).hexdigest(),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    # Boards set up over USB (the ESP32) get the boot loader and partition table too; the SDC2 keeps its own.
    if chip == "esp32":
        boot = boot_blob(os.path.dirname(path))
        open(os.path.join(out, f"{model}.boot.bin"), "wb").write(boot)
        manifest["boot"] = {"file": f"{model}.boot.bin", "at": BOOT_AT, "size": len(boot), "md5": hashlib.md5(boot).hexdigest()}
        manifest["appAt"] = APP_AT
    with open(os.path.join(out, f"{model}.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"firmware {name}: {len(data)} bytes, md5 {manifest['md5']}")


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", check)  # noqa: F821

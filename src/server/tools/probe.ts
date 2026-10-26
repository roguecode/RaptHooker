/**
 * Prints every RAPT Pill and RAPT Thermometer advert heard, decoded. Handy for checking a device is in range (and a
 * pill in Bluetooth mode).
 *   node rapthooker-probe.cjs [seconds]      (on the Pi: sudo systemctl stop rapthooker first is NOT needed)
 * RAPTHOOKER_ADAPTER=hci1 (or hci0,hci1) picks adapters; RAPTHOOKER_SCAN_MODE=passive|active|auto (default auto).
 */
import pino from 'pino';
import { BluezScanner, type ScanModeSetting } from '../ble/bluez.js';
import { decodeRapt } from '../ble/rapt.js';
import { tiltOf } from '../db.js';

const seconds = Number(process.argv[2] ?? 120);
const log = pino({ level: 'warn' });
const scanMode = (['auto', 'passive', 'active'] as const).find((m) => m === process.env.RAPTHOOKER_SCAN_MODE) ?? 'auto';
const scanner = new BluezScanner(log, {
  adapters: (process.env.RAPTHOOKER_ADAPTER ?? '').split(',').filter(Boolean),
  scanMode: scanMode satisfies ScanModeSetting,
});
const seen = new Set<string>();

scanner.on('status', (s) =>
  console.log(
    `[bluetooth] ${s.state}${s.adapters.length ? ` on ${s.adapters.join(', ')}` : ''}${s.mode ? ` (${s.mode})` : ''}` +
      `${s.modeReason ? `: ${s.modeReason}` : ''}${s.error ? `: ${s.error}` : ''}`,
  ),
);
scanner.on('advert', (a) => {
  for (const [companyId, data] of a.manufacturer ?? []) {
    const hex = Buffer.from(data).toString('hex');
    const key = `${a.address}|${hex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const d = decodeRapt(companyId, data);
    const time = new Date(a.at).toISOString().slice(11, 19);
    let text = 'not a RAPT payload';
    if (d?.kind === 'firmware') text = `firmware ${d.firmware}`;
    else if (d?.kind === 'deviceType') text = `device type ${d.deviceType}`;
    else if (d?.kind === 'thermometer') text = `RAPT Thermometer ${d.temp.toFixed(1)} °C`;
    else if (d?.kind === 'metrics') {
      const m = d.metrics;
      const tilt = tiltOf(m.x, m.y, m.z);
      text =
        `v${m.version} gravity ${m.sg.toFixed(4)}  temp ${m.temp.toFixed(2)} °C  battery ${m.battery.toFixed(0)}%  ` +
        `velocity ${m.velocity === null ? '-' : m.velocity.toFixed(2)}  tilt ${tilt === null ? '-' : tilt.toFixed(1)}°  xyz ${m.x}/${m.y}/${m.z}`;
    }
    console.log(
      `${time} ${a.address} ${a.rssi ?? '?'} dBm${a.source ? ` via ${a.source}` : ''}${a.cached ? ' (cached)' : ''}  ` +
        `0x${companyId.toString(16)} ${hex}\n         ${text}`,
    );
  }
});

console.log(`Listening for RAPT Pills and Thermometers for ${seconds} s...`);
scanner.start().then(
  () =>
    setTimeout(() => {
      void scanner.stop().then(() => process.exit(0));
    }, seconds * 1000),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);

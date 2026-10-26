/** The simulator's pills and thermometer (made-up addresses, see src/server/ble/mock.ts), and the IDs the RAPT app would show for the pills. */
export const SIMULATED = {
  ale: 'F0:0D:5E:ED:00:03',
  lager: 'F0:0D:5E:ED:00:04',
  water: 'F0:0D:5E:ED:00:05',
  thermometer: 'F0:0D:5E:ED:00:10',
} as const;
export const RAPT_ID = { ale: 'F0:0D:5E:ED:00:01', lager: 'F0:0D:5E:ED:00:02', water: 'F0:0D:5E:ED:00:03' } as const;

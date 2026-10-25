import { OwnerSection } from './OwnerSection';
import { HubSection } from './HubSection';
import { PillsSection } from './PillsSection';
import { BluetoothSection } from './BluetoothSection';
import { MqttSection } from './MqttSection';
import { TokensSection } from './TokensSection';
import { BackupSection } from './BackupSection';
import { UpdateSection } from './UpdateSection';
import { SystemSection } from './SystemSection';
import { StatusSection } from './StatusSection';
import { t } from '../../i18n';

export function SettingsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Settings')}</h1>
          <p>{t('Access, the hub, units and theme, and how the hub is doing.')}</p>
        </div>
      </div>
      <OwnerSection />
      <HubSection />
      <PillsSection />
      <BluetoothSection />
      <MqttSection />
      <TokensSection />
      <BackupSection />
      <UpdateSection />
      <SystemSection />
      <StatusSection />
      <footer className="footer">
        {t('RaptHooker is free software under the GPL-3.0. Not affiliated with KegLand or RAPT.')}{' '}
        <a href="/LICENSE-lucide.txt">{t('Icon licence')}</a>
      </footer>
    </div>
  );
}

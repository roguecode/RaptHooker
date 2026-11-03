import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';

/** A device's picture: the same icon badge for every kind, so they line up. */
export function DeviceArt({ icon, size = 'normal' }: { icon: IconName; size?: 'normal' | 'large' }) {
  return (
    <span className={`device-art${size === 'large' ? ' large' : ''}`} aria-hidden="true">
      <Icon name={icon} size={size === 'large' ? 30 : 20} />
    </span>
  );
}

/** What a device is, next to its picture. */
export function DeviceIntro({ icon, name, children, badge }: { icon: IconName; name: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <div className="device-intro">
      <DeviceArt icon={icon} size="large" />
      <div>
        <h3>
          {name} {badge}
        </h3>
        <p>{children}</p>
      </div>
    </div>
  );
}

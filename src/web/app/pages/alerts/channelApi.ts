import type { Channel, ChannelInput } from '@rapthooker/shared';
import { http } from '../../api';

export const channelApi = {
  list: () => http.get<Channel[]>('/api/channels'),
  create: (input: ChannelInput) => http.post<Channel>('/api/channels', input),
  update: (id: string, input: ChannelInput) => http.put<Channel>(`/api/channels/${encodeURIComponent(id)}`, input),
  remove: (id: string) => http.del(`/api/channels/${encodeURIComponent(id)}`),
  test: (channel: ChannelInput, id: string | null) => http.post<{ ok: true }>('/api/channels/test', { channel, id }),
};

export const toChannelInput = (c: Channel): ChannelInput => ({ name: c.name, kind: c.kind, enabled: c.enabled, config: { ...c.config } });

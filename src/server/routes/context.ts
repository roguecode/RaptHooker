import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { LiveMessage, Session } from '@rapthooker/shared';
import type { Auth } from '../auth.js';
import type { Services } from '../server.js';

/** Sends a live message to every open socket. Viewers get `forViewers` instead when it's given. */
export type Broadcast = (msg: LiveMessage, forViewers?: LiveMessage) => void;

/** What every route module gets from buildServer. */
export interface RouteContext {
  app: FastifyInstance;
  s: Services;
  auth: Auth;
  sessionOf: (req: FastifyRequest) => Session;
  isOwner: (req: FastifyRequest) => boolean;
  /** Route options that turn away anyone but the owner. */
  owner: { preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined> };
  broadcast: Broadcast;
}

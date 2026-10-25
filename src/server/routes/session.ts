import type { FastifyReply, FastifyRequest } from 'fastify';
import { loginSchema, ownerPinSchema, type Session } from '@rapthooker/shared';
import { PIN_COOKIE } from '../auth.js';
import type { RouteContext } from './context.js';

export function sessionRoutes({ app, auth, sessionOf, isOwner }: RouteContext): void {
  app.get('/api/session', async (req) => sessionOf(req));

  const setPinCookie = (req: FastifyRequest, reply: FastifyReply, value: string) =>
    reply.setCookie(PIN_COOKIE, value, {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: auth.cookieMaxAgeSec(),
      secure: sessionOf(req).secure,
    });
  const asPinOwner = (req: FastifyRequest): Session => ({ ...sessionOf(req), role: 'owner', user: 'pin', via: 'pin', pinSet: true });

  app.post('/api/login', async (req, reply) => {
    const { pin } = loginSchema.parse(req.body);
    const result = auth.checkPin(req.ip, pin);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    setPinCookie(req, reply, result.cookie);
    return asPinOwner(req);
  });

  app.post('/api/logout', async (req, reply) => {
    reply.clearCookie(PIN_COOKIE, { path: '/' });
    const sess = sessionOf(req);
    return sess.via === 'pin' ? ({ ...sess, role: 'viewer', user: 'guest', via: 'lan' } satisfies Session) : sess;
  });

  // The first visitor creates the PIN; after that, changing it needs the owner or the current PIN.
  app.post('/api/owner-pin', async (req, reply) => {
    const body = ownerPinSchema.parse(req.body);
    if (auth.pinSet() && !isOwner(req)) {
      const check = auth.checkPin(req.ip, body.currentPin ?? '');
      if (!check.ok) return reply.code(403).send({ error: body.currentPin ? check.error : 'Enter the current PIN to change it' });
    }
    setPinCookie(req, reply, auth.setPin(body.pin));
    app.log.info('owner PIN set');
    return asPinOwner(req);
  });
}

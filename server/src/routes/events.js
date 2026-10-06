// Server-Sent Events stream: tiny "something changed" notifications so open pages stay live.
// Auth is a normal Bearer token (the browser uses fetch-streaming, not EventSource, so headers work).
export default async function eventRoutes(app, { hub }) {
  app.get('/api/events', { preHandler: app.guards.authed }, async (req, reply) => {
    const member = req.member;
    const conn = {
      raw: reply.raw,
      email: req.user.email,
      approved: member?.status === 'approved',
      isOwner: member?.role === 'owner',
    };
    if (!hub.add(conn)) {
      return reply.code(429).send({ error: { code: 'too_many_streams', message: 'Too many open live connections for this account' } });
    }
    // We write the response by hand from here on; keep headers set by plugins (CORS, security headers).
    reply.hijack();
    reply.raw.writeHead(200, {
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ status: member ? member.status : 'none' })}\n\n`);
    req.raw.on('close', () => hub.remove(conn));
  });
}

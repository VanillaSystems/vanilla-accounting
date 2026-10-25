/**
 * Requests as another device on the network sends them, for a server listening on every interface.
 * They go to 127.0.0.1 from this machine's LAN address: the server sees a peer that is not loopback,
 * while the packets stay on the loopback interface. Sent to the LAN address, a connection passes the
 * machine's network filters (a firewall, a VPN), which under load held one for up to 18 s or closed
 * it before any answer (#122).
 */
import { request } from 'node:http';
import { lanAddresses } from '../../src/server/phone.js';

/** This machine's address on the local network; undefined on a machine without one. */
export const lan: string | undefined = lanAddresses()[0];

export interface NetworkInit { method?: string; headers?: Record<string, string>; body?: string }

/** One request on a connection of its own, from `lan` (from 127.0.0.1 when there is none). */
export function fromNetwork(port: number, path: string, init: NetworkInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', localAddress: lan, port, path, method: init.method ?? 'GET', headers: { ...init.headers, connection: 'close' }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

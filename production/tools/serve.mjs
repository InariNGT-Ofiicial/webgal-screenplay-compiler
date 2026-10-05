import path from 'node:path';
import { createHost } from '../src/host.mjs';
const dist = path.resolve(process.argv[2] ?? 'webgal/dist'), port = Number(process.env.PORT ?? 8895);
const service = createHost({ dist, port, instanceRoot:path.resolve('.') });
const address = await service.start();
console.log(`WebGAL production: http://127.0.0.1:${address.port}/`);
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await service.close(); process.exit(); });

/**
 * Throwaway probe: where exactly does a direct connection to the host die?
 * Listens to every ssh2 client event so we can see how far the handshake gets.
 *
 *   node probe-handshake.mjs 198.51.100.20 22
 */
import { Client } from 'ssh2';

const host = process.argv[2] ?? '198.51.100.20';
const port = Number(process.argv[3] ?? 22);
const started = Date.now();
const at = () => `+${String(Date.now() - started).padStart(5)}ms`;

console.log(`探测 ${host}:${port}（故意用假密码，只看握手能走多远）\n`);

const client = new Client();

client.on('banner', (banner) => console.log(`${at()}  banner     收到版本串: ${JSON.stringify(banner)}`));
client.on('greeting', () => console.log(`${at()}  greeting`));
client.on('handshake', (negotiated) => {
  console.log(`${at()}  handshake  ✅ 握手完成  kex=${negotiated.kex}  cs=${negotiated.cs?.cipher}`);
});
client.on('ready', () => {
  console.log(`${at()}  ready      ✅ 认证通过`);
  client.end();
});
client.on('error', (error) => {
  console.log(`${at()}  error      ❌ ${error.message}`);
  if (error.level) console.log(`             level=${error.level} code=${error.code ?? '-'}`);
});
client.on('close', () => {
  console.log(`${at()}  close      连接关闭`);
  process.exit(0);
});

client.connect({
  host,
  port,
  username: 'root',
  password: 'definitely-not-the-password',
  readyTimeout: 20000,
  keepaliveInterval: 0,
});

setTimeout(() => {
  console.log(`${at()}  20 秒无结论，主动结束`);
  try { client.end(); } catch { /* ignore */ }
  process.exit(0);
}, 22000);

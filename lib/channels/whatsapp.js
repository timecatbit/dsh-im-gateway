/**
 * WhatsApp 渠道适配器：基于 @whiskeysockets/baileys 7（可选依赖，动态 import）。
 *
 * 点「连接」后，配对二维码通过 loginUrl() 显示在设置页（同时写入状态目录的
 * whatsapp-pairing.txt），用手机 WhatsApp「已关联的设备」扫码。登录凭据保存在
 * 状态目录的 whatsapp-auth/，重启后无需再扫码；在手机上移除这台设备后凭据作废，
 * 再点「连接」会给出新的二维码。
 *
 * Baileys 6.7 从 GitHub 拉取 libsignal，pnpm 11 起默认拒绝这种子依赖，整个网关因此
 * 装不上；Baileys 7 改用 npm 上的 libsignal（同一份代码），所以 0.4.1 起用 7。
 * @module dsh-im-gateway/channels/whatsapp
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const loadBaileys = async () => (await import('@whiskeysockets/baileys'));
/** 二维码轮换完仍没人扫时 Baileys 关闭连接用的状态码（DisconnectReason.timedOut）。 */
const QR_EXPIRED = 408;
/** 连续几轮二维码没人扫就停下。 */
const MAX_UNSCANNED_ROUNDS = 3;
/** 不转给 agent 的会话：状态更新、频道和广播。 */
const ignoredJid = (jid) => jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
/** 发言者 id（白名单与审计用）：群里取发言人，私聊取对方；优先手机号形式。 */
function senderId(key, chatId) {
    const isGroup = chatId.endsWith('@g.us');
    const jid = isGroup ? key.participantAlt ?? key.participant ?? chatId : key.remoteJidAlt ?? chatId;
    return jid.split('@')[0].split(':')[0];
}
/** Baileys 要求的 pino 风格日志接口：只把错误转进网关日志，其余丢弃（Baileys 的 info 级日志很多）。 */
function quietLogger(log) {
    const text = (obj, msg) => typeof obj === 'string' ? obj : typeof msg === 'string' ? msg : JSON.stringify(obj)?.slice(0, 200) ?? '';
    const logger = {
        level: 'error',
        child: () => logger,
        trace() { },
        debug() { },
        info() { },
        warn() { },
        error: (obj, msg) => log(`[whatsapp] ${text(obj, msg)}`),
        fatal: (obj, msg) => log(`[whatsapp] ${text(obj, msg)}`),
    };
    return logger;
}
export function createWhatsAppChannel(config, log, stateDir, load = loadBaileys) {
    if (!config.enabled)
        return undefined;
    const dir = config.stateDir ?? stateDir;
    const pairingPath = join(dir, 'whatsapp-pairing.txt');
    const authDir = join(dir, 'whatsapp-auth');
    let handler;
    let sock;
    let qr;
    let statusText = '未启动';
    let stopped = false;
    let retry;
    // 没人扫码时 WhatsApp 换几次码后关掉连接（408）；连续几轮都没扫就停下，免得一直和服务器空转。
    let unscannedRounds = 0;
    let adapter;
    const clearRetry = () => {
        if (retry)
            clearTimeout(retry);
        retry = undefined;
    };
    adapter = {
        id: 'whatsapp',
        label: 'WhatsApp',
        maxMessageLength: 4000,
        async start() {
            stopped = false;
            clearRetry();
            let baileys;
            try {
                baileys = await load();
            }
            catch {
                statusText = '缺少依赖';
                log('[whatsapp] 缺少 @whiskeysockets/baileys：重新安装 DSH IM Gateway，或在当前 profile 里装上它');
                return;
            }
            if (stopped)
                return;
            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
            mkdirSync(dir, { recursive: true });
            // 登录凭据等同于这个 WhatsApp 账号的已关联设备，只给运行 DSH 的用户读写。
            mkdirSync(authDir, { recursive: true, mode: 0o700 });
            const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
            if (stopped)
                return;
            // 旧 socket（重连时）先关掉，免得两个连接同时收消息。
            const previous = sock;
            sock = undefined;
            try {
                previous?.end();
            }
            catch { /* 已关闭 */ }
            qr = undefined;
            statusText = '连接中';
            const socket = makeWASocket({
                auth: authState,
                logger: quietLogger(log),
                browser: ['DSH IM Gateway', 'Chrome', '1.0'],
                markOnlineOnConnect: false,
                syncFullHistory: false,
            });
            sock = socket;
            let showedQr = false;
            // 扫码配对、续期密钥都会更新凭据；不保存的话配对完成不了，重启后也连不回来。
            socket.ev.on('creds.update', () => void Promise.resolve(saveCreds()).catch((err) => log(`[whatsapp] 保存登录凭据失败: ${String(err)}`)));
            socket.ev.on('connection.update', (update) => {
                if (sock !== socket)
                    return;
                const nextQr = update.qr;
                const connection = update.connection;
                if (nextQr) {
                    showedQr = true;
                    qr = nextQr;
                    statusText = '等待扫码';
                    if (!stopped)
                        log(`[whatsapp] 请在设置页用 WhatsApp 扫码配对（也写入了 ${pairingPath}）`);
                    try {
                        writeFileSync(pairingPath, `${nextQr}\n`, { mode: 0o600 });
                    }
                    catch { /* 忽略 */ }
                }
                if (connection === 'open') {
                    unscannedRounds = 0;
                    qr = undefined;
                    statusText = '已连接';
                    try {
                        rmSync(pairingPath, { force: true });
                    }
                    catch { /* 忽略 */ }
                    log('[whatsapp] 已连接');
                }
                if (connection === 'close') {
                    qr = undefined;
                    sock = undefined;
                    if (stopped)
                        return;
                    const lastDisconnect = update.lastDisconnect;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code === DisconnectReason.loggedOut) {
                        // 手机上移除了这台设备：旧凭据作废，删掉，下次「连接」给新二维码。
                        statusText = '已登出';
                        try {
                            rmSync(authDir, { recursive: true, force: true });
                        }
                        catch { /* 忽略 */ }
                        log('[whatsapp] 已在手机上退出登录；需要时重新点「连接」扫码');
                        return;
                    }
                    if (showedQr && code === QR_EXPIRED) {
                        unscannedRounds++;
                        if (unscannedRounds >= MAX_UNSCANNED_ROUNDS) {
                            statusText = '二维码已过期';
                            log('[whatsapp] 二维码多次过期没有扫，已停止；需要时点「刷新二维码」');
                            return;
                        }
                    }
                    // 扫码成功后 WhatsApp 会要求重连一次（restartRequired），没扫的二维码过期了也直接换新的；其余断开 5 秒后重连。
                    const quick = code === DisconnectReason.restartRequired || (showedQr && code === QR_EXPIRED);
                    const delay = quick ? 0 : 5000;
                    statusText = '重连中';
                    if (delay)
                        log(`[whatsapp] 连接关闭（code ${code ?? '?'}），${delay / 1000}s 后重连`);
                    clearRetry();
                    retry = setTimeout(() => void adapter?.start(), delay);
                }
            });
            socket.ev.on('messages.upsert', (data) => {
                if (sock !== socket)
                    return;
                // 'append' 是历史同步和其他设备上的旧消息，只处理新到的。
                if (data.type !== undefined && data.type !== 'notify')
                    return;
                const messages = data.messages;
                for (const raw of messages ?? []) {
                    const key = raw.key;
                    if (!key || key.fromMe)
                        continue;
                    const chatId = key.remoteJid;
                    if (!chatId || ignoredJid(chatId))
                        continue;
                    const msg = raw.message;
                    const text = msg?.conversation ?? msg?.extendedTextMessage?.text;
                    if (!text)
                        continue;
                    void handler?.({
                        chatId,
                        userId: senderId(key, chatId),
                        username: typeof raw.pushName === 'string' ? raw.pushName : undefined,
                        text,
                    });
                }
            });
        },
        async stop() {
            stopped = true;
            clearRetry();
            unscannedRounds = 0;
            qr = undefined;
            const current = sock;
            sock = undefined;
            statusText = '未启动';
            try {
                current?.end();
            }
            catch { /* 已关闭 */ }
        },
        async send(chatId, text) {
            if (!sock)
                throw new Error('whatsapp: 未连接');
            await sock.sendMessage(chatId, { text });
        },
        setMessageHandler(h) {
            handler = h;
        },
        loginUrl() {
            return qr;
        },
        status() {
            return statusText;
        },
    };
    return adapter;
}
//# sourceMappingURL=whatsapp.js.map
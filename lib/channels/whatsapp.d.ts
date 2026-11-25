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
import type { ChannelAdapter } from '../core/types.js';
export interface WhatsAppChannelConfig {
    enabled?: boolean;
    stateDir?: string;
}
/** 适配层用到的那一小部分 Baileys socket；Baileys 类型重且随版本漂移，这里用宽松类型。 */
type BaileysSocket = {
    end(error?: Error): void;
    sendMessage(jid: string, content: Record<string, unknown>): Promise<unknown>;
    ev: {
        on(event: string, cb: (data: any) => void): void;
    };
};
/** 适配层用到的 Baileys 模块导出。 */
export interface BaileysModule {
    default: (opts: Record<string, unknown>) => BaileysSocket;
    useMultiFileAuthState(dir: string): Promise<{
        state: unknown;
        saveCreds: () => Promise<void> | void;
    }>;
    DisconnectReason: {
        loggedOut: number;
        restartRequired?: number;
    };
}
export declare function createWhatsAppChannel(config: WhatsAppChannelConfig, log: (line: string) => void, stateDir: string, load?: () => Promise<BaileysModule>): ChannelAdapter | undefined;
export {};
//# sourceMappingURL=whatsapp.d.ts.map
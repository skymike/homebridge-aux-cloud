/**
 * AuxDeviceControl — Abstracción que encapsula la lógica de selección local/cloud.
 * Intenta control LAN si está habilitado y hay IP/MAC; si falla, fallback a cloud.
 */

import { createSocket } from 'dgram';
import type { Logger } from 'homebridge';

import type { AuxDevice } from './AuxCloudClient';
import type { AuxTrace, AuxTraceContext } from './trace/AuxTrace';
import { AcFreedomProvider } from './providers/AcFreedomProvider';
import { AuxProviderCommandSupersededError, type AuxProvider } from './providers/AuxProvider';
import { AC_POWER } from './constants';
import type { DiscoveredDevice } from './broadlink/DeviceDiscovery';
import {
  BroadlinkCommand,
  buildPacket,
  buildCommandPayload,
  decryptPayload,
  parseAuthResponse,
  broadlinkWireToAuxMode,
  broadlinkWireToAuxFanSpeed,
} from './broadlink/Protocol';

export interface DeviceMapping {
  endpointId?: string;
  mac?: string;
  ip?: string;
  name?: string;
  controlStrategy?: 'local' | 'cloud';
}

export interface AuxDeviceControlOptions {
  region?: 'eu' | 'usa' | 'cn';
  logger?: Logger;
  commandTimeoutMs?: number;
  commandRetryCount?: number;
  localControlEnabled?: boolean;
  devices?: DeviceMapping[];
  cloudProvider?: Pick<AuxProvider, 'kind' | 'setDeviceParams'>;
  trace?: AuxTrace;
}

const LAN_FAILURE_THRESHOLD = 3;
const LAN_AUTH_DELAY_MS = 200;   // device needs time after auth to accept commands
const LAN_RECONNECT_RETRY = 2;   // reconnect attempts when session is lost

interface LanSession {
  socket: ReturnType<typeof createSocket>;
  key: Buffer;
  id: Buffer;
  count: number;
  authenticated: boolean;
  stateResolvers: Array<(buf: Buffer) => void>;
  authResolver: ((buf: Buffer) => void) | null;
}

export class AuxDeviceControl {
  private cloudProvider: Pick<AuxProvider, 'kind' | 'setDeviceParams'>;
  private readonly redactDeviceIdentifiers: boolean;
  private deviceMappings = new Map<string, DeviceMapping>(); // keyed by normalized MAC
  private discoveredDevices = new Map<string, DiscoveredDevice>(); // keyed by normalized MAC
  private consecutiveFailures = new Map<string, number>();
  private lanSessions = new Map<string, LanSession>();
  private logger?: Logger;
  private readonly trace?: AuxTrace;

  constructor(options: AuxDeviceControlOptions) {
    this.cloudProvider = options.cloudProvider ?? new AcFreedomProvider({
      region: options.region ?? 'eu',
      logger: options.logger,
      requestTimeoutMs: options.commandTimeoutMs ?? 5000,
    });
    this.redactDeviceIdentifiers = this.cloudProvider.kind === 'aux-home';
    this.logger = this.redactDeviceIdentifiers ? undefined : options.logger;
    this.trace = options.trace;
    this.loadMappings(options.devices ?? []);
  }

  private loadMappings(devices: DeviceMapping[]): void {
    this.deviceMappings.clear();
    for (const device of devices) {
      if (device.mac) {
        // Devices without endpointId are LAN-only: force local strategy
        const controlStrategy = device.controlStrategy ?? (device.endpointId ? undefined : 'local');
        this.deviceMappings.set(device.mac.toLowerCase(), { ...device, controlStrategy });
      }
    }
  }

  getLanOnlyMappings(): Array<DeviceMapping & { mac: string; name: string }> {
    return Array.from(this.deviceMappings.values()).filter(
      (m): m is DeviceMapping & { mac: string; name: string } =>
        Boolean(m.mac && m.name && !m.endpointId),
    );
  }

  registerDiscoveredDevice(device: DiscoveredDevice): void {
    const key = device.mac.toLowerCase();
    if (!this.discoveredDevices.has(key)) {
      this.discoveredDevices.set(key, device);
    }
  }

  /**
   * Obtiene el mapeo IP/MAC para un MAC address.
   * Prioridad: manual (con IP fija) > discovered (IP dinámica).
   */
  public getDeviceMapping(mac: string): { ip: string; mac: string } | null {
    const key = mac.toLowerCase();
    const manual = this.deviceMappings.get(key);
    if (manual?.ip) {
      return { ip: manual.ip, mac: key };
    }
    const discovered = this.discoveredDevices.get(key);
    if (discovered) {
      return { ip: discovered.ip, mac: discovered.mac };
    }
    return null;
  }

  public shouldUseLocalControl(mac: string, globalStrategy?: 'local-first' | 'cloud-only'): boolean {
    const manual = this.deviceMappings.get(mac.toLowerCase());
    if (manual?.controlStrategy === 'cloud') return false;
    if (manual?.controlStrategy === 'local') return true;
    if (globalStrategy === 'cloud-only') return false;
    if (globalStrategy === 'local-first') return true;
    return false;
  }

  /**
   * Incrementa contador de fallos consecutivos para un dispositivo.
   */
  recordFailure(endpointId: string): void {
    const current = this.consecutiveFailures.get(endpointId) ?? 0;
    this.consecutiveFailures.set(endpointId, current + 1);
  }

  /**
   * Reinicia contador de fallos (éxito).
   */
  recordSuccess(endpointId: string): void {
    this.consecutiveFailures.delete(endpointId);
  }

  /**
   * Build auth payload for LAN device authentication.
   * Matches broadlink-aircon-api reference exactly.
   */
  private buildAuthPayload(): Buffer {
    const payload = Buffer.alloc(0x50, 0);
    for (let i = 0x04; i <= 0x12; i++) payload[i] = 0x31;   // 15 bytes (0x04–0x12)
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    payload[0x30] = 'T'.charCodeAt(0);
    payload[0x31] = 'e'.charCodeAt(0);
    payload[0x32] = 's'.charCodeAt(0);
    payload[0x33] = 't'.charCodeAt(0);
    payload[0x34] = ' '.charCodeAt(0);
    payload[0x35] = ' '.charCodeAt(0);
    payload[0x36] = '1'.charCodeAt(0);
    return payload;
  }

  /**
   * Parse decrypted LAN response into params map.
   * Handles both 32-byte state responses and 48-byte info responses.
   */
  private parseDecryptedState(decrypted: Buffer): Record<string, number> | null {
    if (decrypted.length < 23) return null;

    if (decrypted.length >= 32) {
      // 32-byte state response — translate wire protocol values to AUX cloud API values
      const wireMute      = (decrypted[16] >> 7) & 0x01;
      const wireFanSpeed  = (decrypted[15] >> 5) & 0x07;
      return {
        pwr:       (decrypted[20] >> 5) & 0x01,
        temp:      (8 + (decrypted[12] >> 3)) * 10,
        ac_vdir:   decrypted[12] & 0x07,
        // Translate wire mode (0=auto,1=cool,2=dry,4=heat,6=fan) → AuxAcModeValue
        ac_mode:   broadlinkWireToAuxMode((decrypted[17] >> 5) & 0x0f),
        ac_slp:    (decrypted[17] >> 2) & 0x01,
        scrdisp:   (decrypted[22] >> 4) & 0x01,
        mldprf:    (decrypted[22] >> 3) & 0x01,
        ac_health: (decrypted[20] >> 1) & 0x01,
        ac_hdir:   (decrypted[13] >> 5) & 0x07,
        // Translate wire fan speed (1=high,2=med,3=low,4=turbo,5=auto) → AuxFanSpeed.
        // When mute bit is set, override with AuxFanSpeed.MUTE(5).
        ac_mark:   wireMute ? 5 : broadlinkWireToAuxFanSpeed(wireFanSpeed),
        mute:      wireMute,
        turbo:     (decrypted[16] >> 6) & 0x01,
        ac_clean:  (decrypted[20] >> 2) & 0x01,
      };
    }

    return null;
  }

  /**
   * Parse 48-byte getInfo response into ambient temperature param.
   */
  private parseDecryptedInfo(decrypted: Buffer): Record<string, number> | null {
    if (decrypted.length < 48) return null;
    // Ambient temperature: fractional part from byte 33, integer part from byte 17
    const amb05 = decrypted[33] / 10;
    let amb = decrypted[17] & 0x1f;
    if (decrypted[17] > 63) {
      amb += 32;
    }
    const ambientTemp = Math.round((amb05 + amb) * 10); // store as ×10 like other temp params
    return { envtemp: ambientTemp };
  }

  private createLanSocket(): ReturnType<typeof createSocket> {
    return createSocket('udp4');
  }

  private bindSocket(socket: ReturnType<typeof createSocket>): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => { socket.removeListener('error', reject); resolve(); });
    });
  }

  private async getOrCreateSession(ip: string, mac: string): Promise<LanSession> {
    const key = mac.toLowerCase();
    const session = this.lanSessions.get(key);
    if (session && session.authenticated) return session;
    if (session) {
      try { session.socket.close(); } catch { /* ignore */ }
    }

    const socket = this.createLanSocket();
    await this.bindSocket(socket);
    socket.setBroadcast(true);

    const newSession: LanSession = {
      socket,
      key: Buffer.from([0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23, 0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02]),
      id: Buffer.alloc(4, 0),
      count: 1,
      authenticated: false,
      stateResolvers: [],
      authResolver: null,
    };

    // Register persistent listener for this session
    const onMessage = (msg: Buffer) => {
      const cmd = msg[0x26];
      if (cmd === 0xe9) {
        // auth response
        if (newSession.authResolver) {
          const resolver = newSession.authResolver;
          newSession.authResolver = null;
          resolver(msg);
        }
      } else if (cmd === 0xee && msg.length > 0x38) {
        // state response — dispatch to first waiting resolver
        const resolver = newSession.stateResolvers.shift();
        if (resolver) resolver(msg);
      }
    };

    socket.on('message', onMessage);
    socket.on('error', () => {
      newSession.authenticated = false;
    });

    try {
      await this.doSessionAuth(newSession, ip, Buffer.from(mac.split(':').map((b) => parseInt(b, 16))));
    } catch (err) {
      try { socket.close(); } catch { /* ignore */ }
      throw err;
    }

    this.lanSessions.set(key, newSession);
    return newSession;
  }

  /**
   * Perform auth handshake on a persistent session.
   * Uses default key for auth; device responds with session key.
   */
  private async doSessionAuth(session: LanSession, ip: string, macBuf: Buffer): Promise<void> {
    const authMsg = await new Promise<Buffer | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 3000);
      session.authResolver = (msg) => { clearTimeout(timeout); resolve(msg); };
      const authPayload = this.buildAuthPayload();
      const authPacket = buildPacket(authPayload, BroadlinkCommand.Auth, macBuf, Buffer.alloc(4, 0), session.count++);
      session.socket.send(authPacket, 0, authPacket.length, 80, ip);
    });

      if (authMsg === null) {
      this.logger?.warn('[LAN] Auth timeout for %s — no response in 5s', ip);
      throw new Error(this.redactDeviceIdentifiers ? 'LAN auth timeout for AUX Home device' : `LAN auth timeout for ${ip}`);
    }
    this.logger?.warn('[LAN] Auth OK for %s', ip);

    const auth = parseAuthResponse(authMsg);
    if (auth) {
      session.key = auth.key;
      session.id = auth.id;
    }
    session.authenticated = true;
  }

   /**
    * Envía comando LAN con session persistente y retry con re-auth en fallo.
    * Los dispositivos Broadlink cuelgan sesiones idle — se reconecta solo cuando se pierde.
    */
  private async sendLocalCommand(
    ip: string,
    mac: string,
    params: Record<string, number>,
  ): Promise<void> {
    const normalizedParams = { ...params };
    if (normalizedParams['temp'] !== undefined && normalizedParams['temp'] > 100) {
      normalizedParams['temp'] = normalizedParams['temp'] / 10;
    }
    const macBuf = Buffer.from(mac.split(':').map((b) => parseInt(b, 16)));
    const commandPayload = buildCommandPayload(normalizedParams);

    // Retry with re-auth on failure (session may be dropped by device)
    for (let attempt = 0; attempt <= LAN_RECONNECT_RETRY; attempt++) {
      let session: LanSession;
      try {
        session = await this.getOrCreateSession(ip, mac);
      } catch {
        if (attempt === LAN_RECONNECT_RETRY) throw new Error('LAN auth failed');
        await new Promise((resolve) => setTimeout(resolve, LAN_AUTH_DELAY_MS));
        continue;
      }

      const cmdPacket = buildPacket(commandPayload, BroadlinkCommand.Packet, macBuf, session.id, session.count++, session.key);
      await new Promise<void>((resolve, reject) => {
        session.socket.send(cmdPacket, 0, cmdPacket.length, 80, ip, (err) => {
          if (err) {
            session.authenticated = false;
            reject(err);
          } else {
            resolve();
          }
        });
      });
      this.logger?.warn('[LAN] Sending command to %s: %j', ip, normalizedParams);
      return;
    }
    throw new Error(this.redactDeviceIdentifiers
      ? `LAN command failed for AUX Home device after ${LAN_RECONNECT_RETRY + 1} attempts`
      : `LAN command failed for ${ip} after ${LAN_RECONNECT_RETRY + 1} attempts`);
  }


  /**
   * Envía comando cloud con retry.
   */
  private async sendCloudCommand(
    device: AuxDevice,
    params: Record<string, number>,
    retryCount: number = 2,
    traceContext?: AuxTraceContext,
  ): Promise<void> {
    const attempts = retryCount + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (traceContext) {
          this.trace?.emit('control.attempt', traceContext, { route: 'cloud', attempt: attempt + 1 });
        }
        await this.cloudProvider.setDeviceParams(device, params, traceContext);
        return;
      } catch (error) {
        if (error instanceof AuxProviderCommandSupersededError) {
          throw error;
        }
        if (attempt < retryCount) {
          const delayMs = Math.min(500 * Math.pow(2, attempt), 3000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    const message = this.redactDeviceIdentifiers
      ? `Failed to control AUX Home device after ${attempts} cloud attempts`
      : `Failed to control ${device.endpointId} after ${attempts} cloud attempts`;
    throw new Error(message);
  }

  async sendCommand(
    device: AuxDevice,
    params: Record<string, number>,
    options?: {
      globalStrategy?: 'local-first' | 'cloud-only';
      localRetryCount?: number;
      cloudRetryCount?: number;
      traceContext?: AuxTraceContext;
    },
  ): Promise<void> {
    const endpointId = device.endpointId;
    const mac = device.mac?.toLowerCase();
    const useLocal = mac ? this.shouldUseLocalControl(mac, options?.globalStrategy) : false;
    if (options?.traceContext) {
      this.trace?.emit('control.route', options.traceContext, { route: useLocal ? 'local' : 'cloud' });
    }

    if (!useLocal) {
      // Always include pwr in cloud commands that don't already specify it.
      // Without this, the cloud uses its cached pwr=0 when building the device packet,
      // turning the AC off on every mode/temp command sent concurrently with a pwr=1 command.
      const currentPwr = device.params?.[AC_POWER];
      const cloudParams =
        AC_POWER in params || currentPwr === undefined
          ? params
          : { [AC_POWER]: currentPwr, ...params };
      await this.sendCloudCommand(device, cloudParams, options?.cloudRetryCount ?? 2, options?.traceContext);
      this.recordSuccess(endpointId);
      return;
    }

    const mapping = mac ? this.getDeviceMapping(mac) : null;
    if (mapping) {
      const deviceStrategy = mac ? this.deviceMappings.get(mac)?.controlStrategy : undefined;
      // Merge current device state with new params so the command always carries the full AC state.
      // buildCommandPayload defaults missing fields to 0 (pwr=0), which would turn the device off
      // if we send a partial command like {ac_mode: 1} without including pwr.
      const fullParams = { ...(device.params ?? {}), ...params };
      try {
        await this.sendLocalCommand(mapping.ip, mapping.mac, fullParams);
        this.recordSuccess(endpointId);
        return;
      } catch {
        this.recordFailure(endpointId);
        const failures = this.consecutiveFailures.get(endpointId) ?? 0;
        if (deviceStrategy === 'local') {
          throw new Error(this.redactDeviceIdentifiers
            ? 'LAN command failed for AUX Home device (device is local-only, no cloud fallback)'
            : `LAN command failed for ${endpointId} (device is local-only, no cloud fallback)`);
        }
        if (failures < LAN_FAILURE_THRESHOLD) {
          throw new Error(this.redactDeviceIdentifiers
            ? `LAN command failed for AUX Home device (attempt ${failures}/${LAN_FAILURE_THRESHOLD})`
            : `LAN command failed for ${endpointId} (attempt ${failures}/${LAN_FAILURE_THRESHOLD})`);
        }
        this.logger?.debug('LAN failed %d times for %s, falling back to cloud', failures, endpointId);
        await this.sendCloudCommand(device, params, options?.cloudRetryCount ?? 2, options?.traceContext);
        this.recordSuccess(endpointId);
        return;
      }
    }

    // Sin mapping LAN → cloud
    await this.sendCloudCommand(device, params, options?.cloudRetryCount ?? 2, options?.traceContext);
    this.recordSuccess(endpointId);
  }

    /**
     * Polls device state via LAN UDP with persistent session y retry.
     * Sends getState (32-byte response) then getInfo (48-byte response for ambient temp).
     * Returns merged params map or null on failure.
     * El polling periódico mantiene el keep-alive de la sesión.
     */
  async pollLocalState(ip: string, mac: string): Promise<Record<string, number> | null> {
    const macBuf = Buffer.from(mac.split(':').map((b) => parseInt(b, 16)));
    const statePayload = Buffer.from('0C00BB0006800000020011012B7E0000', 'hex');
    const infoPayload  = Buffer.from('0C00BB0006800000020021011B7E0000', 'hex');

     // Retry with re-auth on failure (session may be dropped by device)
    for (let attempt = 0; attempt <= LAN_RECONNECT_RETRY; attempt++) {
      let session: LanSession;
      try {
        session = await this.getOrCreateSession(ip, mac);
        } catch {
        if (attempt === LAN_RECONNECT_RETRY) {
          this.logger?.warn('[LAN] Auth failed for %s — skipping poll', ip);
          return null;
          }
        await new Promise((resolve) => setTimeout(resolve, LAN_AUTH_DELAY_MS));
        continue;
        }

      // --- getState ---
      const statePacket = buildPacket(statePayload, BroadlinkCommand.Packet, macBuf, session.id, session.count++, session.key);
      const stateResponse = await new Promise<Buffer | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        session.stateResolvers.push((msg) => { clearTimeout(timeout); resolve(msg); });
        session.socket.send(statePacket, 0, statePacket.length, 80, ip);
        });

      if (stateResponse === null) {
        this.logger?.warn('[LAN] State poll timeout for %s (attempt %d/%d)', ip, attempt + 1, LAN_RECONNECT_RETRY + 1);
        session.authenticated = false;
        continue;
        }

      const stateDecrypted = decryptPayload(stateResponse, session.key);
      const params = this.parseDecryptedState(stateDecrypted);
      if (params === null) {
        this.logger?.debug('[LAN] Decrypted state payload too short (%d bytes) for %s', stateDecrypted.length, ip);
        return null;
        }
      this.logger?.warn('[LAN] State OK for %s (%d bytes): pwr=%d temp=%d mode=%d fan=%d', ip, stateDecrypted.length, params.pwr, params.temp, params.ac_mode, params.ac_mark);

      // --- getInfo (ambient temperature) ---
      const infoPacket = buildPacket(infoPayload, BroadlinkCommand.Packet, macBuf, session.id, session.count++, session.key);
      let infoResolver!: (buf: Buffer) => void;
      const infoResponse = await new Promise<Buffer | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1500);
        infoResolver = (msg) => { clearTimeout(timeout); resolve(msg); };
        session.stateResolvers.push(infoResolver);
        session.socket.send(infoPacket, 0, infoPacket.length, 80, ip);
        });

      if (infoResponse !== null) {
        const infoDecrypted = decryptPayload(infoResponse, session.key);
        const infoParams = this.parseDecryptedInfo(infoDecrypted);
        if (infoParams !== null) {
          this.logger?.debug('[LAN] Ambient temp for %s: %d (×10)', ip, infoParams.envtemp);
          Object.assign(params, infoParams);
        }
      } else {
        // Cleanup: remove orphaned resolver so it doesn't consume the next getState response
        const idx = session.stateResolvers.indexOf(infoResolver);
        if (idx !== -1) session.stateResolvers.splice(idx, 1);
        this.logger?.debug('[LAN] getInfo timeout for %s — ambient temp unavailable', ip);
      }

      return params;
      }
    return null;
   }
}

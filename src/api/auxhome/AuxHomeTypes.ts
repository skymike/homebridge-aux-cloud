export interface MyResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface AuxHomeSession {
  uid: string;
  token: string;
}

export interface AuxHomeDeviceRecord {
  endpointId: string;
  deviceId?: string;
  did: string;
  alias?: string;
  mac?: string;
  modelId?: string;
  password?: string;
  passCode?: string;
  productKey?: string;
  online?: boolean;
  status?: Record<string, unknown>;
  feature?: Record<string, unknown>;
  [key: string]: unknown;
}

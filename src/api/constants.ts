export const AUX_MODE = 'ac_mode';

export const AUX_ECOMODE = 'ecomode';
export const AUX_ECOMODE_OFF = { [AUX_ECOMODE]: 0 };
export const AUX_ECOMODE_ON = { [AUX_ECOMODE]: 1 };
export const AUX_ERROR_FLAG = 'err_flag';

export const AC_POWER = 'pwr';
export const AC_POWER_OFF = { [AC_POWER]: 0 };
export const AC_POWER_ON = { [AC_POWER]: 1 };

export const AC_TEMPERATURE_TARGET = 'temp';
export const AC_TEMPERATURE_AMBIENT = 'envtemp';

export const AC_SWING_VERTICAL = 'ac_vdir';
export const AC_SWING_VERTICAL_ON = { [AC_SWING_VERTICAL]: 0 }; // 0 = oscilar, 1 = fijo
export const AC_SWING_VERTICAL_OFF = { [AC_SWING_VERTICAL]: 1 };

export const AC_SWING_HORIZONTAL = 'ac_hdir';
export const AC_SWING_HORIZONTAL_ON = { [AC_SWING_HORIZONTAL]: 0 }; // 0 = oscilar, 1 = fijo
export const AC_SWING_HORIZONTAL_OFF = { [AC_SWING_HORIZONTAL]: 1 };

export const AC_AUXILIARY_HEAT = 'ac_astheat';
export const AC_AUXILIARY_HEAT_OFF = { [AC_AUXILIARY_HEAT]: 0 };
export const AC_AUXILIARY_HEAT_ON = { [AC_AUXILIARY_HEAT]: 1 };

export const AC_CLEAN = 'ac_clean';
export const AC_CLEAN_OFF = { [AC_CLEAN]: 0 };
export const AC_CLEAN_ON = { [AC_CLEAN]: 1 };

export const AC_HEALTH = 'ac_health';
export const AC_HEALTH_OFF = { [AC_HEALTH]: 0 };
export const AC_HEALTH_ON = { [AC_HEALTH]: 1 };

export const AC_CHILD_LOCK = 'childlock';
export const AC_CHILD_LOCK_OFF = { [AC_CHILD_LOCK]: 0 };
export const AC_CHILD_LOCK_ON = { [AC_CHILD_LOCK]: 1 };

export const AC_COMFORTABLE_WIND = 'comfwind';
export const AC_COMFORTABLE_WIND_OFF = { [AC_COMFORTABLE_WIND]: 0 };
export const AC_COMFORTABLE_WIND_ON = { [AC_COMFORTABLE_WIND]: 1 };

export const AC_MILDEW_PROOF = 'mldprf';
export const AC_MILDEW_PROOF_OFF = { [AC_MILDEW_PROOF]: 0 };
export const AC_MILDEW_PROOF_ON = { [AC_MILDEW_PROOF]: 1 };

export const AC_SLEEP = 'ac_slp';
export const AC_SLEEP_OFF = { [AC_SLEEP]: 0 };
export const AC_SLEEP_ON = { [AC_SLEEP]: 1 };

export const AC_SCREEN_DISPLAY = 'scrdisp';
export const AC_SCREEN_DISPLAY_OFF = { [AC_SCREEN_DISPLAY]: 0 };
export const AC_SCREEN_DISPLAY_ON = { [AC_SCREEN_DISPLAY]: 1 };

export const AC_POWER_LIMIT = 'pwrlimit';
export const AC_POWER_LIMIT_SWITCH = 'pwrlimitswitch';
export const AC_POWER_LIMIT_OFF = { [AC_POWER_LIMIT]: 0 };
export const AC_POWER_LIMIT_ON = { [AC_POWER_LIMIT]: 1 };

export const AC_MODE_SPECIAL = 'mode';
export const AC_FAN_SPEED = 'ac_mark';
export const AC_TURBO = 'turbo';

export const AC_MODE_COOLING = { [AUX_MODE]: 0 };
export const AC_MODE_HEATING = { [AUX_MODE]: 1 };
export const AC_MODE_DRY = { [AUX_MODE]: 2 };
export const AC_MODE_FAN = { [AUX_MODE]: 3 };
export const AC_MODE_AUTO = { [AUX_MODE]: 4 };

export enum AuxAcModeValue {
  COOLING = 0,
  HEATING = 1,
  DRY = 2,
  FAN = 3,
  AUTO = 4,
}

export enum AuxFanSpeed {
  AUTO = 0,
  LOW = 1,
  MEDIUM = 2,
  HIGH = 3,
  TURBO = 4,
  MUTE = 5,
}

export const HP_MODE_AUTO = { [AUX_MODE]: 0 };
export const HP_MODE_COOLING = { [AUX_MODE]: 1 };
export const HP_MODE_HEATING = { [AUX_MODE]: 4 };

export const HP_HEATER_POWER = 'ac_pwr';
export const HP_HEATER_POWER_OFF = { [HP_HEATER_POWER]: 0 };
export const HP_HEATER_POWER_ON = { [HP_HEATER_POWER]: 1 };

export const HP_HEATER_TEMPERATURE_TARGET = 'ac_temp';

export const HP_HEATER_AUTO_WATER_TEMP = 'hp_auto_wtemp';

export const HP_WATER_POWER = 'hp_pwr';
export const HP_WATER_POWER_OFF = { [HP_WATER_POWER]: 0 };
export const HP_WATER_POWER_ON = { [HP_WATER_POWER]: 1 };

export const HP_QUIET_MODE = 'qtmode';

export const HP_HOT_WATER_TANK_TEMPERATURE = 'hp_water_tank_temp';
export const HP_HOT_WATER_TEMPERATURE_TARGET = 'hp_hotwater_temp';

export const HP_WATER_FAST_HOTWATER = 'hp_fast_hotwater';
export const HP_WATER_FAST_HOTWATER_ON = { [HP_WATER_FAST_HOTWATER]: 1 };
export const HP_WATER_FAST_HOTWATER_OFF = { [HP_WATER_FAST_HOTWATER]: 0 };

export class AuxProducts {
  static DeviceType = {
    AC_GENERIC: [
      '000000000000000000000000c0620000',
      '0000000000000000000000002a4e0000',
    ],
    HEAT_PUMP: ['000000000000000000000000c3aa0000'],
  };

  static getDeviceName(productId: string | undefined): string {
    if (!productId) {
      return 'Unknown';
    }

    if (AuxProducts.DeviceType.AC_GENERIC.includes(productId)) {
      return 'AUX Air Conditioner';
    }

    if (AuxProducts.DeviceType.HEAT_PUMP.includes(productId)) {
      return 'AUX Heat Pump';
    }

    return 'Unknown';
  }

  static readonly AC_PARAMS: string[] = [
    AC_AUXILIARY_HEAT,
    AC_CLEAN,
    AC_SWING_HORIZONTAL,
    AC_HEALTH,
    AC_FAN_SPEED,
    AUX_MODE,
    AC_SLEEP,
    AC_SWING_VERTICAL,
    AUX_ECOMODE,
    AUX_ERROR_FLAG,
    AC_MILDEW_PROOF,
    AC_POWER,
    AC_SCREEN_DISPLAY,
    AC_TEMPERATURE_TARGET,
    AC_TEMPERATURE_AMBIENT,
    AC_POWER_LIMIT,
    AC_POWER_LIMIT_SWITCH,
    AC_CHILD_LOCK,
    AC_COMFORTABLE_WIND,
    'new_type',
    'ac_tempconvert',
    'sleepdiy',
    'ac_errcode1',
    'tempunit',
    'tenelec',
  ];

  static readonly AC_SPECIAL_PARAMS: string[] = [AC_MODE_SPECIAL];

  static readonly HP_PARAMS: string[] = [
    'ac_errcode1',
    AUX_MODE,
    HP_HEATER_POWER,
    HP_HEATER_TEMPERATURE_TARGET,
    AUX_ECOMODE,
    AUX_ERROR_FLAG,
    HP_HEATER_AUTO_WATER_TEMP,
    HP_WATER_FAST_HOTWATER,
    HP_HOT_WATER_TEMPERATURE_TARGET,
    HP_WATER_POWER,
    HP_QUIET_MODE,
  ];

  static readonly HP_SPECIAL_PARAMS: string[] = [HP_HOT_WATER_TANK_TEMPERATURE];

  static getParamsList(productId: string | undefined): string[] | null {
    if (!productId) {
      return null;
    }
    if (AuxProducts.DeviceType.AC_GENERIC.includes(productId)) {
      return AuxProducts.AC_PARAMS;
    }
    if (AuxProducts.DeviceType.HEAT_PUMP.includes(productId)) {
      return AuxProducts.HP_PARAMS;
    }
    return null;
  }

  static getSpecialParamsList(productId: string | undefined): string[] | null {
    if (!productId) {
      return null;
    }
    if (AuxProducts.DeviceType.AC_GENERIC.includes(productId)) {
      return AuxProducts.AC_SPECIAL_PARAMS;
    }
    if (AuxProducts.DeviceType.HEAT_PUMP.includes(productId)) {
      return AuxProducts.HP_SPECIAL_PARAMS;
    }
    return null;
  }
}

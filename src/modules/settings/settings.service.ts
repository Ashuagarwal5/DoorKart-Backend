import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../../lib/secrets.js';
import {
  getDefinition,
  type SettingDefinition,
  SETTING_DEFINITIONS,
  SETTING_GROUPS,
  type SettingGroup,
} from './settings.registry.js';

/** What a screen may see of one setting. A secret's value is never included, only whether it is set. */
export type SettingView = {
  key: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  type: SettingDefinition['type'];
  secret: boolean;
  /** The saved text, or the default. Always null for a secret. */
  value: string | null;
  isSet: boolean;
  min: number | null;
  max: number | null;
};

export type SettingsView = {
  secretsKeyConfigured: boolean;
  groups: { id: SettingGroup; title: string; description: string; settings: SettingView[] }[];
};

type Stored = { value: string; isSecret: boolean };

async function loadAll(): Promise<Map<string, Stored>> {
  const rows = await prisma.setting.findMany();
  return new Map(rows.map((row) => [row.key, { value: row.value, isSecret: row.isSecret }]));
}

export async function getSettingsView(secretsKeyConfigured: boolean): Promise<SettingsView> {
  const stored = await loadAll();

  return {
    secretsKeyConfigured,
    groups: SETTING_GROUPS.map((group) => ({
      ...group,
      settings: SETTING_DEFINITIONS.filter((definition) => definition.group === group.id).map((definition) => {
        const row = stored.get(definition.key);
        return {
          key: definition.key,
          label: definition.label,
          description: definition.description ?? null,
          placeholder: definition.placeholder ?? null,
          type: definition.type,
          secret: definition.secret === true,
          value: definition.secret ? null : (row?.value ?? definition.defaultValue ?? ''),
          isSet: row !== undefined,
          min: definition.min ?? null,
          max: definition.max ?? null,
        };
      }),
    })),
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns the cleaned text to store, or throws a validation error naming the setting. */
function validate(definition: SettingDefinition, raw: string): string {
  const value = raw.trim();
  const fail = (message: string): never => {
    throw new AppError(400, 'VALIDATION_ERROR', 'A setting is not valid.', [{ field: definition.key, message }]);
  };

  if (value.length > 500) {
    fail('Too long.');
  }
  if (definition.type === 'boolean' && value !== 'true' && value !== 'false') {
    fail('Must be on or off.');
  }
  if (definition.type === 'number') {
    const number = Number(value);
    const min = definition.min ?? 0;
    const max = definition.max ?? Number.MAX_SAFE_INTEGER;
    if (!/^\d+$/.test(value) || number < min || number > max) {
      fail(`Enter a whole number from ${min} to ${max}.`);
    }
  }
  if (definition.type === 'email' && !EMAIL_PATTERN.test(value)) {
    fail('Enter a valid email address.');
  }
  if (definition.key === 'smtp.host' && !/^[A-Za-z0-9.-]+$/.test(value)) {
    fail('Enter only the server name, like smtp.gmail.com, without http:// or spaces.');
  }
  if (
    (definition.key === 'shop.phone' || definition.key === 'shop.whatsapp') &&
    !/^\+?[\d\s-]{8,16}$/.test(value)
  ) {
    fail('Enter a phone number with 8 to 15 digits.');
  }
  if (definition.key.endsWith('Url') && !/^https:\/\/\S+$/i.test(value)) {
    fail('Enter a full web address starting with https://.');
  }
  if (definition.key.endsWith('ClientId') && !/^[A-Za-z0-9._-]+$/.test(value)) {
    fail('A client ID has letters, digits, dots and dashes only.');
  }
  return value;
}

/**
 * Saves changes from the admin panel. A key left out is unchanged. A string saves that value
 * (a secret is encrypted first), and null removes the saved value so the default applies.
 * Which keys changed is returned so the caller can log it, never the values.
 */
export async function updateSettings(
  changes: Record<string, string | null>,
  adminId: string
): Promise<string[]> {
  const operations: { key: string; definition: SettingDefinition; value: string | null }[] = [];

  for (const [key, value] of Object.entries(changes)) {
    const definition = getDefinition(key);
    if (!definition) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Unknown setting.', [{ field: key, message: 'Unknown setting.' }]);
    }
    // An empty box on a plain setting means "back to the default"; on a secret the panel sends
    // nothing instead, so an empty string is never mistaken for "keep".
    if (value === null || value.trim() === '') {
      operations.push({ key, definition, value: null });
    } else {
      operations.push({ key, definition, value: validate(definition, value) });
    }
  }

  await prisma.$transaction(
    operations.map((operation) => {
      if (operation.value === null) {
        return prisma.setting.deleteMany({ where: { key: operation.key } });
      }
      const isSecret = operation.definition.secret === true;
      const stored = isSecret ? encryptSecret(operation.value) : operation.value;
      return prisma.setting.upsert({
        where: { key: operation.key },
        create: { key: operation.key, value: stored, isSecret, updatedByAdminId: adminId },
        update: { value: stored, isSecret, updatedByAdminId: adminId },
      });
    })
  );

  return operations.map((operation) => operation.key);
}

// ---- Typed readers used by the rest of the server -----------------------------------------

export type SettingsReader = {
  text(key: string): string;
  secret(key: string): string | null;
};

/** One database read, then plain lookups: stored value, else the registry default, else "". */
export async function readSettings(): Promise<SettingsReader> {
  const stored = await loadAll();
  return {
    text: (key) => stored.get(key)?.value ?? getDefinition(key)?.defaultValue ?? '',
    secret: (key) => {
      const row = stored.get(key);
      return row ? decryptSecret(row.value) : null;
    },
  };
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
};

/** The email server details, or null when anything required is missing or unreadable. */
export function smtpConfig(settings: SettingsReader): SmtpConfig | null {
  const host = settings.text('smtp.host');
  const user = settings.text('smtp.user');
  const password = settings.secret('smtp.password');
  const fromEmail = settings.text('smtp.fromEmail') || user;
  if (!host || !user || !password || !EMAIL_PATTERN.test(fromEmail)) {
    return null;
  }
  return {
    host,
    port: Number(settings.text('smtp.port')) || 587,
    secure: settings.text('smtp.secure') === 'true',
    user,
    password,
    fromEmail,
    fromName: settings.text('smtp.fromName') || 'DoorKart',
  };
}

export type GoogleConfig = { enabled: boolean; clientIds: string[]; webClientId: string };

export function googleConfig(settings: SettingsReader): GoogleConfig {
  const webClientId = settings.text('google.webClientId');
  const clientIds = [webClientId, settings.text('google.androidClientId'), settings.text('google.iosClientId')].filter(
    (id) => id !== ''
  );
  return { enabled: settings.text('auth.googleEnabled') === 'true' && webClientId !== '', clientIds, webClientId };
}

export type ShopInfo = {
  name: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  hours: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
};

/** The shop details customers may see. Empty boxes become null so the app can hide them. */
export function shopInfo(settings: SettingsReader): ShopInfo {
  const text = (key: string) => settings.text(key) || null;
  return {
    name: 'DoorKart',
    phone: text('shop.phone'),
    whatsapp: text('shop.whatsapp'),
    email: text('shop.email'),
    address: text('shop.address'),
    hours: text('shop.hours'),
    privacyPolicyUrl: text('shop.privacyPolicyUrl'),
    termsUrl: text('shop.termsUrl'),
  };
}

export function otpExpiryMinutes(settings: SettingsReader): number {
  return Number(settings.text('auth.otpExpiryMinutes')) || 10;
}

export function emailSignInEnabled(settings: SettingsReader): boolean {
  return settings.text('auth.emailEnabled') !== 'false' && smtpConfig(settings) !== null;
}

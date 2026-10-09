/**
 * Every setting the admin panel can change. Adding a setting means adding a line here; the
 * Settings screen, validation, and secret handling all follow from this list. Nothing outside
 * this list can be stored.
 */

export type SettingGroup = 'shop' | 'email' | 'google' | 'signin';
export type SettingType = 'text' | 'email' | 'number' | 'boolean' | 'password';

export type SettingDefinition = {
  key: string;
  group: SettingGroup;
  label: string;
  description?: string;
  placeholder?: string;
  type: SettingType;
  /** Stored encrypted and never sent back to any screen. */
  secret?: boolean;
  /** Used when nothing has been saved. Written as the stored text ("587", "true"). */
  defaultValue?: string;
  min?: number;
  max?: number;
};

export const SETTING_GROUPS: { id: SettingGroup; title: string; description: string }[] = [
  {
    id: 'shop',
    title: 'Shop details',
    description: 'Shown to customers in the app under Help & Support and About. Leave a box empty to hide it.',
  },
  {
    id: 'signin',
    title: 'Customer sign-in',
    description: 'Which ways customers can sign in to the app.',
  },
  {
    id: 'email',
    title: 'Email server (SMTP)',
    description:
      'Used to send sign-in codes. Any SMTP provider works, for example Gmail with an app password, Brevo or Zoho.',
  },
  {
    id: 'google',
    title: 'Google sign-in',
    description:
      'The OAuth client IDs from your Google Cloud project. They are not secret. The server only accepts Google sign-ins made for one of these IDs.',
  },
];

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'shop.phone',
    group: 'shop',
    label: 'Phone number',
    description: 'Customers can tap it to call.',
    placeholder: '9876543210',
    type: 'text',
  },
  {
    key: 'shop.whatsapp',
    group: 'shop',
    label: 'WhatsApp number',
    description: 'Customers can tap it to chat. Digits only; 10 digits are treated as an Indian number.',
    placeholder: '9876543210',
    type: 'text',
  },
  {
    key: 'shop.email',
    group: 'shop',
    label: 'Support email',
    placeholder: 'support@yourshop.com',
    type: 'email',
  },
  {
    key: 'shop.address',
    group: 'shop',
    label: 'Shop address',
    placeholder: 'Shop 4, Main Market, Your City',
    type: 'text',
  },
  {
    key: 'shop.hours',
    group: 'shop',
    label: 'Opening hours',
    placeholder: 'Every day, 9 am to 9 pm',
    type: 'text',
  },
  {
    key: 'shop.privacyPolicyUrl',
    group: 'shop',
    label: 'Privacy policy web address',
    description: 'Google Play requires one. It must start with https://.',
    placeholder: 'https://yourshop.com/privacy',
    type: 'text',
  },
  {
    key: 'shop.termsUrl',
    group: 'shop',
    label: 'Terms of service web address',
    placeholder: 'https://yourshop.com/terms',
    type: 'text',
  },
  {
    key: 'auth.emailEnabled',
    group: 'signin',
    label: 'Sign in with an email code',
    description: 'Needs the email server below to be set up.',
    type: 'boolean',
    defaultValue: 'true',
  },
  {
    key: 'auth.googleEnabled',
    group: 'signin',
    label: 'Sign in with Google',
    description: 'Needs at least the Web client ID below.',
    type: 'boolean',
    defaultValue: 'false',
  },
  {
    key: 'auth.otpExpiryMinutes',
    group: 'signin',
    label: 'Code is valid for (minutes)',
    type: 'number',
    defaultValue: '10',
    min: 3,
    max: 30,
  },
  {
    key: 'smtp.host',
    group: 'email',
    label: 'SMTP host',
    placeholder: 'smtp.gmail.com',
    type: 'text',
  },
  {
    key: 'smtp.port',
    group: 'email',
    label: 'SMTP port',
    description: '587 for most providers (STARTTLS), 465 if "Secure connection" is on.',
    type: 'number',
    defaultValue: '587',
    min: 1,
    max: 65535,
  },
  {
    key: 'smtp.secure',
    group: 'email',
    label: 'Secure connection (SSL/TLS from the start)',
    description: 'Turn on for port 465. Leave off for port 587.',
    type: 'boolean',
    defaultValue: 'false',
  },
  {
    key: 'smtp.user',
    group: 'email',
    label: 'SMTP username',
    placeholder: 'yourshop@gmail.com',
    type: 'text',
  },
  {
    key: 'smtp.password',
    group: 'email',
    label: 'SMTP password or app password',
    description: 'Saved encrypted. It is never shown again; enter a new one to change it.',
    type: 'password',
    secret: true,
  },
  {
    key: 'smtp.fromEmail',
    group: 'email',
    label: 'Send from (email)',
    placeholder: 'yourshop@gmail.com',
    type: 'email',
  },
  {
    key: 'smtp.fromName',
    group: 'email',
    label: 'Send from (name)',
    type: 'text',
    defaultValue: 'DoorKart',
  },
  {
    key: 'google.webClientId',
    group: 'google',
    label: 'Web client ID',
    description: 'Required. The app uses it to ask Google for a sign-in token, and the server checks tokens against it.',
    placeholder: '1234567890-abc.apps.googleusercontent.com',
    type: 'text',
  },
  {
    key: 'google.androidClientId',
    group: 'google',
    label: 'Android client ID',
    description: 'Optional. Created for your Android package name and signing key.',
    type: 'text',
  },
  {
    key: 'google.iosClientId',
    group: 'google',
    label: 'iOS client ID',
    description: 'Optional. Only needed if you ship an iPhone app.',
    type: 'text',
  },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

export function getDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

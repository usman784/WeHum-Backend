import { env } from '../config/env';

/** Defaults for app_config keys (spec §4.2). */
export const CONFIG_DEFAULTS: Record<string, unknown> = {
  main: {
    minVersion: { ios: env.MIN_APP_VERSION_IOS, android: env.MIN_APP_VERSION_ANDROID }, maintenance: false,
    features: { challenges: false, gratitude: false, breathwork: false, milestones: false, intent: false },
    supportEmail: 'hello@wehum.app', defaultReminderTime: '07:00', languages: ['en'],
  },
  today: { emptyRoomThreshold: 10, freeHomePick: 'random', showDailyMessage: false, sections: { progress: true, liveCounter: true, worldMap: true } },
  group: { startUtc: '16:00', lengthMin: 30, lobbyOpenMin: 15, reminderMin: 10 },
  sos: {
    title: 'How can I help?', subtitle: 'Pick what you feel. It starts right away.',
    help: { title: 'Need more help?', body: 'You can contact us and book a personal session with Raphael.', bookingUrl: 'https://wehum.app/book', contactEmail: 'hello@wehum.app' },
  },
  moderation: { dailyLimit: 3, autoHideReports: 3, blockLinks: true, profanity: true, crisisWords: ['suicide', 'kill myself', 'end my life', 'self harm', 'self-harm'], muteAfterHides: 3 },
  legal: { privacyUrl: 'https://wehum.app/privacy', termsUrl: 'https://wehum.app/terms', healthDisclaimer: 'WeHum is meditation training, not therapy or medical care.', deleteInactiveGuestsMonths: 12 },
  catalog: { version: 1 },
};

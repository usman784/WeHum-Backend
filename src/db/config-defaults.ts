import { env } from '../config/env';

/** Defaults for app_config keys (spec §4.2). */
export const CONFIG_DEFAULTS: Record<string, unknown> = {
  main: {
    minVersion: { ios: env.MIN_APP_VERSION_IOS, android: env.MIN_APP_VERSION_ANDROID }, maintenance: false,
    features: { challenges: true, gratitude: false, breathwork: false, milestones: false, intent: false, streaks: true, hourlySits: false, heartRate: false },
    supportEmail: 'hello@wehum.app', defaultReminderTime: '07:00', languages: ['en'],
  },
  branding: { appName: 'WeHum', tagline: 'Meditate together', logoMediaId: null },
  push: { maxPerDay: 2 },
  today: { emptyRoomThreshold: 10, freeHomePick: 'random', showDailyMessage: false, sections: { progress: true, liveCounter: true, worldMap: true } },
  group: {
    startUtc: '16:00', lengthMin: 30, lobbyOpenMin: 15, reminderMin: 10,
    cadence: 'daily', hourly: { fromHourUtc: 6, toHourUtc: 22, lengthMin: 10 },
    intentions: ['Calm under pressure', 'Deep physical release', 'Mindful stillness'],
    focus: { title: '', summary: '', quote: '', attribution: 'Raphael' }, doorsOpenSec: 60,
  },
  silence: { durations: [5, 10, 15, 20, 30, 45, 60, 0], cadence: { inhaleSec: 4, exhaleSec: 6 }, extendMin: 5 },
  crisis: {
    defaultRegion: 'US',
    regions: [
      { code: 'US', name: 'United States & Canada', countries: ['US', 'CA'], lines: [
        { id: '988', name: '988 Suicide & Crisis Lifeline', kind: 'Voice & SMS', description: 'Direct, confidential support for anyone experiencing mental distress, emotional pain, or substance crisis.',
          actions: [{ type: 'call', label: 'Call 988', value: '988' }, { type: 'sms', label: 'Text 988', value: '988' }] },
        { id: 'crisis-text-line', name: 'Crisis Text Line', kind: 'Text only', description: 'Text with a trained crisis counselor within minutes.',
          actions: [{ type: 'sms', label: 'Text HOME to 741741', value: '741741' }] },
        { id: 'trevor', name: 'The Trevor Project', kind: 'LGBTQ+ · 24/7 youth', description: 'Affirming, judgment-free crisis support for young LGBTQ people.',
          actions: [{ type: 'call', label: 'Call 1-866-488-7386', value: '18664887386' }, { type: 'sms', label: 'Text START', value: '678678' }] },
      ] },
      { code: 'GB', name: 'United Kingdom & Ireland', countries: ['GB', 'IE'], lines: [
        { id: 'samaritans', name: 'Samaritans', kind: 'Voice', description: 'Talk to someone, any time, free from any phone.',
          actions: [{ type: 'call', label: 'Call 116 123', value: '116123' }] },
        { id: 'nhs-111', name: 'NHS 111', kind: 'Voice', description: 'Urgent mental health help in England.',
          actions: [{ type: 'call', label: 'Call 111', value: '111' }] },
      ] },
      { code: 'AU', name: 'Australia', countries: ['AU'], lines: [
        { id: 'lifeline-au', name: 'Lifeline', kind: 'Voice & text', description: 'Crisis support and suicide prevention.',
          actions: [{ type: 'call', label: 'Call 13 11 14', value: '131114' }, { type: 'sms', label: 'Text 0477 13 11 14', value: '0477131114' }] },
      ] },
    ],
    international: [
      { country: 'United Kingdom', line: 'NHS 111 · Samaritans 116 123', value: '111' },
      { country: 'European Union', line: 'Universal emergency services', value: '112' },
      { country: 'Australia', line: 'Lifeline crisis support', value: '131114' },
    ],
    tip: 'While waiting for a responder, place both feet flat on the floor, gently relax your jaw, and take slow, extended exhales.',
  },
  sitTimes: { blocks: [
    { time: '06:30', label: 'Dawn Stillness' }, { time: '07:00', label: 'Morning Prime' },
    { time: '12:30', label: 'Midday Reset' }, { time: '21:00', label: 'Night Decompress' },
  ] },
  downloads: { quotaMb: 2400 },
  sos: {
    title: 'How can I help?', subtitle: 'Pick what you feel. It starts right away.',
    soundBeds: ['Low brown noise', 'Brown noise', 'Delta wave', 'None'],
    help: { title: 'Need more help?', body: 'You can contact us and book a personal session with Raphael.', bookingUrl: 'https://wehum.app/book', contactEmail: 'hello@wehum.app' },
  },
  moderation: { dailyLimit: 3, autoHideReports: 3, blockLinks: true, profanity: true, crisisWords: ['suicide', 'kill myself', 'end my life', 'self harm', 'self-harm'], muteAfterHides: 3 },
  legal: { privacyUrl: 'https://wehum.app/privacy', termsUrl: 'https://wehum.app/terms', healthDisclaimer: 'WeHum is meditation training, not therapy or medical care.', deleteInactiveGuestsMonths: 12 },
  breathwork: { lessons: [] },
  catalog: { version: 1 },
};

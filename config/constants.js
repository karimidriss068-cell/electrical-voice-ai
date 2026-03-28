require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL,
  N8N_WEBHOOK_SECRET: process.env.N8N_WEBHOOK_SECRET,
  RETELL_API_KEY: process.env.RETELL_API_KEY,
  COMPANY_NAME: process.env.COMPANY_NAME || 'Volt Electrical Services',
  COMPANY_PHONE: process.env.COMPANY_PHONE || '',
  SERVICE_AREA: process.env.SERVICE_AREA || '',
  EMERGENCY_PHONE: process.env.EMERGENCY_PHONE || '',

  SERVICES: [
    { name: 'Panel Upgrades', description: 'Electrical panel replacement and upgrades' },
    { name: 'EV Charger Installation', description: 'Level 2 and Level 3 EV charger installation' },
    { name: 'Lighting Installation', description: 'Indoor and outdoor lighting, recessed lighting, landscape lighting' },
    { name: 'Wiring & Rewiring', description: 'New construction wiring, knob-and-tube replacement, whole-home rewiring' },
    { name: 'Outlet & Switch Installation', description: 'New outlets, GFCI outlets, USB outlets, smart switches' },
    { name: 'Ceiling Fan Installation', description: 'Ceiling fan installation and replacement' },
    { name: 'Electrical Inspections', description: 'Home inspection, safety inspection, code compliance' },
    { name: 'Generator Installation', description: 'Whole-home and portable generator installation and hookup' },
    { name: 'Surge Protection', description: 'Whole-home surge protection systems' },
    { name: 'Troubleshooting & Repair', description: 'Diagnose and fix electrical issues, flickering lights, tripped breakers' },
    { name: 'Emergency Service', description: '24/7 emergency electrical service for urgent issues' },
  ],

  BUSINESS_HOURS: {
    monday:    { open: '07:00', close: '18:00' },
    tuesday:   { open: '07:00', close: '18:00' },
    wednesday: { open: '07:00', close: '18:00' },
    thursday:  { open: '07:00', close: '18:00' },
    friday:    { open: '07:00', close: '18:00' },
    saturday:  { open: '08:00', close: '14:00' },
    sunday:    null, // closed
  },

  INTENTS: {
    BOOK_APPOINTMENT: 'book_appointment',
    GET_QUOTE: 'get_quote',
    EMERGENCY: 'emergency',
    SERVICE_INQUIRY: 'service_inquiry',
    HOURS_LOCATION: 'hours_location',
    EXISTING_APPOINTMENT: 'existing_appointment',
    SPEAK_TO_HUMAN: 'speak_to_human',
    OTHER: 'other',
  },
};

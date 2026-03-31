/**
 * Multi-tenant configuration for white-label deployment.
 * Each tenant is identified by their Retell phone number (the to_number in the call).
 * Add new clients by adding entries here.
 */

const tenants = {
  // Default tenant — FES Electrical Services
  default: {
    id: 'fes-electrical',
    company_name: process.env.COMPANY_NAME || 'FES Electrical Services',
    company_phone: process.env.COMPANY_PHONE || '9738786111',
    service_area: process.env.SERVICE_AREA || 'Union County New Jersey and surrounding counties',
    emergency_phone: process.env.EMERGENCY_PHONE || '9738786111',
    n8n_webhook_url: process.env.N8N_WEBHOOK_URL || '',
    n8n_webhook_secret: process.env.N8N_WEBHOOK_SECRET || '',
    license_number: '1884',
    pricing: {
      emergency_after_hours: 150,
      free_estimate_threshold: 500,
      panel_upgrade_range: '1500-3500',
      ev_charger_range: '800-1500',
      small_job_range: '150-250',
    },
    services: [
      'Panel upgrades', 'Rewiring', 'EV charger installation', 'Generator service',
      'Outlet and switch work', 'Lighting installation', 'Code violation corrections',
      'Commercial work', 'Safety audits', '24/7 emergency service'
    ],
    voice_id: '11labs-Adrian',
    active: true,
  },

  // Example: add more tenants mapped by their Retell phone number
  // '+12125551234': {
  //   id: 'spark-electric',
  //   company_name: 'Spark Electric LLC',
  //   ...
  // },
};

/**
 * Get tenant config by phone number (to_number from Retell call).
 * Falls back to default tenant if no match.
 */
function getTenant(toNumber) {
  if (toNumber && tenants[toNumber]) {
    return tenants[toNumber];
  }
  return tenants.default;
}

/**
 * Get tenant by ID
 */
function getTenantById(id) {
  for (const [key, tenant] of Object.entries(tenants)) {
    if (tenant.id === id) return tenant;
  }
  return tenants.default;
}

/**
 * List all active tenants
 */
function listTenants() {
  return Object.entries(tenants)
    .filter(([key, t]) => t.active !== false)
    .map(([key, t]) => ({
      id: t.id,
      company_name: t.company_name,
      phone_number: key === 'default' ? 'default' : key,
      service_area: t.service_area,
    }));
}

module.exports = { getTenant, getTenantById, listTenants, tenants };

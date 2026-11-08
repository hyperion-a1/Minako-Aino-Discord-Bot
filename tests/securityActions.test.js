const assert = require('node:assert/strict');
const Module = require('node:module');
let configForTest = null;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './db' && parent?.filename?.endsWith('/utils/securityActions.js')) {
    return { getPool: () => ({ query: async () => ({ rows: [{ config: configForTest }] }) }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeSettings, applySecurityActions, clearCache } = require('../utils/securityActions');
Module._load = originalLoad;

async function main() {
  assert.deepEqual(normalizeSettings({ pauseInvites: true, pauseDms: true, securityDurationHours: 24 }), {
    managed: false, pauseInvites: true, pauseDms: true, durationHours: 24,
  });
  assert.equal(normalizeSettings({ securityActionsManaged: true, securityDurationHours: 99 }).durationHours, 2);

  configForTest = { securityActionsManaged: true, pauseInvites: true, pauseDms: false, securityDurationHours: 2 };
  const calls = [];
  const guild = { id: 'guild-1', client: { rest: { put: async (route, options) => calls.push({ route, options }) } } };
  try {
    const first = await applySecurityActions(guild, 1_800_000_000_000);
    assert.equal(first.applied, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, '/guilds/guild-1/incident-actions');
    assert.ok(calls[0].options.body.invites_disabled_until);
    assert.equal(calls[0].options.body.dms_disabled_until, null);

    await applySecurityActions(guild, 1_800_000_000_001);
    assert.equal(calls.length, 1, 'não deve repetir a chamada a cada ciclo');

    configForTest = { securityActionsManaged: true, pauseInvites: false, pauseDms: true, securityDurationHours: 1 };
    await applySecurityActions(guild, 1_800_000_000_002);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.body.invites_disabled_until, null);
    assert.ok(calls[1].options.body.dms_disabled_until);

    configForTest = { securityActionsManaged: true, pauseInvites: false, pauseDms: false, securityDurationHours: 1 };
    await applySecurityActions(guild, 1_800_000_000_003);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].options.body, { invites_disabled_until: null, dms_disabled_until: null });
  } finally {
    clearCache();
  }
  console.log('securityActions.test.js: OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

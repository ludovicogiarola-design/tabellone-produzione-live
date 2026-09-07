'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const functions = require('./index');

test('Deployment removes per-order FBM and schedules the private morning handler in Italy', () => {
  assert.equal(functions.pickingEmailFbm, undefined);
  assert.ok(functions.pickingEmailFba.__endpoint.eventTrigger);
  const schedule = functions.pickingEmailFbmMorning.__endpoint.scheduleTrigger;
  assert.equal(schedule.schedule, '0 8 * * *');
  assert.equal(schedule.timeZone, 'Europe/Rome');
  assert.equal(functions.pickingEmailFbmMorning.__endpoint.httpsTrigger, undefined);
});

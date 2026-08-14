// Signalements : la liste entière de la soirée, et un « traité » partagé.
//
// Deux choses sont testées ici, et la seconde est celle qui fait mal si elle
// casse. D'abord le curseur : la page ne peut pas recevoir 500 signalements
// toutes les deux secondes, donc elle envoie la révision qu'elle détient et le
// relais ne renvoie la liste que si elle a bougé. Ensuite « traité » : l'état
// vit côté relais, pas dans l'onglet, parce que la page est ouverte sur deux
// écrans un soir d'event et qu'un compteur local raconte deux histoires
// différentes.
//
// L'assertion qui compte vraiment : un signalement marqué traité doit faire
// bouger la révision. Sinon l'autre écran garde son badge et un signalement
// déjà réglé est traité deux fois — ou pire, la page croit être à jour et ne
// redemande plus jamais la liste.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/relay.js';
import { nullEventLog } from '../src/event-log.js';

const API_KEY    = 'testApiKey1234567890';
const API_SECRET = 'testApiSecret12345678901234567890';
const WS_URL     = 'wss://test.example.com';
const ROOM       = 'testroom';
const ADMIN_USER = 'onz';
const ADMIN_PASS = 'sup3r-secret';

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function makeMockRoomService() {
  return {
    async listRooms(names) { return names.map(name => ({ name })); },
    async sendData() {},
    async listParticipants() { return []; },
  };
}

describe('signalements : curseur et « traité » (own relay instance)', () => {
  let relay;
  let PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      adminActions: true,
      // 5/min par IP en vrai, et tout part de 127.0.0.1 ici : le seul montage
      // du test épuiserait le budget. La limite a son propre test ailleurs.
      reportRateLimit: { windowMs: 60_000, max: 1000 },
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  const auth = { authorization: basic(ADMIN_USER, ADMIN_PASS) };
  const state = async (qs = '') =>
    (await fetch(`http://localhost:${PORT}/admin/state.json${qs}`, { headers: auth })).json();
  const report = (message) => fetch(`http://localhost:${PORT}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const mark = (body, headers = auth) =>
    fetch(`http://localhost:${PORT}/admin/actions/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  test('le premier chargement reçoit toute la liste, plus les vingt derniers', async () => {
    // Le plafond de 20 était le vrai défaut : à la 21e plainte, la première
    // disparaissait de la page sans que personne ne le sache.
    for (let i = 0; i < 25; i += 1) await report(`plainte ${i}`);
    const body = await state();
    assert.strictEqual(body.reportsChanged, true);
    assert.strictEqual(body.reports.length, 25);
    assert.strictEqual(body.reports[0].message, 'plainte 24', 'le plus récent en tête');
    assert.ok(body.reports.every(r => r.handled === false));
    assert.ok(body.reports.every(r => Number.isSafeInteger(r.id) && r.id > 0), 'chaque ligne est adressable');
  });

  test('un sondage tranquille ne coûte qu’un nombre', async () => {
    const first = await state();
    const body = await state(`?sinceReport=${first.reportSeq}`);
    assert.strictEqual(body.reportsChanged, false);
    assert.strictEqual(body.reports, undefined, 'rien ne doit repasser sur le fil');
    assert.strictEqual(body.reportSeq, first.reportSeq);
  });

  test('un nouveau signalement fait bouger la révision et renvoie tout', async () => {
    const first = await state();
    await report('ça grésille');
    const body = await state(`?sinceReport=${first.reportSeq}`);
    assert.strictEqual(body.reportsChanged, true);
    assert.strictEqual(body.reports[0].message, 'ça grésille');
    assert.ok(body.reportSeq > first.reportSeq);
  });

  test('marquer traité bascule la ligne et fait bouger la révision', async () => {
    const before = await state();
    const target = before.reports[0];

    const res = await mark({ id: target.id });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, id: target.id, handled: true });

    // Sans ce bump, l'autre écran garde son badge pour toujours.
    const body = await state(`?sinceReport=${before.reportSeq}`);
    assert.strictEqual(body.reportsChanged, true, 'la page doit être prévenue');
    assert.strictEqual(body.reports.find(r => r.id === target.id).handled, true);
  });

  test('et rouvrir le refait passer en attente', async () => {
    const before = await state();
    const target = before.reports.find(r => r.handled);
    assert.ok(target, 'le test précédent doit avoir laissé un signalement traité');

    await mark({ id: target.id, handled: false });
    const body = await state();
    assert.strictEqual(body.reports.find(r => r.id === target.id).handled, false);
  });

  test('remarquer traité deux fois ne bouge rien la seconde fois', async () => {
    // Deux admins qui cliquent en même temps : le second clic ne doit pas
    // forcer un renvoi complet de la liste à tout le monde.
    const before = await state();
    const target = before.reports[0];
    await mark({ id: target.id });
    const after = await state();
    const again = await mark({ id: target.id });
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await state()).reportSeq, after.reportSeq);
  });

  test('un id inconnu ou farfelu est refusé, sans rien casser', async () => {
    assert.strictEqual((await mark({ id: 999999 })).status, 404);
    for (const body of [{}, { id: 0 }, { id: -3 }, { id: 'deux' }, { id: 1.5 }]) {
      assert.strictEqual((await mark(body)).status, 400, `accepté : ${JSON.stringify(body)}`);
    }
    assert.ok((await state()).reports.length > 0, 'la liste est intacte');
  });

  test('sans le mot de passe ce n’est pas une action', async () => {
    const res = await mark({ id: 1 }, { authorization: basic(ADMIN_USER, 'wrong') });
    assert.strictEqual(res.status, 401);
  });

  test('un curseur farfelu redonne la liste complète plutôt qu’une page vide', async () => {
    for (const qs of ['?sinceReport=abc', '?sinceReport=-1', '?sinceReport=1.5']) {
      const body = await state(qs);
      assert.strictEqual(body.reportsChanged, true, `curseur accepté à tort : ${qs}`);
      assert.ok(body.reports.length > 0);
    }
  });
});

describe('/admin/actions/report sans ADMIN_ACTIONS', () => {
  let relay;
  let PORT;

  before(async () => {
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      // adminActions volontairement absent : le déploiement en lecture seule.
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => { await new Promise(r => relay.server.close(r)); });

  test('404, comme tous les autres leviers', async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/actions/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic(ADMIN_USER, ADMIN_PASS) },
      body: JSON.stringify({ id: 1 }),
    });
    assert.strictEqual(res.status, 404);
  });
});

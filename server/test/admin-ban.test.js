// La liste noire : bannir un login, y compris quelqu'un qui n'est pas là.
//
// Ce fichier existe pour trois propriétés, et ce sont les trois qui distinguent
// un ban d'une expulsion. D'abord bannir un login jamais vu doit marcher : les
// noms arrivent la veille, pas au moment où la personne hurle dans le vocal.
// Ensuite le ban doit fermer *toutes* les portes — le lien à usage unique, le
// chemin debug, le socket navigateur, le socket plugin — parce qu'une porte
// oubliée, c'est un ban qui ne bannit rien. Enfin il doit survivre au
// redémarrage : le relais est justement redémarré entre le moment où on tape la
// liste et le moment où l'event commence.
//
// L'assertion qui fait le plus mal si elle casse est la dernière : trois
// perturbateurs qui reviennent parce qu'on a coupé DEBUG_MODE entre-temps, et
// personne ne comprend pourquoi.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    async removeParticipant() {},
  };
}

function tmpBanFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onzban-')), 'bans.json');
}

describe('/admin/actions/ban (own relay instance)', () => {
  let relay;
  let PORT;
  let BAN_FILE;

  before(async () => {
    BAN_FILE = tmpBanFile();
    relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER,
      adminPassword: ADMIN_PASS,
      adminActions: true,
      banFile: BAN_FILE,
      // La soirée tourne avec le debug ouvert : le chemin ?identity= est une
      // vraie porte, pas une hypothèse.
      debugMode: true,
    });
    await new Promise(r => relay.server.listen(0, r));
    PORT = relay.server.address().port;
  });

  after(async () => {
    await new Promise(r => relay.server.close(r));
    fs.rmSync(path.dirname(BAN_FILE), { recursive: true, force: true });
  });

  const auth = { authorization: basic(ADMIN_USER, ADMIN_PASS) };
  const ban = (body, headers = auth) =>
    fetch(`http://localhost:${PORT}/admin/actions/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const token = (qs) => fetch(`http://localhost:${PORT}/token${qs}`);
  const state = async () =>
    (await fetch(`http://localhost:${PORT}/admin/state.json`, { headers: auth })).json();

  test('on bannit un login que le relais n’a jamais vu', async () => {
    // Le cas réel : les noms viennent de Discord la veille, personne n'est
    // connecté. Une action qui exigerait une session en cours serait inutile.
    assert.strictEqual((await token('?identity=perturbateur')).status, 200, 'référence : il peut entrer');

    const res = await ban({ login: 'perturbateur', reason: 'insultes' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.banned, true);
    assert.strictEqual(body.saveError, undefined, 'le fichier doit être écrit');

    assert.strictEqual((await token('?identity=perturbateur')).status, 403);
  });

  test('la casse ne sauve personne', async () => {
    // Le login est recopié à la main depuis un message ou une capture.
    assert.strictEqual((await token('?identity=Perturbateur')).status, 403);
    assert.strictEqual((await token('?identity=PERTURBATEUR')).status, 403);
  });

  test('le ban apparaît sur la page admin, avec son motif', async () => {
    const body = await state();
    const row = (body.bans || []).find(b => b.login === 'perturbateur');
    assert.ok(row, 'absent de state.json');
    assert.strictEqual(row.reason, 'insultes');
    assert.ok(!Number.isNaN(Date.parse(row.since)), `date illisible : ${row.since}`);
    assert.strictEqual(body.banFile, true, 'la page doit savoir que la liste est persistée');
    // Un ban n'est pas un blocage : la page les distingue, le relais aussi.
    assert.deepStrictEqual(body.blocked, []);
  });

  test('personne d’autre n’est attrapé', async () => {
    assert.strictEqual((await token('?identity=tranquille')).status, 200);
  });

  test('un login absent ou farfelu est refusé, sans rien bannir', async () => {
    for (const body of [{}, { login: '' }, { login: 42 }, { login: '   ' }]) {
      assert.strictEqual((await ban(body)).status, 400, `accepté : ${JSON.stringify(body)}`);
    }
    assert.deepStrictEqual((await state()).bans.map(b => b.login), ['perturbateur']);
  });

  test('rebannir garde la date de la décision d’origine', async () => {
    const before = (await state()).bans.find(b => b.login === 'perturbateur');
    await ban({ login: 'perturbateur' });
    const after = (await state()).bans.find(b => b.login === 'perturbateur');
    assert.strictEqual(after.since, before.since);
    assert.strictEqual(after.reason, 'insultes', 'un motif vide ne doit pas effacer le précédent');
  });

  test('le fichier sur le disque contient la liste', async () => {
    // C'est ce fichier, et lui seul, qui fait tenir le ban après un redémarrage.
    const rows = JSON.parse(fs.readFileSync(BAN_FILE, 'utf8'));
    assert.deepStrictEqual(rows.map(r => r.login), ['perturbateur']);
  });

  test('retirer de la liste rend l’accès immédiatement', async () => {
    await ban({ login: 'autre' });
    const res = await ban({ login: 'autre', remove: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).banned, false);
    assert.strictEqual((await token('?identity=autre')).status, 200);
    assert.deepStrictEqual((await state()).bans.map(b => b.login), ['perturbateur']);
  });

  test('retirer quelqu’un qui n’est pas banni est un 404, pas un ok', async () => {
    assert.strictEqual((await ban({ login: 'jamais-vu', remove: true })).status, 404);
  });

  test('sans le mot de passe ce n’est pas une action', async () => {
    const res = await ban({ login: 'perturbateur' }, { authorization: basic(ADMIN_USER, 'wrong') });
    assert.strictEqual(res.status, 401);
  });

  test('un redémarrage du relais ne débannit personne', async () => {
    // La raison d'être du fichier : entre la saisie de la liste et le début de
    // la soirée, le relais est redémarré au moins une fois — ne serait-ce que
    // pour couper DEBUG_MODE.
    const fresh = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER, adminPassword: ADMIN_PASS, adminActions: true,
      banFile: BAN_FILE,
      debugMode: true,
    });
    await new Promise(r => fresh.server.listen(0, r));
    const p = fresh.server.address().port;
    try {
      assert.strictEqual((await fetch(`http://localhost:${p}/token?identity=perturbateur`)).status, 403);
      assert.strictEqual((await fetch(`http://localhost:${p}/token?identity=tranquille`)).status, 200);
    } finally {
      await new Promise(r => fresh.server.close(r));
    }
  });
});

describe('liste noire : fichier illisible et sans fichier', () => {
  test('un fichier corrompu ne doit pas empêcher le relais de démarrer', async () => {
    // Perdre la liste est mauvais ; ne pas démarrer du tout le soir de l'event
    // est pire. Le relais crie dans le journal et sert quand même.
    const file = tmpBanFile();
    fs.writeFileSync(file, '{ ceci n’est pas du JSON');
    const relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER, adminPassword: ADMIN_PASS, adminActions: true,
      banFile: file,
      debugMode: true,
    });
    await new Promise(r => relay.server.listen(0, r));
    const p = relay.server.address().port;
    try {
      assert.strictEqual((await fetch(`http://localhost:${p}/token?identity=quelquun`)).status, 200);
    } finally {
      await new Promise(r => relay.server.close(r));
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  test('sans BAN_FILE le ban marche quand même, et la page le dit', async () => {
    const relay = createRelay({
      roomService: makeMockRoomService(),
      apiKey: API_KEY, apiSecret: API_SECRET, liveKitPublicWsUrl: WS_URL, roomName: ROOM,
      statePushIntervalMs: 3_600_000,
      eventLog: nullEventLog,
      adminUser: ADMIN_USER, adminPassword: ADMIN_PASS, adminActions: true,
      debugMode: true,
    });
    await new Promise(r => relay.server.listen(0, r));
    const p = relay.server.address().port;
    const auth = { authorization: basic(ADMIN_USER, ADMIN_PASS) };
    try {
      await fetch(`http://localhost:${p}/admin/actions/ban`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ login: 'bruyant' }),
      });
      assert.strictEqual((await fetch(`http://localhost:${p}/token?identity=bruyant`)).status, 403);
      const body = await (await fetch(`http://localhost:${p}/admin/state.json`, { headers: auth })).json();
      assert.strictEqual(body.banFile, false, 'la page doit pouvoir avertir que rien n’est persisté');
    } finally {
      await new Promise(r => relay.server.close(r));
    }
  });
});

describe('/admin/actions/ban sans ADMIN_ACTIONS', () => {
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
    const res = await fetch(`http://localhost:${PORT}/admin/actions/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic(ADMIN_USER, ADMIN_PASS) },
      body: JSON.stringify({ login: 'perturbateur' }),
    });
    assert.strictEqual(res.status, 404);
  });
});

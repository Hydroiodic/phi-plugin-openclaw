import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import TapTapHelper from '../lib/TapTap/TapTapHelper.js'
import LCHelper from '../lib/TapTap/LCHelper.js'
import SaveManager from '../lib/SaveManager.js'

test('QR creation, polling, profile, session login and save URLs consistently select the same region', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), ...options })
    return new Response(JSON.stringify({ success: true, data: { device_code: 'synthetic', expires_in: 60, qrcode_url: 'https://example.invalid/login', interval: 1 } }))
  })
  for (const global of [false, true]) {
    const manager = new SaveManager(global)
    const client = manager.headers['X-LC-Id']
    const before = requests.length
    const request = await TapTapHelper.requestLoginQrCode(undefined, global)
    await TapTapHelper.checkQRCodeResult(request, global)
    await TapTapHelper.getProfile({ scope: 'public_profile', kid: 'synthetic', mac_key: 'synthetic' }, global)
    await LCHelper.loginAndGetToken({ openid: 'synthetic' }, global)
    const [qr, poll, profile, login] = requests.slice(before)
    for (const entry of [qr, poll, profile, login]) assert.ok(new URL(entry.url).hostname.endsWith(global ? '.com' : '.cn'))
    assert.equal(qr.body.get('client_id'), client)
    assert.equal(poll.body.get('client_id'), client)
    assert.equal(new URL(profile.url).searchParams.get('client_id'), client)
    assert.equal(login.headers['X-LC-Id'], client)
    const [signature, timestamp] = login.headers['X-LC-Sign'].split(',')
    assert.equal(signature, createHash('md5').update(timestamp + manager.headers['X-LC-Key']).digest('hex'))
    assert.equal(login.url, `${manager.baseUrl}/users`)
  }
})

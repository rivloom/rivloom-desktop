import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encryptChannelPayload, decryptChannelPayload, encryptChannelDataReply, decryptChannelDataReply,
  type SecureChannelSession } from '../server/node-channel.ts';

function channels() {
  const id = randomUUID(); const a = randomBytes(32), b = randomBytes(32);
  const left: SecureChannelSession = { id, localNodeID: 'A'.repeat(32), peerNodeID: 'B'.repeat(32),
    sendKey: a, receiveKey: b, sendSequence: 0, receiveSequence: 0, expiresAt: Date.now() + 60_000 };
  const right: SecureChannelSession = { ...left, localNodeID: left.peerNodeID, peerNodeID: left.localNodeID,
    sendKey: b, receiveKey: a };
  return { left, right };
}
test('collaboration data replies remain independent of simultaneous bidirectional request stream sequencing', () => {
  const { left, right } = channels();
  const requestA = encryptChannelPayload(left, { requestID: 'a' });
  const requestB = encryptChannelPayload(right, { requestID: 'b' });
  decryptChannelPayload(right, requestA); decryptChannelPayload(left, requestB);
  const replyA = encryptChannelDataReply(right, requestA, { private: 'resource A' });
  const replyB = encryptChannelDataReply(left, requestB, { private: 'resource B' });
  // Both responses may arrive in any order relative to the next opposite-direction request.
  const requestC = encryptChannelPayload(left, { requestID: 'c' });
  assert.deepEqual(decryptChannelPayload(right, requestC), { requestID: 'c' });
  assert.deepEqual(decryptChannelDataReply(left, requestA, replyA), { private: 'resource A' });
  assert.deepEqual(decryptChannelDataReply(right, requestB, replyB), { private: 'resource B' });
  assert.equal(right.receiveSequence, 2); assert.equal(left.receiveSequence, 1);
  assert.equal(right.sendSequence, 1); assert(!JSON.stringify(replyA).includes('resource A'));
});
test('data reply authentication fences request replay, wrong owners, modified ciphertext, key changes and expired channels', () => {
  const { left, right } = channels();
  const request = encryptChannelPayload(left, { query: 'abc' }); decryptChannelPayload(right, request);
  const reply = encryptChannelDataReply(right, request, { matches: 2 });
  const later = encryptChannelPayload(left, { query: 'xyz' });
  assert.throws(() => decryptChannelDataReply(left, later, reply));
  for (const invalid of [
    { ...reply, recipientNodeID: 'C'.repeat(32) }, { ...reply, senderNodeID: left.localNodeID },
    { ...reply, sessionID: randomUUID() }, { ...reply, type: 'event-ack' }, { ...reply, tag: randomBytes(16).toString('base64url') },
    { ...reply, iv: randomBytes(12).toString('base64url') }, { ...reply, extra: 'hidden' },
  ]) assert.throws(() => decryptChannelDataReply(left, request, invalid));
  assert.throws(() => decryptChannelDataReply({ ...left, receiveKey: randomBytes(32) }, request, reply));
  assert.throws(() => decryptChannelDataReply({ ...left, expiresAt: 0 }, request, reply));
  assert.throws(() => encryptChannelDataReply(right, later, {}), /authenticated/);
  assert.throws(() => encryptChannelDataReply(right, request, '汉'.repeat(30_000)), /large/);
});

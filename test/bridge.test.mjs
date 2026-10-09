import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertNote, boardRequest } from '../lib/board.mjs';
import { encrypt, decrypt } from '../lib/security.mjs';

test('configuration ciphertext is authenticated', () => {
 process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
 const value = encrypt({ token: 'private' });
 assert.equal(value.includes('private'), false); assert.deepEqual(decrypt(value), { token: 'private' });
 const altered = JSON.parse(value); altered.data = Buffer.from('tampered').toString('base64');
 assert.throws(() => decrypt(JSON.stringify(altered)));
});
test('board key must target a single Note', () => {
 assert.equal(assertNote({currentMessage:{layout: JSON.stringify(Array.from({length:3},()=>Array(15).fill(0)))}}).length,3);
 assert.throws(()=>assertNote({currentMessage:{layout:Array.from({length:6},()=>Array(22).fill(0))}}));
});
test('an exact already-displayed message counts as success, but other conflicts still fail', async () => {
 const duplicate=async()=>({ok:false,status:409,json:async()=>({type:'FingerprintMatch'})});
 assert.deepEqual(await boardRequest('test','POST',{text:'HELLO'},duplicate),{alreadyDisplayed:true});
 const conflict=async()=>({ok:false,status:409,json:async()=>({type:'OtherConflict'})});
 await assert.rejects(boardRequest('test','POST',{text:'HELLO'},conflict),/409/);
 await assert.rejects(boardRequest('test','GET',undefined,duplicate),/409/);
});

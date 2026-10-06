import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, callOk, callTool, USER1_TOKEN, uploadPhoto } from './helpers.js';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('progress photos (acceptance criterion 9)', () => {
  it('upload stores an R2 object under the user prefix and inserts a row', async () => {
    const { status, body } = await uploadPhoto(
      USER1_TOKEN,
      { date: '2026-07-01', pose: 'front', weight_lbs: '205.4', notes: 'morning, fasted' },
      { bytes: JPEG_BYTES },
    );

    expect(status).toBe(201);
    expect(body.r2_key).toMatch(/^user1\/pics\/2026-07-01-front-[0-9a-f]{8}\.jpg$/);
    expect(body.pic.date).toBe('2026-07-01');
    expect(body.pic.pose).toBe('front');
    expect(body.pic.weight_lbs).toBe(205.4);
    expect(body.pic.notes).toBe('morning, fasted');

    // The object really is in R2, with the bytes we sent.
    const object = await env.PICS.get(body.r2_key);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(JPEG_BYTES);

    // And it is visible through the metadata tool.
    const list = await callOk(USER1_TOKEN, 'list_progress_pics', { pose: 'FRONT' });
    expect(list.count).toBe(1);
    expect(list.pics[0].id).toBe(body.pic.id);
  });

  it('get_progress_pic returns an image block plus metadata and a working link', async () => {
    const upload = await uploadPhoto(
      USER1_TOKEN,
      { date: '2026-07-02', pose: 'side' },
      { bytes: JPEG_BYTES },
    );
    const picId: number = upload.body.pic.id;

    const outcome = await callTool(USER1_TOKEN, 'get_progress_pic', { id: picId });
    expect(outcome.isError).toBe(false);

    const image = outcome.content.find((block: any) => block.type === 'image');
    expect(image).toBeDefined();
    expect(image.mimeType).toBe('image/jpeg');
    // Base64 of the exact bytes we uploaded.
    expect(Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))).toEqual(JPEG_BYTES);

    // Metadata block, with the R2 key withheld and an expiring link included.
    expect(outcome.data.pose).toBe('side');
    expect(outcome.data.r2_key).toBeUndefined();
    expect(outcome.data.expiring_url).toContain('/pic/');

    // The fallback link works with no Authorization header at all.
    const viaLink = await SELF.fetch(outcome.data.expiring_url);
    expect(viaLink.status).toBe(200);
    expect(viaLink.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await viaLink.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('a signed link cannot be edited to point at another user or another photo', async () => {
    const upload = await uploadPhoto(USER1_TOKEN, { date: '2026-07-03' }, { bytes: JPEG_BYTES });
    const outcome = await callTool(USER1_TOKEN, 'get_progress_pic', { id: upload.body.pic.id });
    const signed = new URL(outcome.data.expiring_url);

    // Swap the user: the MAC covers it, so this must fail.
    const swapped = new URL(signed);
    swapped.searchParams.set('u', 'user2');
    expect((await SELF.fetch(swapped.toString())).status).toBe(401);

    // Point at a different photo id, keeping the signature.
    const otherId = new URL(signed);
    otherId.pathname = '/pic/99999';
    expect((await SELF.fetch(otherId.toString())).status).toBe(401);

    // Extend the expiry.
    const extended = new URL(signed);
    extended.searchParams.set('exp', String(Number(signed.searchParams.get('exp')) + 86_400));
    expect((await SELF.fetch(extended.toString())).status).toBe(401);

    // Tamper with the signature itself.
    const tampered = new URL(signed);
    const sig = signed.searchParams.get('sig')!;
    tampered.searchParams.set('sig', `${sig.slice(0, -1)}${sig.endsWith('a') ? 'b' : 'a'}`);
    expect((await SELF.fetch(tampered.toString())).status).toBe(401);

    // The untampered link still works.
    expect((await SELF.fetch(signed.toString())).status).toBe(200);
  });

  it('get_progress_pic can address a photo by date and pose', async () => {
    await uploadPhoto(USER1_TOKEN, { date: '2026-07-04', pose: 'front' }, { bytes: JPEG_BYTES });
    await uploadPhoto(USER1_TOKEN, { date: '2026-07-04', pose: 'back' }, { bytes: JPEG_BYTES });

    const back = await callTool(USER1_TOKEN, 'get_progress_pic', {
      date: '2026-07-04',
      pose: 'back',
    });
    expect(back.isError).toBe(false);
    expect(back.data.pose).toBe('back');

    const missing = await callTool(USER1_TOKEN, 'get_progress_pic', { date: '2026-07-05' });
    expect(missing.isError).toBe(true);
  });

  it('refuses to inline a photo over ~3 MB, handing back the link instead', async () => {
    // Over the 3 MB inline cap but under the 8 MB /upload ceiling, so it stores.
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
    const upload = await uploadPhoto(USER1_TOKEN, { date: '2026-07-07', pose: 'front' }, { bytes: big });
    expect(upload.status).toBe(201);

    const outcome = await callTool(USER1_TOKEN, 'get_progress_pic', { id: upload.body.pic.id });
    // Errors rather than embedding ~4 MB of base64...
    expect(outcome.isError).toBe(true);
    // ...returns no image block...
    expect(outcome.content.find((block: any) => block.type === 'image')).toBeUndefined();
    // ...but still carries a usable expiring link so the photo is reachable.
    expect(outcome.text).toContain('/pic/');

    // A photo comfortably under the cap still embeds as an image block.
    const small = await uploadPhoto(USER1_TOKEN, { date: '2026-07-08', pose: 'back' }, { bytes: JPEG_BYTES });
    const ok = await callTool(USER1_TOKEN, 'get_progress_pic', { id: small.body.pic.id });
    expect(ok.isError).toBe(false);
    expect(ok.content.find((block: any) => block.type === 'image')).toBeDefined();
  });

  it('rejects a non-image upload and an oversized upload', async () => {
    const notImage = await uploadPhoto(
      USER1_TOKEN,
      {},
      { bytes: new Uint8Array([1, 2, 3]), name: 'notes.txt', type: 'text/plain' },
    );
    expect(notImage.status).toBe(415);

    const tooBig = await uploadPhoto(
      USER1_TOKEN,
      {},
      { bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
    );
    expect(tooBig.status).toBe(413);

    // Neither left a row behind.
    const list = await callOk(USER1_TOKEN, 'list_progress_pics');
    expect(list.count).toBe(0);
  });

  it('rejects an upload with no file part', async () => {
    const form = new FormData();
    form.append('date', '2026-07-06');
    const response = await SELF.fetch(`${BASE}/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${USER1_TOKEN}` },
      body: form,
    });
    expect(response.status).toBe(400);
  });
});

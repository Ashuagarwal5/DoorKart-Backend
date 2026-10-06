import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_IMAGE_BYTES } from '../src/modules/media/media-types.js';
import {
  type AdminAgent,
  app,
  createTestAdmin,
  type Fixtures,
  placeTestOrder,
  prisma,
  resetDatabase,
  seedFixtures,
  signIn,
} from './helpers.js';

const UPLOADS = '/api/v1/admin/uploads';
const PRODUCTS = '/api/v1/admin/products';

// Real file signatures followed by padding. The server reads the first bytes, not the name.
const pad = (head: number[], total = 64) => Buffer.concat([Buffer.from(head), Buffer.alloc(total - head.length)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(52)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(52)]);

let admin: AdminAgent;
let fixtures: Fixtures;

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  await createTestAdmin();
  admin = await signIn();
});

const upload = (agent: { post: (url: string) => request.Test }, file: Buffer, name: string) =>
  agent.post(UPLOADS).attach('file', file, name);

describe('admin uploads', () => {
  it('stores a picture under a random name and serves it back publicly', async () => {
    const response = await upload(admin, JPEG, 'my photo.jpg');

    expect(response.status).toBe(201);
    expect(response.body.data.mediaType).toBe('IMAGE');
    expect(response.body.data.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.jpg$/);
    expect(response.body.data.url).not.toContain('photo');

    // No sign-in needed to view it: customers see product pictures.
    const served = await request(app).get(response.body.data.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('recognises videos and supports range requests so they can seek', async () => {
    const response = await upload(admin, MP4, 'clip.mp4');
    expect(response.status).toBe(201);
    expect(response.body.data.mediaType).toBe('VIDEO');

    const partial = await request(app).get(response.body.data.url).set('Range', 'bytes=0-9');
    expect(partial.status).toBe(206);
  });

  it('decides the type from the file contents, not from its name or declared type', async () => {
    const response = await admin
      .post(UPLOADS)
      .attach('file', Buffer.from('<script>alert(1)</script>'.padEnd(64, ' ')), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it('gives a clear message for HEIC phone photos', async () => {
    const response = await upload(admin, HEIC, 'IMG_0001.heic');

    expect(response.status).toBe(415);
    expect(response.body.error.message).toMatch(/HEIC/);
  });

  it('refuses a picture over the size limit', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const response = await upload(admin, big, 'big.jpg');

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a request with no file', async () => {
    const response = await admin.post(UPLOADS).field('note', 'hello');

    expect(response.status).toBe(400);
  });

  it('requires an admin session', async () => {
    const response = await upload(request(app), JPEG, 'a.jpg');

    expect(response.status).toBe(401);
  });

  it('refuses uploads from an origin that is not the admin panel', async () => {
    const response = await upload(admin, JPEG, 'a.jpg').set('Origin', 'http://evil.example');

    expect(response.status).toBe(403);
  });

  it('does not serve anything outside the uploads folder', async () => {
    const response = await request(app).get('/uploads/..%2f..%2fpackage.json');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.data).toBeUndefined();
  });
});

describe('product media', () => {
  const newProduct = (images: unknown[]) => ({
    name: 'Media Product',
    description: 'A product with media.',
    categoryId: fixtures.categories.stationery.id,
    sku: 'MEDIA-1',
    mrpPaise: 10000,
    sellingPricePaise: 9000,
    stockQuantity: 5,
    images,
  });

  it('saves uploaded pictures and videos in order, and the public catalogue labels each one', async () => {
    const photo = (await upload(admin, PNG, 'a.png')).body.data;
    const video = (await upload(admin, MP4, 'b.mp4')).body.data;

    const created = await admin.post(PRODUCTS).send(
      newProduct([
        { url: video.url, mediaType: 'VIDEO' },
        { url: photo.url, mediaType: 'IMAGE', altText: 'Front' },
      ])
    );
    expect(created.status).toBe(201);
    expect(created.body.data.images.map((image: { mediaType: string }) => image.mediaType)).toEqual(['VIDEO', 'IMAGE']);

    const publicList = await request(app).get('/api/v1/products').query({ search: 'Media' });
    const images = publicList.body.data.items[0].images;
    expect(images).toEqual([
      expect.objectContaining({ url: video.url, mediaType: 'VIDEO' }),
      expect.objectContaining({ url: photo.url, mediaType: 'IMAGE' }),
    ]);
  });

  it('treats an image without a type as a picture, so older clients keep working', async () => {
    const created = await admin.post(PRODUCTS).send(newProduct([{ url: 'https://example.test/a.jpg' }]));

    expect(created.status).toBe(201);
    expect(created.body.data.images[0].mediaType).toBe('IMAGE');
  });

  it('refuses a reference to an uploaded file that does not exist', async () => {
    const missing = '/uploads/00000000-0000-4000-8000-000000000000.jpg';
    const response = await admin.post(PRODUCTS).send(newProduct([{ url: missing }]));

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe('images.0.url');
  });

  it('refuses paths that are not files this server issued', async () => {
    for (const url of ['/uploads/../.env', '/uploads/evil.jpg', '/etc/passwd', 'javascript:alert(1)']) {
      const response = await admin.post(PRODUCTS).send(newProduct([{ url }]));
      expect(response.status, url).toBe(400);
    }
  });

  it('allows at most three videos', async () => {
    const video = (await upload(admin, MP4, 'b.mp4')).body.data;
    const response = await admin
      .post(PRODUCTS)
      .send(newProduct(Array.from({ length: 4 }, () => ({ url: video.url, mediaType: 'VIDEO' }))));

    expect(response.status).toBe(400);
  });

  it('snapshots the first picture, never a video, onto an order line', async () => {
    const photo = (await upload(admin, PNG, 'a.png')).body.data;
    const video = (await upload(admin, MP4, 'b.mp4')).body.data;
    const created = await admin.post(PRODUCTS).send(
      newProduct([
        { url: video.url, mediaType: 'VIDEO' },
        { url: photo.url, mediaType: 'IMAGE' },
      ])
    );

    const order = await placeTestOrder(fixtures, [{ productId: created.body.data.id, quantity: 1 }]);

    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(line.productImage).toBe(photo.url);
  });
});

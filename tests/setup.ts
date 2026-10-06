import { afterAll } from 'vitest';

import { prisma } from '../src/lib/prisma.js';

// Close this test file's database connections so the run can exit promptly.
afterAll(async () => {
  await prisma.$disconnect();
});

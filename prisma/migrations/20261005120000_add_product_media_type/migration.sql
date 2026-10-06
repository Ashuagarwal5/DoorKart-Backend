-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO');

-- AlterTable: existing rows are all pictures, so they take the default.
ALTER TABLE "ProductImage" ADD COLUMN     "mediaType" "MediaType" NOT NULL DEFAULT 'IMAGE';

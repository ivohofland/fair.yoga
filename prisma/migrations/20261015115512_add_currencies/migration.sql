-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Currency" ADD VALUE 'INR';
ALTER TYPE "Currency" ADD VALUE 'SGD';
ALTER TYPE "Currency" ADD VALUE 'AUD';
ALTER TYPE "Currency" ADD VALUE 'CAD';
ALTER TYPE "Currency" ADD VALUE 'NZD';
ALTER TYPE "Currency" ADD VALUE 'HKD';
ALTER TYPE "Currency" ADD VALUE 'BRL';
ALTER TYPE "Currency" ADD VALUE 'MXN';
ALTER TYPE "Currency" ADD VALUE 'ZAR';
ALTER TYPE "Currency" ADD VALUE 'PLN';
ALTER TYPE "Currency" ADD VALUE 'CZK';
ALTER TYPE "Currency" ADD VALUE 'ILS';
ALTER TYPE "Currency" ADD VALUE 'AED';

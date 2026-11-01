-- CreateEnum
CREATE TYPE "NotebookBackground" AS ENUM ('light', 'dark');

-- AlterTable
ALTER TABLE "Notebook" ADD COLUMN     "background" "NotebookBackground" NOT NULL DEFAULT 'dark';

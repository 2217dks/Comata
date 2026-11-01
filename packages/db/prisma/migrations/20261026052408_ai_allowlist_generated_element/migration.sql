-- DropEnum
DROP TYPE "RunStatus";

-- CreateTable
CREATE TABLE "AiAllowlist" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAllowlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedElement" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "html" TEXT NOT NULL,
    "specVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedElement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAllowlist_email_key" ON "AiAllowlist"("email");

-- CreateIndex
CREATE INDEX "GeneratedElement_userId_createdAt_idx" ON "GeneratedElement"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "GeneratedElement" ADD CONSTRAINT "GeneratedElement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

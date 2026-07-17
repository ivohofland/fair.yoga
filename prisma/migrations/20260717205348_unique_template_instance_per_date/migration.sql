-- CreateIndex
CREATE UNIQUE INDEX "Class_templateId_date_key" ON "Class"("templateId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StudioClass_templateId_date_key" ON "StudioClass"("templateId", "date");

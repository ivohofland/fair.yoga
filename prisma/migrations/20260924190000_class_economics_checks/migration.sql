-- Economic invariants, DB-enforced, on both tables that carry a class's
-- economics. The update services check the cross-field three on the merged
-- row before writing; these refuse any writer that does not.
ALTER TABLE "Class" ADD CONSTRAINT "Class_room_cost_check"            CHECK ("roomCost" >= 0);
ALTER TABLE "Class" ADD CONSTRAINT "Class_min_students_range_check"   CHECK ("minStudents" BETWEEN 0 AND 200);
ALTER TABLE "Class" ADD CONSTRAINT "Class_max_students_range_check"   CHECK ("maxStudents" BETWEEN 1 AND 200);
ALTER TABLE "Class" ADD CONSTRAINT "Class_students_order_check"       CHECK ("minStudents" <= "maxStudents");
ALTER TABLE "Class" ADD CONSTRAINT "Class_rate_order_check"           CHECK ("minRate" <= "targetRate");
ALTER TABLE "Class" ADD CONSTRAINT "Class_room_subsidy_check"         CHECK ("minRate" >= -"roomCost");

ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_room_cost_check"          CHECK ("roomCost" >= 0);
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_min_students_range_check" CHECK ("minStudents" BETWEEN 0 AND 200);
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_max_students_range_check" CHECK ("maxStudents" BETWEEN 1 AND 200);
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_students_order_check"     CHECK ("minStudents" <= "maxStudents");
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_rate_order_check"         CHECK ("minRate" <= "targetRate");
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_room_subsidy_check"       CHECK ("minRate" >= -"roomCost");

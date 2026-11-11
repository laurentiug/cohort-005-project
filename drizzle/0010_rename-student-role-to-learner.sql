-- Learner is the glossary term for the role formerly stored as "student".
UPDATE `users` SET `role` = 'learner' WHERE `role` = 'student';

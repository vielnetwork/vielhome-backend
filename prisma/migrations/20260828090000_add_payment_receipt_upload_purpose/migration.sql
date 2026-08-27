-- PostgreSQL requires a newly added enum value to be committed before a
-- later transaction may use it in a CHECK constraint.
ALTER TYPE "DocumentUploadPurpose" ADD VALUE IF NOT EXISTS 'PAYMENT_RECEIPT';

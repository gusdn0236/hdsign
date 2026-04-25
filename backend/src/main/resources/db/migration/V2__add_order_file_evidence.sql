ALTER TABLE order_files
    ADD COLUMN is_evidence BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN uploaded_department VARCHAR(100) NULL;

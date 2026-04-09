-- ============================================================
-- ACME Insurance schema — init script for postgres-kg
-- Creates the acme_insurance PostgreSQL schema with all 13
-- tables from the ACME P&C Insurance benchmark.
--
-- Source DDL: datadotworld/cwd-benchmark-data
--             ACME_Insurance/DDL/ACME_small.ddl
--
-- This script runs on container startup via docker-entrypoint-initdb.d
-- (alongside init-kg.sql which creates extensions).
--
-- DATA LOADING: after running this script, upload CSVs from
-- ACME_Insurance/data/ using COPY or psql \copy commands.
-- See docs/exploratory_data_analysis/insurance/README.md for details.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS acme_insurance;

SET search_path TO acme_insurance;

-- ------------------------------------------------------------
-- catastrophe — must come before claim (FK dependency)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catastrophe (
    catastrophe_identifier  INTEGER      NOT NULL,
    catastrophe_name        VARCHAR(100),
    catastrophe_type_code   VARCHAR(20),
    CONSTRAINT pk_catastrophe PRIMARY KEY (catastrophe_identifier)
);

-- ------------------------------------------------------------
-- policy
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy (
    policy_identifier     INTEGER     NOT NULL,
    policy_number         VARCHAR(20),
    effective_date        TIMESTAMP,
    expiration_date       TIMESTAMP,
    insurance_type_code   VARCHAR(5),
    status_code           VARCHAR(5),
    CONSTRAINT pk_policy PRIMARY KEY (policy_identifier)
);

-- ------------------------------------------------------------
-- claim
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim (
    claim_identifier        INTEGER     NOT NULL,
    company_claim_number    VARCHAR(20),
    claim_open_date         TIMESTAMP,
    claim_close_date        TIMESTAMP,
    claim_reopen_date       TIMESTAMP,
    catastrophe_identifier  INTEGER,
    CONSTRAINT pk_claim PRIMARY KEY (claim_identifier),
    CONSTRAINT fk_claim_catastrophe
        FOREIGN KEY (catastrophe_identifier) REFERENCES catastrophe (catastrophe_identifier)
);

-- ------------------------------------------------------------
-- policy_coverage_detail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_coverage_detail (
    policy_coverage_detail_identifier  BIGINT        NOT NULL,
    policy_identifier                  INTEGER       NOT NULL,
    inclusion_exclusion_code           VARCHAR(5),
    effective_date                     TIMESTAMP,
    expiration_date                    TIMESTAMP,
    coverage_description               VARCHAR(2000),
    CONSTRAINT pk_policy_coverage_detail PRIMARY KEY (policy_coverage_detail_identifier),
    CONSTRAINT fk_pcd_policy
        FOREIGN KEY (policy_identifier) REFERENCES policy (policy_identifier)
);

-- ------------------------------------------------------------
-- claim_coverage  (join table: Claim ↔ PolicyCoverageDetail)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_coverage (
    claim_identifier                   INTEGER  NOT NULL,
    policy_coverage_detail_identifier  BIGINT   NOT NULL,
    CONSTRAINT pk_claim_coverage
        PRIMARY KEY (claim_identifier, policy_coverage_detail_identifier),
    CONSTRAINT fk_cc_claim
        FOREIGN KEY (claim_identifier) REFERENCES claim (claim_identifier),
    CONSTRAINT fk_cc_pcd
        FOREIGN KEY (policy_coverage_detail_identifier)
            REFERENCES policy_coverage_detail (policy_coverage_detail_identifier)
);

-- ------------------------------------------------------------
-- policy_amount
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_amount (
    policy_amount_identifier           INTEGER        NOT NULL,
    policy_coverage_detail_identifier  BIGINT         NOT NULL,
    policy_amount_type_code            VARCHAR(10),
    policy_amount                      NUMERIC(15,2),
    earning_period_start               TIMESTAMP,
    earning_period_end                 TIMESTAMP,
    CONSTRAINT pk_policy_amount PRIMARY KEY (policy_amount_identifier),
    CONSTRAINT fk_pa_pcd
        FOREIGN KEY (policy_coverage_detail_identifier)
            REFERENCES policy_coverage_detail (policy_coverage_detail_identifier)
);

-- ------------------------------------------------------------
-- premium  (subtype of policy_amount)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS premium (
    policy_amount_identifier  INTEGER  NOT NULL,
    CONSTRAINT pk_premium PRIMARY KEY (policy_amount_identifier),
    CONSTRAINT fk_premium_pa
        FOREIGN KEY (policy_amount_identifier) REFERENCES policy_amount (policy_amount_identifier)
);

-- ------------------------------------------------------------
-- claim_amount  (abstract financial row per claim)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_amount (
    claim_amount_identifier  INTEGER        NOT NULL,
    claim_identifier         INTEGER        NOT NULL,
    claim_amount_type_code   VARCHAR(10),
    event_date               TIMESTAMP,
    claim_amount             NUMERIC(15,2),
    CONSTRAINT pk_claim_amount PRIMARY KEY (claim_amount_identifier),
    CONSTRAINT fk_ca_claim
        FOREIGN KEY (claim_identifier) REFERENCES claim (claim_identifier)
);

-- ------------------------------------------------------------
-- loss_payment  (subtype of claim_amount)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loss_payment (
    claim_amount_identifier  INTEGER  NOT NULL,
    CONSTRAINT pk_loss_payment PRIMARY KEY (claim_amount_identifier),
    CONSTRAINT fk_lp_ca
        FOREIGN KEY (claim_amount_identifier) REFERENCES claim_amount (claim_amount_identifier)
);

-- ------------------------------------------------------------
-- loss_reserve  (subtype of claim_amount)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loss_reserve (
    claim_amount_identifier  INTEGER  NOT NULL,
    CONSTRAINT pk_loss_reserve PRIMARY KEY (claim_amount_identifier),
    CONSTRAINT fk_lr_ca
        FOREIGN KEY (claim_amount_identifier) REFERENCES claim_amount (claim_amount_identifier)
);

-- ------------------------------------------------------------
-- expense_payment  (subtype of claim_amount)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_payment (
    claim_amount_identifier  INTEGER  NOT NULL,
    CONSTRAINT pk_expense_payment PRIMARY KEY (claim_amount_identifier),
    CONSTRAINT fk_ep_ca
        FOREIGN KEY (claim_amount_identifier) REFERENCES claim_amount (claim_amount_identifier)
);

-- ------------------------------------------------------------
-- expense_reserve  (subtype of claim_amount)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expense_reserve (
    claim_amount_identifier  INTEGER  NOT NULL,
    CONSTRAINT pk_expense_reserve PRIMARY KEY (claim_amount_identifier),
    CONSTRAINT fk_er_ca
        FOREIGN KEY (claim_amount_identifier) REFERENCES claim_amount (claim_amount_identifier)
);

-- ------------------------------------------------------------
-- agreement_party_role  (parties linked to policies)
-- party_role_code = 'AG' → Agent
-- party_role_code = 'PH' → PolicyHolder
-- party_role_code = 'UW' → Underwriter
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreement_party_role (
    agreement_identifier  INTEGER  NOT NULL,
    party_identifier      INTEGER  NOT NULL,
    party_role_code       CHAR(2)  NOT NULL,
    CONSTRAINT pk_agreement_party_role
        PRIMARY KEY (agreement_identifier, party_identifier, party_role_code)
);

-- ------------------------------------------------------------
-- Indexes for common join patterns
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_claim_catastrophe
    ON claim (catastrophe_identifier);

CREATE INDEX IF NOT EXISTS idx_pcd_policy
    ON policy_coverage_detail (policy_identifier);

CREATE INDEX IF NOT EXISTS idx_claim_coverage_claim
    ON claim_coverage (claim_identifier);

CREATE INDEX IF NOT EXISTS idx_claim_coverage_pcd
    ON claim_coverage (policy_coverage_detail_identifier);

CREATE INDEX IF NOT EXISTS idx_ca_claim
    ON claim_amount (claim_identifier);

CREATE INDEX IF NOT EXISTS idx_pa_pcd
    ON policy_amount (policy_coverage_detail_identifier);

CREATE INDEX IF NOT EXISTS idx_apr_agreement
    ON agreement_party_role (agreement_identifier);

CREATE INDEX IF NOT EXISTS idx_apr_party_role
    ON agreement_party_role (party_identifier, party_role_code);

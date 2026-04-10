#!/usr/bin/env bash
# =============================================================================
# load-insurance-data.sh
#
# Loads ACME P&C Insurance benchmark CSVs into the postgres-kg container.
# Uses temp tables to handle column name/count mismatches between CSVs and DDL.
#
# Prerequisites:
#   1. Clone the benchmark data:
#        git clone git@github.com:datadotworld/cwd-benchmark-data.git \
#          data/cwd-benchmark-data
#
#   2. Apply the schema to the running postgres-kg container (one-time):
#        psql "host=localhost port=5433 user=admin password=test1234 dbname=kg" \
#          -f infra/postgres/init-insurance.sql
#
#   3. Run this script:
#        chmod +x scripts/load-insurance-data.sh
#        ./scripts/load-insurance-data.sh
#
# Connection: localhost:5433  user=admin  password=test1234  db=kg
# Target schema: acme_insurance
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CSV_DIR="$REPO_ROOT/data/cwd-benchmark-data/ACME_Insurance/data"

if [[ ! -d "$CSV_DIR" ]]; then
  echo "ERROR: CSV directory not found: $CSV_DIR"
  echo "       Run: git clone git@github.com:datadotworld/cwd-benchmark-data.git data/cwd-benchmark-data"
  exit 1
fi

export PGPASSWORD=test1234
PSQL="psql --host=localhost --port=5433 --username=admin --dbname=kg"

# Generate a SQL script with all loading logic and run it in a single session.
# Temp tables bridge column name/count mismatches between CSVs and the DDL.
TMPFILE=$(mktemp /tmp/load-insurance-XXXX.sql)
trap 'rm -f "$TMPFILE"' EXIT

cat > "$TMPFILE" << SQL
\set ON_ERROR_STOP on

-- ============================================================
-- catastrophe
-- CSV cols (5): Catastrophe_Identifier, Catastrophe_Type_Code, Catastrophe_Name,
--               Industry_Catastrophe_Code, Company_Catastrophe_Code
-- DDL cols (3): catastrophe_identifier, catastrophe_type_code, catastrophe_name
-- ============================================================
CREATE TEMP TABLE tmp_catastrophe (
  catastrophe_identifier      int,
  catastrophe_type_code       varchar(20),
  catastrophe_name            varchar(100),
  industry_catastrophe_code   varchar,
  company_catastrophe_code    varchar
);
\copy tmp_catastrophe FROM '$CSV_DIR/Catastrophe.csv' CSV HEADER
INSERT INTO acme_insurance.catastrophe (catastrophe_identifier, catastrophe_type_code, catastrophe_name)
SELECT catastrophe_identifier, catastrophe_type_code, catastrophe_name FROM tmp_catastrophe
ON CONFLICT DO NOTHING;

-- ============================================================
-- policy
-- CSV cols (6): Policy_Identifier, Effective_Date, Expiration_Date, Policy_Number,
--               Status_Code, Geographic_Location_Identifier
-- DDL cols (6): policy_identifier, policy_number, effective_date, expiration_date,
--               insurance_type_code (NULL — not in CSV), status_code
-- ============================================================
CREATE TEMP TABLE tmp_policy (
  policy_identifier               int,
  effective_date                  timestamp,
  expiration_date                 timestamp,
  policy_number                   varchar(20),
  status_code                     varchar(5),
  geographic_location_identifier  int
);
\copy tmp_policy FROM '$CSV_DIR/Policy.csv' CSV HEADER
INSERT INTO acme_insurance.policy (policy_identifier, effective_date, expiration_date, policy_number, status_code)
SELECT policy_identifier, effective_date, expiration_date, policy_number, status_code FROM tmp_policy
ON CONFLICT DO NOTHING;

-- ============================================================
-- policy_coverage_detail
-- CSV cols (9): Effective_Date, Policy_Coverage_Detail_Identifier, Coverage_Identifier,
--               Insurable_Object_Identifier, Policy_Identifier, Coverage_Part_Code,
--               Coverage_Description, Expiration_Date, Coverage_Inclusion_Exclusion_Code
-- DDL cols (6): policy_coverage_detail_identifier, policy_identifier, inclusion_exclusion_code,
--               effective_date, expiration_date, coverage_description
-- ============================================================
CREATE TEMP TABLE tmp_pcd (
  effective_date                          timestamp,
  policy_coverage_detail_identifier       bigint,
  coverage_identifier                     int,
  insurable_object_identifier             int,
  policy_identifier                       int,
  coverage_part_code                      varchar,
  coverage_description                    varchar(2000),
  expiration_date                         timestamp,
  coverage_inclusion_exclusion_code       varchar(5)
);
\copy tmp_pcd FROM '$CSV_DIR/Policy_Coverage_Detail.csv' CSV HEADER
INSERT INTO acme_insurance.policy_coverage_detail
  (policy_coverage_detail_identifier, policy_identifier, inclusion_exclusion_code,
   effective_date, expiration_date, coverage_description)
SELECT policy_coverage_detail_identifier, policy_identifier, coverage_inclusion_exclusion_code,
       effective_date, expiration_date, coverage_description
FROM tmp_pcd
ON CONFLICT DO NOTHING;

-- ============================================================
-- agreement_party_role
-- CSV cols (5): Agreement_Identifier, Party_Identifier, Party_Role_Code, Effective_Date, Expiration_Date
-- DDL cols (3): agreement_identifier, party_identifier, party_role_code
-- ============================================================
CREATE TEMP TABLE tmp_apr (
  agreement_identifier  int,
  party_identifier      int,
  party_role_code       char(2),
  effective_date        timestamp,
  expiration_date       timestamp
);
\copy tmp_apr FROM '$CSV_DIR/Agreement_Party_Role.csv' CSV HEADER
INSERT INTO acme_insurance.agreement_party_role (agreement_identifier, party_identifier, party_role_code)
SELECT agreement_identifier, party_identifier, party_role_code FROM tmp_apr
ON CONFLICT DO NOTHING;

-- ============================================================
-- claim
-- CSV cols (14): Claim_Identifier, Catastrophe_Identifier, Claim_Description, Claims_Made_Date,
--                Company_Claim_Number, Company_Subclaim_Number, Insurable_Object_Identifier,
--                Occurrence_Identifier, Entry_Into_Claims_Made_Program_Date, Claim_Open_Date,
--                Claim_Close_Date, Claim_Reopen_Date, Claim_Status_Code, Claim_Reported_Date
-- DDL cols (6):  claim_identifier, company_claim_number, claim_open_date, claim_close_date,
--                claim_reopen_date, catastrophe_identifier
-- ============================================================
CREATE TEMP TABLE tmp_claim (
  claim_identifier                        int,
  catastrophe_identifier                  int,
  claim_description                       varchar,
  claims_made_date                        timestamp,
  company_claim_number                    varchar(20),
  company_subclaim_number                 varchar,
  insurable_object_identifier             int,
  occurrence_identifier                   int,
  entry_into_claims_made_program_date     timestamp,
  claim_open_date                         timestamp,
  claim_close_date                        timestamp,
  claim_reopen_date                       timestamp,
  claim_status_code                       varchar,
  claim_reported_date                     timestamp
);
\copy tmp_claim FROM '$CSV_DIR/Claim.csv' CSV HEADER
INSERT INTO acme_insurance.claim
  (claim_identifier, company_claim_number, claim_open_date, claim_close_date,
   claim_reopen_date, catastrophe_identifier)
SELECT claim_identifier, company_claim_number, claim_open_date, claim_close_date,
       claim_reopen_date, catastrophe_identifier
FROM tmp_claim
ON CONFLICT DO NOTHING;

-- ============================================================
-- policy_amount
-- CSV cols (11): Policy_Amount_Identifier, Geographic_Location_Identifier, Policy_Identifier,
--                Effective_Date, Amount_Type_Code, Earning_Begin_Date, Earning_End_Date,
--                Policy_Coverage_Detail_Identifier, Policy_Amount, Insurable_Object_Identifier,
--                Insurance_Type_Code
-- DDL cols (6):  policy_amount_identifier, policy_coverage_detail_identifier,
--                policy_amount_type_code, policy_amount, earning_period_start, earning_period_end
-- ============================================================
CREATE TEMP TABLE tmp_pa (
  policy_amount_identifier            int,
  geographic_location_identifier      int,
  policy_identifier                   int,
  effective_date                      timestamp,
  amount_type_code                    varchar(10),
  earning_begin_date                  timestamp,
  earning_end_date                    timestamp,
  policy_coverage_detail_identifier   bigint,
  policy_amount                       numeric(15,2),
  insurable_object_identifier         int,
  insurance_type_code                 varchar
);
\copy tmp_pa FROM '$CSV_DIR/Policy_Amount.csv' CSV HEADER
INSERT INTO acme_insurance.policy_amount
  (policy_amount_identifier, policy_coverage_detail_identifier, policy_amount_type_code,
   policy_amount, earning_period_start, earning_period_end)
SELECT policy_amount_identifier, policy_coverage_detail_identifier, amount_type_code,
       policy_amount, earning_begin_date, earning_end_date
FROM tmp_pa
ON CONFLICT DO NOTHING;

-- ============================================================
-- premium — CSV has 1 col matching the DDL directly
-- ============================================================
\copy acme_insurance.premium (policy_amount_identifier) FROM '$CSV_DIR/Premium.csv' CSV HEADER

-- ============================================================
-- claim_coverage
-- CSV cols (3): Claim_Identifier, Effective_Date, Policy_Coverage_Detail_Identifier
-- DDL cols (2): claim_identifier, policy_coverage_detail_identifier
-- ============================================================
CREATE TEMP TABLE tmp_cc (
  claim_identifier                    int,
  effective_date                      timestamp,
  policy_coverage_detail_identifier   bigint
);
\copy tmp_cc FROM '$CSV_DIR/Claim_Coverage.csv' CSV HEADER
INSERT INTO acme_insurance.claim_coverage (claim_identifier, policy_coverage_detail_identifier)
SELECT claim_identifier, policy_coverage_detail_identifier FROM tmp_cc
ON CONFLICT DO NOTHING;

-- ============================================================
-- claim_amount
-- CSV cols (7): Claim_Amount_Identifier, Claim_Identifier, Claim_Offer_Identifier,
--               Amount_Type_Code, Event_Date, Claim_Amount, Insurance_Type_Code
-- DDL cols (5): claim_amount_identifier, claim_identifier, claim_amount_type_code,
--               event_date, claim_amount
-- ============================================================
CREATE TEMP TABLE tmp_ca (
  claim_amount_identifier   int,
  claim_identifier          int,
  claim_offer_identifier    int,
  amount_type_code          varchar(10),
  event_date                timestamp,
  claim_amount              numeric(15,2),
  insurance_type_code       varchar
);
\copy tmp_ca FROM '$CSV_DIR/Claim_Amount.csv' CSV HEADER
INSERT INTO acme_insurance.claim_amount
  (claim_amount_identifier, claim_identifier, claim_amount_type_code, event_date, claim_amount)
SELECT claim_amount_identifier, claim_identifier, amount_type_code, event_date, claim_amount
FROM tmp_ca
ON CONFLICT DO NOTHING;

-- ============================================================
-- loss_payment, loss_reserve, expense_payment, expense_reserve
-- All have a single column matching the DDL directly
-- ============================================================
\copy acme_insurance.loss_payment    (claim_amount_identifier) FROM '$CSV_DIR/Loss_Payment.csv'    CSV HEADER
\copy acme_insurance.loss_reserve    (claim_amount_identifier) FROM '$CSV_DIR/Loss_Reserve.csv'    CSV HEADER
\copy acme_insurance.expense_payment (claim_amount_identifier) FROM '$CSV_DIR/Expense_Payment.csv' CSV HEADER
\copy acme_insurance.expense_reserve (claim_amount_identifier) FROM '$CSV_DIR/Expense_Reserve.csv' CSV HEADER

-- ============================================================
-- Verify row counts
-- ============================================================
SELECT relname AS table, n_live_tup AS rows
FROM pg_stat_user_tables
WHERE schemaname = 'acme_insurance'
ORDER BY relname;
SQL

echo "=== ACME Insurance data load ==="
echo ""
$PSQL -f "$TMPFILE"
echo ""
echo "Done."

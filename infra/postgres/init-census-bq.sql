-- ============================================================
-- census_bq schema — DDL mirror for Ontop VKG schema introspection
--
-- This schema is a structure-only replica of the BigQuery public tables
-- used by the economic-census domain. It contains NO data. Its sole
-- purpose is to allow Ontop to introspect column types and names at
-- startup so that it can translate SPARQL queries to SQL.
--
-- The OntopVkgService generates SQL referencing these tables; a
-- post-processing step in the service rewrites the local table
-- references to BigQuery-qualified names via ontop-table-map.properties.
--
-- BigQuery source tables:
--   bigquery-public-data.census_bureau_acs.county_2021_1yr
--   bigquery-public-data.census_bureau_acs.county_2020_5yr
--   bigquery-public-data.census_bureau_acs.state_2021_1yr
--   bigquery-public-data.census_opportunity_atlas.tract_outcomes
--   bigquery-public-data.census_opportunity_atlas.tract_covariates
--   bigquery-public-data.bls_qcew.2019_q2
-- ============================================================

CREATE SCHEMA IF NOT EXISTS census_bq;

SET search_path TO census_bq;

-- ------------------------------------------------------------
-- acs_county_1yr
-- ACS 1-year county estimates, 2021. ~820 US counties (pop ≥65k).
-- Key columns only (keyColumns from bigquery-bindings.yaml).
-- Join key: RIGHT(geo_id, 5) → 5-digit county FIPS.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acs_county_1yr (
    geo_id                                   VARCHAR(30),
    total_pop                                FLOAT,
    median_income                            FLOAT,
    income_per_capita                        FLOAT,
    poverty                                  FLOAT,
    unemployed_pop                           FLOAT,
    gini_index                               FLOAT,
    percent_income_spent_on_rent             FLOAT,
    median_rent                              FLOAT,
    owner_occupied_housing_units_median_value FLOAT,
    median_age                               FLOAT,
    white_pop                                FLOAT,
    black_pop                                FLOAT,
    hispanic_pop                             FLOAT,
    asian_pop                                FLOAT,
    bachelors_degree_or_higher_25_64         FLOAT,
    less_than_high_school_graduate           FLOAT,
    employed_manufacturing                   FLOAT,
    employed_education_health_social         FLOAT,
    commuters_by_public_transportation       FLOAT,
    worked_at_home                           FLOAT
);

-- ------------------------------------------------------------
-- acs_county_5yr
-- ACS 5-year county estimates, 2016-2020. All 3,200+ US counties.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acs_county_5yr (
    geo_id          VARCHAR(30),
    total_pop       FLOAT,
    median_income   FLOAT,
    poverty         FLOAT,
    gini_index      FLOAT,
    median_rent     FLOAT,
    unemployed_pop  FLOAT
);

-- ------------------------------------------------------------
-- acs_state_1yr
-- ACS 1-year state estimates, 2021. All 50 states + DC.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acs_state_1yr (
    geo_id                           VARCHAR(30),
    total_pop                        FLOAT,
    median_income                    FLOAT,
    gini_index                       FLOAT,
    poverty                          FLOAT,
    unemployed_pop                   FLOAT,
    bachelors_degree_or_higher_25_64 FLOAT
);

-- ------------------------------------------------------------
-- atlas_tract_outcomes
-- Opportunity Atlas tract-level outcomes (Chetty et al. 2018).
-- Join key: LPAD(CAST(state AS VARCHAR),2,'0') || LPAD(CAST(county AS VARCHAR),3,'0')
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atlas_tract_outcomes (
    state                     INTEGER,
    county                    INTEGER,
    tract                     INTEGER,
    kfr_pooled_pooled_p25     FLOAT,
    kfr_black_pooled_p25      FLOAT,
    kfr_white_pooled_p25      FLOAT,
    kfr_hisp_pooled_p25       FLOAT,
    jail_pooled_pooled_mean   FLOAT,
    jail_black_male_mean      FLOAT,
    married_pooled_female_mean FLOAT,
    working_pooled_pooled_mean FLOAT,
    teenbrth_pooled_female_mean FLOAT
);

-- ------------------------------------------------------------
-- atlas_tract_covariates
-- Opportunity Atlas tract-level structural covariates.
-- Join key: same as atlas_tract_outcomes (state + county + tract).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atlas_tract_covariates (
    state                        INTEGER,
    county                       INTEGER,
    tract                        INTEGER,
    czname                       VARCHAR(100),
    med_hhinc2016                INTEGER,
    poor_share2010               FLOAT,
    poor_share2000               FLOAT,
    frac_coll_plus2010           FLOAT,
    job_density_2013             FLOAT,
    jobs_highpay_5mi_2015        INTEGER,
    singleparent_share2010       FLOAT,
    share_black2010              FLOAT,
    gsmn_math_g3_2013            FLOAT,
    ann_avg_job_growth_2004_2013 FLOAT
);

-- ------------------------------------------------------------
-- bls_qcew_2019
-- BLS Quarterly Census of Employment and Wages, 2019 Q2.
-- Join key: geoid (already 5-digit county FIPS).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bls_qcew_2019 (
    geoid                                              VARCHAR(5),
    avg_wkly_wage_31_33_manufacturing                  FLOAT,
    month3_emplvl_31_33_manufacturing                  FLOAT,
    lq_month3_emplvl_31_33_manufacturing               FLOAT,
    avg_wkly_wage_62_health_care_and_social_assistance FLOAT,
    month3_emplvl_62_health_care_and_social_assistance FLOAT,
    lq_month3_emplvl_62_health_care_and_social_assistance FLOAT,
    avg_wkly_wage_52_finance_and_insurance             FLOAT,
    lq_month3_emplvl_52_finance_and_insurance          FLOAT,
    avg_wkly_wage_44_45_retail_trade                   FLOAT,
    month3_emplvl_44_45_retail_trade                   FLOAT
);

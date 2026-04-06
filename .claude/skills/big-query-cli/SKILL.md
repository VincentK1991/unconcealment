---
name: big-query-cli
description: use this skill when users want to query from Google big query
---

You have access to public Google BigQuery through bq
try
```
bq query 'SELECT geo_id, total_pop FROM `bigquery-public-data.census_bureau_acs.county_2020_5yr` LIMIT 5'
```

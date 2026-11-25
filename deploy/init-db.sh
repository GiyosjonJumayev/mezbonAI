#!/bin/sh
# Runs once, when the database is first created: the restricted account the app works with.
set -eu
psql -v ON_ERROR_STOP=1 -v pass="$DB_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE silkroad_app LOGIN PASSWORD :'pass';
REVOKE ALL ON DATABASE silkroad FROM PUBLIC;
GRANT CONNECT ON DATABASE silkroad TO silkroad_app;
SQL

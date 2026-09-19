---
layout: ../../../layouts/ArticleLayout.astro
title: "Practical PostgreSQL Administration: Passwords, Configuration, Primary/Standby Checks, Connections, Roles, and Databases"
description: "A practical PostgreSQL operations reference covering safer password changes, configuration file discovery, primary/standby checks, connection analysis, long sessions, role and database creation, and privilege pitfalls."
pubDate: "2026-09-19"
category: Databases
tags:
  - PostgreSQL
  - psql
  - Operations
  - Security
  - Troubleshooting
enPath: "/blog/postgresql-daily-operations-psql-admin/"
zhPath: "/zh/blog/postgresql-daily-operations-psql-admin/"
---

This note originally contained only a handful of commands:

```text
change the postgres password
find postgresql.conf
check primary or standby
count connections
create users and databases
```

They worked, but several details were easy to misunderstand.

For example:

```text
pg_is_in_recovery() = false
```

Why does that usually mean this node is the primary?

If:

```text
max_connections = 300
```

does that mean the application safely has 300 client connections available?

And does:

```sql
GRANT ALL PRIVILEGES ON DATABASE app_db TO app_user;
```

really grant access to every table in that database?

Not quite.

This is the version of the note I now find much more useful in day-to-day PostgreSQL work.

> Hostnames, database names, role names, and file paths in this article are generic examples.

## First: confirm where the session is connected

Before changing anything, I usually run:

```sql
SELECT
    current_database() AS database,
    current_user AS user,
    inet_server_addr() AS server_addr,
    inet_server_port() AS server_port,
    version();
```

For a local Unix socket connection, `inet_server_addr()` may be `NULL`. That is normal.

Inside `psql`:

```text
\conninfo
```

This small check is valuable when an environment has:

```text
primary
replica
VIP
service
connection pool
```

Confirm the target before running administrative commands.

## Change a PostgreSQL password

The direct SQL form is:

```sql
ALTER ROLE postgres WITH PASSWORD 'new_password';
```

`ALTER USER` also works because PostgreSQL users are roles with the `LOGIN` attribute.

For interactive administration, I prefer:

```bash
psql -U postgres
```

then:

```text
\password postgres
```

`psql` prompts for the new password without placing the cleartext value in command history or normal SQL logs.

Check how new passwords are stored:

```sql
SHOW password_encryption;
```

A modern installation will normally use:

```text
scram-sha-256
```

If an old system still uses MD5, verify client-driver compatibility and `pg_hba.conf` before migrating authentication settings.

Changing a password does not disconnect existing sessions. It affects future authentication.

## Find the configuration files PostgreSQL is actually using

Instead of guessing paths:

```sql
SHOW config_file;
SHOW hba_file;
SHOW ident_file;
SHOW data_directory;
```

These show:

```text
postgresql.conf
pg_hba.conf
pg_ident.conf
PGDATA
```

Container images, Linux packages, Patroni, and operators can all lay out these files differently. Asking the server is more reliable than assuming a standard path.

## Find where a particular setting came from

A running value may come from:

```text
postgresql.conf
included files
postgresql.auto.conf
ALTER SYSTEM
server command-line options
an upper-level management system
```

`pg_settings` is useful here:

```sql
SELECT
    name,
    setting,
    unit,
    source,
    sourcefile,
    sourceline,
    pending_restart
FROM pg_settings
WHERE name IN (
    'max_connections',
    'shared_buffers',
    'wal_level',
    'max_wal_size'
)
ORDER BY name;
```

`sourcefile` and `sourceline` can point directly to the configuration entry responsible for the current value.

To list parameters that have changed in configuration but still require a restart:

```sql
SELECT
    name,
    setting,
    sourcefile,
    sourceline
FROM pg_settings
WHERE pending_restart
ORDER BY name;
```

## Reload or restart?

Many settings can be reloaded without restarting PostgreSQL:

```sql
SELECT pg_reload_conf();
```

or:

```bash
pg_ctl reload
```

Other settings, including common examples such as `max_connections`, require a server restart.

Before reloading, configuration views can expose errors:

```sql
SELECT
    sourcefile,
    sourceline,
    name,
    setting,
    error
FROM pg_file_settings
WHERE error IS NOT NULL;
```

For `pg_hba.conf`:

```sql
SELECT *
FROM pg_hba_file_rules
WHERE error IS NOT NULL;
```

Then reload only after the configuration looks valid.

## Is this node primary or standby?

The simplest check is:

```sql
SELECT pg_is_in_recovery();
```

or:

```bash
psql -tXqAc "SELECT pg_is_in_recovery();"
```

A result of:

```text
f
```

means the instance is not in recovery. In a normal streaming-replication topology, that is the primary.

A result of:

```text
t
```

means the server is in recovery. In a typical HA cluster, that is a standby.

The more precise interpretation is therefore:

```text
false = not in recovery
true  = in recovery
```

rather than treating it as a dedicated "primary/standby" flag. A server performing point-in-time recovery is also in recovery.

On a standby, additional checks include:

```sql
SELECT
    pg_last_wal_receive_lsn(),
    pg_last_wal_replay_lsn(),
    pg_last_xact_replay_timestamp();
```

## Patroni adds another layer

In a Patroni-managed cluster I also check:

```bash
patronictl list
```

It shows information such as:

```text
leader
replica
timeline
lag
replica creation state
```

Normal SQL inspection and role management can still be done through PostgreSQL.

HA control operations such as failover, switchover, and replica reinitialization should follow Patroni's control path rather than bypassing it with ad-hoc PostgreSQL promotion commands.

## Count client connections

A simple:

```sql
SELECT count(*) FROM pg_stat_activity;
```

counts server processes represented by the view, which is not always identical to "application client connections".

On versions with `backend_type`, I prefer:

```sql
SELECT count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

By database:

```sql
SELECT
    datname,
    count(*) AS connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY datname
ORDER BY connections DESC;
```

By role:

```sql
SELECT
    usename,
    count(*) AS connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY usename
ORDER BY connections DESC;
```

By state:

```sql
SELECT
    state,
    count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY count(*) DESC;
```

Common states include:

```text
active
idle
idle in transaction
idle in transaction (aborted)
```

Long-lived `idle in transaction` sessions deserve attention because they can keep old row versions visible and interfere with vacuum cleanup.

## Find long idle transactions

```sql
SELECT
    pid,
    usename,
    datname,
    client_addr,
    xact_start,
    now() - xact_start AS xact_age,
    state,
    left(query, 120) AS query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;
```

Do not immediately terminate a session just because it is old.

First identify the application and determine whether terminating the transaction is safe.

## Find long-running SQL

For queries running longer than five minutes:

```sql
SELECT
    pid,
    usename,
    datname,
    client_addr,
    now() - query_start AS running_for,
    wait_event_type,
    wait_event,
    left(query, 200) AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND pid <> pg_backend_pid()
  AND query_start < now() - interval '5 minutes'
ORDER BY query_start;
```

`wait_event_type` and `wait_event` matter because a long-running statement might be waiting on:

```text
locks
I/O
clients
WAL
```

rather than actively consuming CPU.

## Check the connection limit

```sql
SHOW max_connections;
```

If the value is:

```text
300
```

do not assume all 300 slots are ordinary application capacity.

PostgreSQL reserves some connection capacity for administration and emergency access.

At minimum check:

```sql
SHOW superuser_reserved_connections;
```

Newer PostgreSQL releases can also have `reserved_connections`.

Large connection counts also increase PostgreSQL resource usage, so applications with high concurrency usually benefit from connection pooling rather than simply raising `max_connections`.

## Find who is using the connections

```sql
SELECT
    datname,
    usename,
    application_name,
    client_addr,
    state,
    count(*) AS connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY
    datname,
    usename,
    application_name,
    client_addr,
    state
ORDER BY connections DESC;
```

This usually identifies the database, role, application, client address, and state responsible for a connection spike.

## Cancel a query or terminate a session

To cancel only the current statement:

```sql
SELECT pg_cancel_backend(<pid>);
```

To disconnect the entire session:

```sql
SELECT pg_terminate_backend(<pid>);
```

I prefer:

```text
cancel first
terminate only when necessary
```

and I always re-check the PID immediately before acting. Backend PIDs can be reused.

## Create an application role and database

A common script is:

```sql
CREATE USER app_user WITH PASSWORD 'password';
CREATE DATABASE app_db;
GRANT ALL PRIVILEGES ON DATABASE app_db TO app_user;
```

It runs, but there are two problems.

The password is stored in cleartext in the script.

And `GRANT ALL PRIVILEGES ON DATABASE` grants database-level privileges. It does not automatically grant privileges on every schema, table, or sequence.

## For one application per database, make the application role the owner

A simple model is:

```sql
CREATE ROLE app_user LOGIN;
CREATE DATABASE app_db OWNER app_user;
```

Then set the password safely:

```text
\password app_user
```

The role already owns the database, so another:

```sql
GRANT ALL PRIVILEGES ON DATABASE app_db TO app_user;
```

is unnecessary.

From the shell:

```bash
createuser \
  -U postgres \
  --login \
  --pwprompt \
  app_user
```

then:

```bash
createdb \
  -U postgres \
  --owner=app_user \
  app_db
```

This avoids storing the password in the script.

## Verify the new role and database

In `psql`:

```text
\du+ app_user
```

or:

```sql
SELECT
    rolname,
    rolcanlogin,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolconnlimit
FROM pg_roles
WHERE rolname = 'app_user';
```

Check the database owner:

```sql
SELECT
    datname,
    pg_get_userbyid(datdba) AS owner
FROM pg_database
WHERE datname = 'app_db';
```

Finally, test a real login:

```bash
psql \
  -h postgresql-rw \
  -U app_user \
  -d app_db \
  -W \
  -c '\conninfo'
```

Creating the role and database does not prove that authentication, networking, and `pg_hba.conf` are correct. A real login test does.

## Separate owner and login roles when needed

Some environments use:

```text
app_owner   NOLOGIN
app_user    LOGIN
```

For example:

```sql
CREATE ROLE app_owner NOLOGIN;
CREATE ROLE app_user LOGIN;

GRANT app_owner TO app_user;

CREATE DATABASE app_db OWNER app_owner;
```

This is useful when ownership and application login need to be separated.

If the login role does not effectively inherit the owner privileges, manage database, schema, table, sequence, and default privileges explicitly.

## Database privileges are not table privileges

This:

```sql
GRANT ALL PRIVILEGES ON DATABASE app_db TO report_user;
```

does not mean the role can read every table.

A common read-only pattern is:

```sql
GRANT CONNECT ON DATABASE app_db TO report_user;
```

Inside `app_db`:

```sql
GRANT USAGE ON SCHEMA public TO report_user;

GRANT SELECT
ON ALL TABLES IN SCHEMA public
TO report_user;
```

For future tables:

```sql
ALTER DEFAULT PRIVILEGES
IN SCHEMA public
GRANT SELECT ON TABLES TO report_user;
```

One detail matters: default privileges are associated with the role that creates future objects. If tables are created by `app_owner`, configure the defaults in the context of that owner.

## PostgreSQL 15+ and the public schema

Older PostgreSQL environments often allowed application users to create objects in `public` with little explicit setup.

PostgreSQL 15 and newer changed the default ownership and privilege model around `public`, and upgraded databases may behave differently from newly initialized databases.

If an application reports:

```text
permission denied for schema public
```

do not only look at:

```text
GRANT ALL ON DATABASE
```

Check the database owner, schema owner, and `USAGE` / `CREATE` privileges.

For example:

```sql
SELECT
    nspname,
    nspowner::regrole AS owner
FROM pg_namespace
WHERE nspname = 'public';
```

## List databases and roles

Useful `psql` commands:

```text
\l+
\du+
```

SQL equivalents:

```sql
SELECT
    datname,
    pg_get_userbyid(datdba) AS owner
FROM pg_database
WHERE datallowconn
ORDER BY datname;
```

and:

```sql
SELECT
    rolname,
    rolcanlogin,
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolconnlimit
FROM pg_roles
ORDER BY rolname;
```

## A small operational checklist

Confirm the connection:

```sql
SELECT
    current_database(),
    current_user,
    inet_server_addr(),
    inet_server_port();
```

Check recovery state:

```sql
SELECT pg_is_in_recovery();
```

Find configuration:

```sql
SHOW config_file;
SHOW hba_file;
SHOW data_directory;
```

Summarize client connections:

```sql
SELECT
    datname,
    usename,
    state,
    count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY datname, usename, state
ORDER BY count(*) DESC;
```

Check connection limits:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
```

Find long transactions:

```sql
SELECT
    pid,
    usename,
    datname,
    now() - xact_start AS xact_age,
    state,
    left(query, 120)
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND pid <> pg_backend_pid()
ORDER BY xact_start;
```

Reload configuration when appropriate:

```sql
SELECT pg_reload_conf();
```

Change a password:

```text
\password app_user
```

Create a single-application database:

```sql
CREATE ROLE app_user LOGIN;
CREATE DATABASE app_db OWNER app_user;
```

That covers a large part of the PostgreSQL administration work I run into regularly.

## A few habits worth keeping

A command being valid does not make it the best operational choice.

For example:

```sql
ALTER USER postgres PASSWORD 'cleartext_password';
```

is valid SQL.

For interactive work:

```text
\password postgres
```

is usually safer.

Also, do not interpret:

```sql
GRANT ALL PRIVILEGES ON DATABASE
```

as "everything inside this database".

PostgreSQL privileges exist at different object levels:

```text
database
schema
table
sequence
function
```

And do not look at connection usage only as:

```text
22 / 300
```

Useful troubleshooting continues into:

```text
who connected
to which database
from where
in what state
how long the transaction has been open
```

Finally, when PostgreSQL is managed by Patroni or an operator, keep normal SQL administration separate from HA control-plane operations.

## References

- PostgreSQL — ALTER ROLE  
  https://www.postgresql.org/docs/current/sql-alterrole.html
- PostgreSQL — psql `\password`  
  https://www.postgresql.org/docs/current/app-psql.html
- PostgreSQL — Server configuration  
  https://www.postgresql.org/docs/current/config-setting.html
- PostgreSQL — `pg_settings`  
  https://www.postgresql.org/docs/current/view-pg-settings.html
- PostgreSQL — Statistics / `pg_stat_activity`  
  https://www.postgresql.org/docs/current/monitoring-stats.html
- PostgreSQL — Database roles  
  https://www.postgresql.org/docs/current/database-roles.html
- PostgreSQL — Schemas and privileges  
  https://www.postgresql.org/docs/current/ddl-schemas.html
- PostgreSQL — GRANT  
  https://www.postgresql.org/docs/current/sql-grant.html

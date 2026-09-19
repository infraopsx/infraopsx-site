---
layout: ../../../../layouts/ArticleLayout.astro
title: "PostgreSQL 日常运维常用命令：密码、配置、主备、连接数与用户管理"
description: "整理一套实际可用的 PostgreSQL 日常运维检查方法：安全修改密码、定位配置文件、判断主备角色、检查连接数与长事务、创建应用用户和数据库，以及修改配置后如何验证和 reload。"
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

这份记录最早只有几条命令：

```text
改 postgres 密码
找 postgresql.conf
看主备
看连接数
创建用户和数据库
```

当时用的时候能解决问题，但过一段时间再回头看，会发现很多细节其实没有说明白。

比如：

```text
pg_is_in_recovery() = false
```

为什么可以判断这是主库？

`max_connections = 300`，是不是就真的还能再连 300 个客户端？

还有：

```sql
GRANT ALL PRIVILEGES ON DATABASE appdb TO appuser;
```

是不是代表这个用户已经拥有库里所有表的权限？

答案都没有表面上那么简单。

所以把这些常用操作重新整理了一遍，顺便把几个容易误用的地方补上。

> 文中的主机名、数据库名、用户名和文件路径都是通用示例，不对应真实生产环境。

## 先确认自己连到了哪里

做数据库操作前，我现在习惯先跑这一条：

```sql
SELECT
    current_database() AS database,
    current_user AS user,
    inet_server_addr() AS server_addr,
    inet_server_port() AS server_port,
    version();
```

如果是本机 Unix Socket 连接：

```text
inet_server_addr()
```

可能返回 `NULL`，这是正常的。

在 `psql` 里还可以直接：

```text
\conninfo
```

这一步看起来很基础，但在有：

```text
Primary
Replica
VIP
Service
连接池
```

的环境里非常有用。

先确认自己连的是哪台，再执行后面的命令。

---

## 修改 PostgreSQL 用户密码

最直接的 SQL 是：

```sql
ALTER ROLE postgres WITH PASSWORD 'new_password';
```

或者：

```sql
ALTER USER postgres WITH PASSWORD 'new_password';
```

PostgreSQL 里的 `USER` 本质上就是带 `LOGIN` 属性的 Role，因此这两个写法都能修改密码。

不过在终端里，我更推荐：

```bash
psql -U postgres
```

进入 `psql` 后：

```text
\password postgres
```

它会交互式提示：

```text
Enter new password for user "postgres":
Enter it again:
```

这样比直接把：

```sql
ALTER ROLE postgres PASSWORD '明文密码';
```

写进 shell history、SQL 文件或者工单记录里更安全。

PostgreSQL 官方也专门建议使用 `psql` 的 `\password`，因为这样密码不会以明文出现在客户端历史或服务端 SQL 日志里。

### 看当前密码加密方式

```sql
SHOW password_encryption;
```

现代 PostgreSQL 一般应该看到：

```text
scram-sha-256
```

如果旧系统仍然使用 MD5，不要只改这一项就结束。

客户端驱动、`pg_hba.conf` 和已有用户密码是否兼容，都应该一起确认。

### 改完密码会不会踢掉现有连接

不会。

修改密码主要影响后续重新认证。

已经建立的数据库 Session 不会因为密码变更立即断开。

---

## 找 PostgreSQL 到底在读哪个配置文件

原来我只记了：

```bash
psql -c "SHOW config_file;"
```

这个非常有用：

```sql
SHOW config_file;
```

示例：

```text
              config_file
---------------------------------------
 /var/lib/postgresql/data/postgresql.conf
```

但是日常排查时，我一般会一次把几个位置都看出来：

```sql
SHOW config_file;
SHOW hba_file;
SHOW ident_file;
SHOW data_directory;
```

对应：

```text
postgresql.conf
pg_hba.conf
pg_ident.conf
PGDATA
```

不要假设配置一定在：

```text
/etc/postgresql/
```

或者：

```text
/var/lib/postgresql/data/
```

容器、RPM/DEB、Operator、Patroni、自定义镜像的路径都可能不同。

直接问 PostgreSQL 自己最可靠。

---

## 一个配置到底从哪里来的

复杂一点的环境里，只知道 `postgresql.conf` 路径还不够。

PostgreSQL 的配置可能来自：

```text
postgresql.conf
include 文件
postgresql.auto.conf
ALTER SYSTEM
启动参数
环境或上层管理工具
```

可以查：

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

这里几个字段非常实用：

```text
source
```

表示当前值来自哪里。

```text
sourcefile / sourceline
```

能告诉你是哪个配置文件的哪一行。

```text
pending_restart
```

表示配置文件里的值已经发生变化，但当前实例还需要 restart 才能真正生效。

例如只想找出“已经改了但没重启”的参数：

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

---

## 修改配置以后，reload 还是 restart

不是所有参数修改后都需要重启 PostgreSQL。

很多配置可以 reload：

```sql
SELECT pg_reload_conf();
```

成功一般返回：

```text
t
```

也可以在系统层执行：

```bash
pg_ctl reload
```

但有些参数只能在数据库启动时读取，例如：

```text
max_connections
shared_buffers
port
```

这类修改必须 restart。

所以不要形成：

```text
改配置
→ 无脑重启数据库
```

的习惯。

先看：

```sql
SELECT name, context, pending_restart
FROM pg_settings
WHERE name = 'max_connections';
```

### reload 前先看看配置有没有语法错误

可以先查：

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

检查 `pg_hba.conf`：

```sql
SELECT *
FROM pg_hba_file_rules
WHERE error IS NOT NULL;
```

没问题再：

```sql
SELECT pg_reload_conf();
```

这比改完直接 reload 更稳一点。

---

## 判断当前节点是 Primary 还是 Standby

最简单的命令：

```sql
SELECT pg_is_in_recovery();
```

或者 shell：

```bash
psql -tXqAc "SELECT pg_is_in_recovery();"
```

结果：

```text
f
```

通常表示：

```text
不在 recovery
→ 当前节点可以作为 Primary
```

结果：

```text
t
```

表示：

```text
当前实例正在 recovery
```

在 Streaming Replication 环境里，这通常就是 Standby。

所以原来的记法：

```text
f = 主
t = 备
```

在常见主备环境下是好用的，但更准确的说法应该是：

```text
false = 当前实例不处于 recovery
true  = 当前实例处于 recovery
```

因为 PITR 恢复阶段也会得到 `true`，它不是一个名字就叫“主备角色”的专用字段。

### Standby 上再看一下 replay

在备库执行：

```sql
SELECT
    pg_last_wal_receive_lsn(),
    pg_last_wal_replay_lsn(),
    pg_last_xact_replay_timestamp();
```

如果想知道最后一笔事务距离现在多久：

```sql
SELECT
    now() - pg_last_xact_replay_timestamp() AS replay_delay;
```

注意：数据库没有事务可 replay 时，这个时间差并不适合直接当成精确的复制延迟指标。

---

## Patroni 环境再多看一层

如果 PostgreSQL 由 Patroni 管理，我不会只看：

```sql
pg_is_in_recovery()
```

还会一起看：

```bash
patronictl list
```

因为 Patroni 还能告诉你：

```text
Leader
Replica
Timeline
Lag
Replica 创建状态
```

普通查询、用户管理、连接排查仍然可以用 PostgreSQL SQL。

但 failover、switchover、reinit 这类 HA 操作，应该按 Patroni 的管理方式做，不要绕过它直接在 PostgreSQL 层随便 promote。

---

## 查看连接数

原来的：

```sql
SELECT count(*) FROM pg_stat_activity;
```

能看一个总数，但它不完全等于“业务客户端连接数”。

`pg_stat_activity` 里除了客户端 Backend，还可能有其他 PostgreSQL 后台进程。

如果版本支持 `backend_type`，我更喜欢这样看：

```sql
SELECT count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

### 按数据库看

```sql
SELECT
    datname,
    count(*) AS connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY datname
ORDER BY connections DESC;
```

示例：

```text
   datname    | connections
--------------+------------
 app_db       |         18
 metrics_db   |          4
 postgres     |          2
```

### 按用户看

```sql
SELECT
    usename,
    count(*) AS connections
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY usename
ORDER BY connections DESC;
```

### 按连接状态看

```sql
SELECT
    state,
    count(*)
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY count(*) DESC;
```

常见状态：

```text
active
idle
idle in transaction
idle in transaction (aborted)
```

这里我最不喜欢看到长期存在的：

```text
idle in transaction
```

因为它代表客户端打开了事务，但一直没有 commit / rollback。

长时间这样放着，可能阻碍 Vacuum 清理旧版本。

---

## 找长期 idle in transaction 的 Session

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

如果某个事务已经挂了几个小时，就应该去找应用端为什么没有结束事务。

不要第一反应就 kill。

先确定：

```text
这个 Session 是谁的
正在做什么
业务是否允许终止
```

---

## 查长时间执行的 SQL

例如找执行超过 5 分钟的 SQL：

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

这里同时带上：

```text
wait_event_type
wait_event
```

是因为 SQL 跑得久，不一定真的是 CPU 算得慢。

它可能是在等：

```text
Lock
IO
Client
WAL
```

---

## 当前允许多少连接

```sql
SHOW max_connections;
```

例如：

```text
max_connections
---------------
300
```

这表示 PostgreSQL 配置允许的最大并发连接数量。

但不要把：

```text
当前 22
max_connections 300
```

简单理解成：

```text
还可以安全再来 278 个业务连接
```

因为 PostgreSQL 会预留一部分连接给管理和应急使用。

至少还要看：

```sql
SHOW superuser_reserved_connections;
```

新版本 PostgreSQL 还可能配置：

```text
reserved_connections
```

而且连接越多，也会增加数据库自身的资源开销。

所以高并发应用一般还是应该通过：

```text
PgBouncer
应用连接池
```

控制连接规模，而不是一味把 `max_connections` 往上加。

---

## 当前连接快打满时怎么看是谁占的

这条很实用：

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

通常很快就能看出：

```text
哪个库
哪个用户
哪个应用
哪台客户端
```

占了大量连接。

---

## Cancel SQL 和断开 Session 不是一回事

如果确认某个 SQL 需要停止，可以先：

```sql
SELECT pg_cancel_backend(<pid>);
```

它尝试取消当前 SQL，但保留数据库连接。

如果 Session 整个都需要断开：

```sql
SELECT pg_terminate_backend(<pid>);
```

这是更重的操作。

我一般遵循：

```text
能 cancel
就不要先 terminate
```

而且生产环境执行前一定先重新确认 PID。

PID 会复用，别拿几分钟前截图里的 PID 直接操作。

---

## 创建应用用户和数据库

原来的脚本大概是：

```sql
CREATE USER app_user WITH PASSWORD 'password';
CREATE DATABASE app_db;
GRANT ALL PRIVILEGES ON DATABASE app_db TO app_user;
```

它能执行，但有两个问题。

第一：

```text
密码直接写在脚本里
```

不适合进入 Git、Wiki 或部署仓库。

第二：

```sql
GRANT ALL PRIVILEGES ON DATABASE ...
```

只是在 **database 对象层面** 授权。

它不等于：

```text
这个用户自动拥有库里所有 schema、table、sequence
```

这是非常容易踩坑的地方。

---

## 单应用单数据库：直接让应用用户成为 Owner

如果这个数据库就是给一个应用独占使用，我更喜欢：

```sql
CREATE ROLE app_user LOGIN;
CREATE DATABASE app_db OWNER app_user;
```

然后安全设置密码：

```text
\password app_user
```

这样：

```text
app_user
```

本身就是：

```text
app_db
```

的 owner。

不需要再额外：

```sql
GRANT ALL PRIVILEGES ON DATABASE app_db TO app_user;
```

数据库 Owner 本来就拥有数据库对象的 owner 权限。

### shell 下也可以

先创建用户并交互输入密码：

```bash
createuser \
  -U postgres \
  --login \
  --pwprompt \
  app_user
```

再创建数据库：

```bash
createdb \
  -U postgres \
  --owner=app_user \
  app_db
```

这样密码不会直接写进脚本。

---

## 创建完以后验证一下

看 Role：

```text
\du+ app_user
```

或者：

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

看数据库 Owner：

```sql
SELECT
    datname,
    pg_get_userbyid(datdba) AS owner
FROM pg_database
WHERE datname = 'app_db';
```

应该看到：

```text
app_db | app_user
```

最后最好真的用应用用户连一次：

```bash
psql \
  -h postgresql-rw \
  -U app_user \
  -d app_db \
  -W \
  -c '\conninfo'
```

能创建用户和数据库，不代表认证、网络和 `pg_hba.conf` 都一定正确。

实际登录验证一次更踏实。

---

## 如果数据库和应用用户不是同一个 Owner

有些环境会把 Owner 和登录用户分开：

```text
app_owner   NOLOGIN
app_user    LOGIN
```

例如：

```sql
CREATE ROLE app_owner NOLOGIN;
CREATE ROLE app_user LOGIN;

GRANT app_owner TO app_user;

CREATE DATABASE app_db OWNER app_owner;
```

然后给 `app_user` 设置密码。

这种方式适合权限模型更严格的环境。

如果 `app_user` 不继承 owner 权限，那就需要明确管理：

```text
数据库 CONNECT
Schema USAGE / CREATE
表 SELECT / INSERT / UPDATE / DELETE
Sequence USAGE
默认权限
```

这时不能只靠一句：

```sql
GRANT ALL PRIVILEGES ON DATABASE ...
```

---

## 一个常见误区：数据库权限不等于表权限

例如：

```sql
GRANT ALL PRIVILEGES ON DATABASE app_db TO report_user;
```

数据库层面主要涉及：

```text
CONNECT
CREATE
TEMPORARY
```

它不会自动把现有表全部授权给 `report_user`。

只读用户常见会这样做：

```sql
GRANT CONNECT ON DATABASE app_db TO report_user;
```

进入 `app_db`：

```sql
GRANT USAGE ON SCHEMA public TO report_user;

GRANT SELECT
ON ALL TABLES IN SCHEMA public
TO report_user;
```

如果以后新建的表也要自动给它读：

```sql
ALTER DEFAULT PRIVILEGES
IN SCHEMA public
GRANT SELECT ON TABLES TO report_user;
```

这里还有一个关键点：

> `ALTER DEFAULT PRIVILEGES` 只影响以后创建的对象，而且它跟“谁创建对象”有关。

如果表是 `app_owner` 创建的，就应该以对应 owner 的默认权限规则来配置，而不是随便用另一个管理员 Session 执行一次就以为全局生效。

---

## PostgreSQL 15 以后，public schema 要特别注意

老系统里经常能看到应用用户一连上数据库，就直接在：

```text
public
```

schema 建表。

PostgreSQL 15 以后默认权限模型更收紧，`public` schema 的 ownership 和 `CREATE` 权限行为跟旧版本、升级库可能不同。

因此应用第一次启动时报：

```text
permission denied for schema public
```

不要只盯着：

```text
GRANT ALL ON DATABASE
```

应该直接看：

```text
数据库 owner 是谁
public schema owner 是谁
应用用户有没有 USAGE / CREATE
```

例如：

```sql
SELECT
    nspname,
    nspowner::regrole AS owner
FROM pg_namespace
WHERE nspname = 'public';
```

---

## 查看数据库和用户

`psql` 里最方便：

```text
\l+
\du+
```

SQL 版本：

```sql
SELECT
    datname,
    pg_get_userbyid(datdba) AS owner
FROM pg_database
WHERE datallowconn
ORDER BY datname;
```

角色：

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

---

## 一个我现在常用的快速检查清单

连上数据库以后：

```sql
SELECT
    current_database(),
    current_user,
    inet_server_addr(),
    inet_server_port();
```

确认主备：

```sql
SELECT pg_is_in_recovery();
```

配置位置：

```sql
SHOW config_file;
SHOW hba_file;
SHOW data_directory;
```

连接：

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

连接上限：

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
```

长事务：

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

需要 reload 时：

```sql
SELECT pg_reload_conf();
```

需要改密码时：

```text
\password app_user
```

创建独占应用库：

```sql
CREATE ROLE app_user LOGIN;
CREATE DATABASE app_db OWNER app_user;
```

这些基本能覆盖我平时最常碰到的一批 PostgreSQL 日常操作。

---

## 最后几个习惯

第一，看到命令能跑，不代表它就是更好的做法。

例如：

```sql
ALTER USER postgres PASSWORD '明文密码';
```

是合法的。

但交互式：

```text
\password postgres
```

通常更适合人工运维。

第二：

```sql
GRANT ALL PRIVILEGES ON DATABASE
```

不要理解成“整个数据库里面什么权限都有”。

PostgreSQL 的权限是分对象层级的：

```text
database
schema
table
sequence
function
```

第三，连接数不要只看：

```text
22 / 300
```

真正排查连接问题，应该继续看到：

```text
谁连的
连哪个库
来自哪里
当前什么 state
事务开了多久
```

第四，如果环境由 Patroni、Operator 之类的上层系统管理，要分清：

```text
哪些是普通 PostgreSQL SQL 操作
哪些是 HA 控制面的操作
```

普通 SQL 可以直接查。

主备切换、重建、副本管理不要绕开控制面。

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
